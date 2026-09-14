import assert from "node:assert/strict";
import { Connection, ISOLATION_LEVEL } from "tedious";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { decodeExactDecimal, decodeExactInteger, type ExecutionEvent } from "@sqlbraid/core";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";
import { mssqlParameter, sql } from "@sqlbraid/mssql";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { runTransparencyCase } from "../../transparency.js";

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

test("mssql.sql.native-transparency", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const events: ExecutionEvent[] = [];
  const db = createTediousDatabase(connection, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    const query = sql.rows`
      SELECT N'literal @p1 ? :1 $1' AS [marker],
             JSON_VALUE(N'{"enabled":true}', '$.enabled') AS [enabled],
             CAST(${7} AS int) AS [actual]
    `;
    await runTransparencyCase({
      capabilityId: "mssql.sql.native-transparency",
      query: query.render(),
      expectedSegments: [
        "\n      SELECT N'literal @p1 ? :1 $1' AS [marker],\n             JSON_VALUE(N'{\"enabled\":true}', '$.enabled') AS [enabled],\n             CAST(",
        " AS int) AS [actual]\n    ",
      ],
      expectedParameterizedSql: "\n      SELECT N'literal @p1 ? :1 $1' AS [marker],\n             JSON_VALUE(N'{\"enabled\":true}', '$.enabled') AS [enabled],\n             CAST(@p1 AS int) AS [actual]\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [{ marker: "literal @p1 ? :1 $1", enabled: "true", actual: 7 }],
    });
  } finally {
    await close(connection);
  }
});

test("mssql.sql.generated-structure", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const query = sql.rows`SELECT ${sql.ident("value")} FROM (VALUES (${1})) AS source([value])`;
    assert.deepEqual(query.render().segments, ["SELECT [value] FROM (VALUES (", ")) AS source([value])"]);
    assert.deepEqual(await db.all(query), [{ value: 1 }]);
  } finally {
    await close(connection);
  }
});

test("mssql.numeric.exact-integer", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const row = await db.one(sql.rows<{
      readonly safe: bigint;
      readonly unsafe: bigint;
      readonly min: bigint;
      readonly max: bigint;
    }>`
      SELECT
        CAST('9007199254740991' AS bigint) AS safe,
        CAST('9007199254740992' AS bigint) AS unsafe,
        CAST('-9223372036854775808' AS bigint) AS min,
        CAST('9223372036854775807' AS bigint) AS max
    `);
    assert.equal(decodeExactInteger(row.safe), 9007199254740991n);
    assert.equal(decodeExactInteger(row.unsafe), 9007199254740992n);
    assert.equal(decodeExactInteger(row.min), -9223372036854775808n);
    assert.equal(decodeExactInteger(row.max), 9223372036854775807n);
  } finally {
    await close(connection);
  }
});

test("mssql.numeric.exact-decimal", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly native_value: number; readonly value: string }>`
      SELECT CAST('1234567890123456789012345678.1234567890' AS decimal(38, 10)) AS native_value,
             CONVERT(varchar(64), CAST('1234567890123456789012345678.1234567890' AS decimal(38, 10))) AS value
    `);
    // SQL Server's Tedious decimal path is approximate; explicit text SQL is the supported exact workaround.
    assert.equal(typeof row.native_value, "number");
    assert.throws(() => decodeExactDecimal(row.native_value), { code: "BRAID_RESULT_EXACTNESS" });
    assert.equal(decodeExactDecimal(row.value), "1234567890123456789012345678.1234567890");
  } finally {
    await close(connection);
  }
});

test("mssql.data.json-text", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly payload: string; readonly enabled: string }>`
      SELECT JSON_QUERY(N'{"enabled":true,"nested":{"count":2}}') AS payload,
             JSON_VALUE(N'{"enabled":true}', '$.enabled') AS enabled
    `);
    assert.equal(row.payload, '{"enabled":true,"nested":{"count":2}}');
    assert.equal(row.enabled, "true");
  } finally {
    await close(connection);
  }
});

test("mssql.data.temporal", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly value: Date }>`SELECT CAST('2026-09-14T12:34:56.0000000' AS datetime2) AS value`);
    assert.ok(row.value instanceof Date);
    assert.equal(row.value.toISOString(), "2026-09-14T12:34:56.000Z");
  } finally {
    await close(connection);
  }
});

test("mssql.data.binary", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly payload: Buffer }>`SELECT CONVERT(varbinary(3), 0x00FF10) AS payload`);
    assert.ok(Buffer.isBuffer(row.payload));
    assert.deepEqual([...row.payload], [0, 255, 16]);
  } finally {
    await close(connection);
  }
});

test("mssql.data.uuid", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly id: string }>`SELECT CAST('550e8400-e29b-41d4-a716-446655440000' AS uniqueidentifier) AS id`);
    assert.equal(row.id.toLowerCase(), "550e8400-e29b-41d4-a716-446655440000");
  } finally {
    await close(connection);
  }
});

test("mssql.dml.insert-returning", { timeout: 30_000 }, async () => {
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
