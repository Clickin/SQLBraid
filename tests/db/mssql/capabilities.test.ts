import assert from "node:assert/strict";
import { Connection, ISOLATION_LEVEL } from "tedious";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExecutionEvent } from "@sqlbraid/core";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";
import { mssqlParameter, sql } from "@sqlbraid/mssql";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";

interface MssqlSettings {
  readonly server: string;
  readonly port: number;
  readonly userName: string;
  readonly password: string;
  readonly database: string;
}

function connect(settings: MssqlSettings): Promise<Connection> {
  const connection = new Connection({
    server: settings.server,
    options: {
      port: settings.port,
      database: settings.database,
      encrypt: false,
      trustServerCertificate: true,
      rowCollectionOnRequestCompletion: false,
      rowCollectionOnDone: false,
      connectionIsolationLevel: ISOLATION_LEVEL.READ_COMMITTED,
    },
    authentication: { type: "default", options: { userName: settings.userName, password: settings.password } },
  });
  return new Promise<Connection>((resolve, reject) => {
    connection.once("connect", (error) => error ? reject(error) : resolve(connection));
    connection.connect();
  });
}

async function close(connection: Connection): Promise<void> {
  await new Promise<void>((resolve) => {
    connection.once("end", resolve);
    connection.close();
    setTimeout(resolve, 500);
  });
}

test("SQL Server capability matrix preserves materialized OUTPUT and completion errors", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const events: ExecutionEvent[] = [];
  const db = createTediousDatabase(connection, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    await db.execute(sql`DROP TABLE IF EXISTS dbo.braid_pv16_capability`);
    await db.execute(sql`CREATE TABLE dbo.braid_pv16_capability (id int NOT NULL PRIMARY KEY, name nvarchar(100) NOT NULL, amount int NOT NULL)`);
    events.length = 0;
    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "mssql",
      expectedMode: "prepared-loop",
      events,
    });
    assert.equal(bulkReport.executionMode, "prepared-loop");
    assert.deepEqual(
      await db.bulk([{ id: 10, name: "Bulk-A", amount: 30 }, { id: 11, name: "Bulk-B", amount: 40 }], (input) =>
        sql.command`INSERT INTO dbo.braid_pv16_capability (id, name, amount) VALUES (${input.id}, ${input.name}, ${input.amount})`,
      ),
      { inputCount: 2, affectedRows: 2 },
    );

    const inserted = await db.all(sql.rows`
      INSERT INTO dbo.braid_pv16_capability (id, name, amount)
      OUTPUT INSERTED.id, INSERTED.name
      VALUES (${1}, ${sql.bind("Ada", mssqlParameter.nvarchar(100))}, ${10})
    `);
    assert.deepEqual(inserted, [{ id: 1, name: "Ada" }]);
    const updated = await db.all(sql.rows`
      UPDATE dbo.braid_pv16_capability
      SET name = ${sql.bind("Grace", mssqlParameter.nvarchar(100))}, amount = ${20}
      OUTPUT DELETED.amount AS old_amount, INSERTED.amount AS new_amount
      WHERE id = ${1}
    `);
    assert.deepEqual(updated, [{ old_amount: 10, new_amount: 20 }]);
    const deleted = await db.all(sql.rows`
      DELETE FROM dbo.braid_pv16_capability
      OUTPUT DELETED.id, DELETED.name
      WHERE id = ${1}
    `);
    assert.deepEqual(deleted, [{ id: 1, name: "Grace" }]);
    const schema: StandardSchemaV1<unknown, { readonly id: number }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        validate(value) {
          const row = value as { readonly id: number };
          return { value: { id: row.id + 10 } };
        },
      },
    };
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: number }>`SELECT ${2} AS id`, { schema }),
      [{ id: 12 }],
    );

    await db.execute(sql`INSERT INTO dbo.braid_pv16_capability (id, name, amount) VALUES (${2}, ${"Bob"}, ${30})`);
    const merged = await db.all(sql.rows`
      MERGE dbo.braid_pv16_capability AS target
      USING (VALUES (${2}, ${"Robert"}, ${31}), (${3}, ${"Cara"}, ${40})) AS source(id, name, amount)
      ON target.id = source.id
      WHEN MATCHED THEN UPDATE SET name = source.name, amount = source.amount
      WHEN NOT MATCHED THEN INSERT (id, name, amount) VALUES (source.id, source.name, source.amount)
      OUTPUT $action AS action, INSERTED.id AS inserted_id, DELETED.id AS deleted_id;
    `);
    assert.deepEqual(merged, [
      { action: "UPDATE", inserted_id: 2, deleted_id: 2 },
      { action: "INSERT", inserted_id: 3, deleted_id: null },
    ]);

    await assert.rejects(
      () => db.bulk([{ id: 2, name: "Duplicate", amount: 99 }, { id: 99, name: "Later", amount: 100 }], (input) =>
        sql.command`INSERT INTO dbo.braid_pv16_capability (id, name, amount) VALUES (${input.id}, ${input.name}, ${input.amount})`,
      ),
      /duplicate|primary key/iu,
    );
    assert.deepEqual(
      await db.all(sql.rows`SELECT id FROM dbo.braid_pv16_capability WHERE id = ${99}`),
      [],
    );
    assert.equal((await db.one(sql.rows<{ readonly count: number }>`SELECT COUNT(*) AS count FROM dbo.braid_pv16_capability`)).count, 4);

    await assert.rejects(
      () => db.execute(sql.rows`SELECT 1 AS duplicate, 2 AS duplicate`),
      /BRAID_RESULT_COLUMNS/u,
    );
    await assert.rejects(
      () => db.execute(sql.rows`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        INSERT INTO dbo.braid_pv16_capability (id, name, amount)
        OUTPUT INSERTED.id
        VALUES (${4}, ${"Dora"}, ${50});
        THROW 50000, 'late batch failure', 1;
      `),
    );
    assert.equal((await db.one(sql.rows<{ readonly count: number }>`SELECT COUNT(*) AS count FROM dbo.braid_pv16_capability`)).count, 4);
  } finally {
    await db.execute(sql`DROP TABLE IF EXISTS dbo.braid_pv16_capability`).catch(() => undefined);
    await close(connection);
  }
});
