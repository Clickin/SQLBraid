import assert from "node:assert/strict";
import { Connection, ISOLATION_LEVEL } from "tedious";
import { inject, test } from "vitest";
import { DatabaseResultKindError } from "@sqlbraid/runtime";
import { generateModels } from "@sqlbraid/codegen";
import { createMssqlInspector } from "@sqlbraid/mssql/inspector";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";
import { mssqlParameter, sql, typePolicy } from "@sqlbraid/mssql";
import { runW01 } from "../w01.js";

interface MssqlSettings {
  readonly server: string;
  readonly port: number;
  readonly userName: string;
  readonly password: string;
  readonly database: string;
}

function connect(settings: MssqlSettings, connectionIsolationLevel = ISOLATION_LEVEL.READ_COMMITTED): Promise<Connection> {
  const connection = new Connection({
    server: settings.server,
    options: {
      port: settings.port,
      database: settings.database,
      encrypt: false,
      trustServerCertificate: true,
      rowCollectionOnRequestCompletion: false,
      rowCollectionOnDone: false,
      connectionIsolationLevel,
    },
    authentication: {
      type: "default",
      options: { userName: settings.userName, password: settings.password },
    },
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

test("SQL Server wrappers sharing one Tedious connection preserve transaction isolation", async () => {
  const settings = inject("mssql") as MssqlSettings;
  const connection = await connect(settings);
  const observer = await connect(settings);
  try {
    const db = createTediousDatabase(connection);
    const secondaryDb = createTediousDatabase(connection);
    await runW01({
      db,
      secondaryDb,
      sql,
      rows: async () => (await createTediousDatabase(observer).all(sql.rows<{ readonly id: string }>`SELECT id FROM dbo.braid_w01 ORDER BY id`)).map((row) => row.id),
      clear: async () => { await createTediousDatabase(observer).execute(sql`DELETE FROM dbo.braid_w01`); },
    });
  } finally {
    await close(observer);
    await close(connection);
  }
});

test("SQL Server binds explicit types, reports kinds, and preserves result-set boundaries", async () => {
  const settings = inject("mssql") as MssqlSettings;
  const connection = await connect(settings);
  try {
    const db = createTediousDatabase(connection);
    await db.execute(sql`DROP TABLE IF EXISTS dbo.braid_pv13`);
    await db.execute(sql`CREATE TABLE dbo.braid_pv13 (id int NOT NULL PRIMARY KEY, amount decimal(19,4) NULL, label nvarchar(100) NULL, payload varbinary(16) NULL)`);
    await db.execute(sql`INSERT INTO dbo.braid_pv13 (id, amount, label, payload) VALUES (${1}, ${sql.bind("12.3400", mssqlParameter.decimal(19, 4))}, ${sql.bind("Ada", mssqlParameter.nvarchar(100))}, ${sql.bind(new Uint8Array([1, 2]), mssqlParameter.varbinary(16))})`);

    const selected = await db.all(sql.rows<{ readonly id: number; readonly amount: number; readonly label: string; readonly payload: Uint8Array }>`
      SELECT id, amount, label, payload FROM dbo.braid_pv13
      WHERE amount = ${sql.bind("12.3400", mssqlParameter.decimal(19, 4))}
        AND id = ${sql.bind(1, mssqlParameter.int())}
    `);
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.id, 1);
    assert.equal(selected[0]?.amount, 12.34);
    assert.equal(selected[0]?.label, "Ada");
    assert.deepEqual([...selected[0]!.payload], [1, 2]);

    const command = await db.execute(sql.command`UPDATE dbo.braid_pv13 SET label = ${sql.bind(null, mssqlParameter.nvarchar(100))} WHERE id = ${1}`);
    assert.equal(command.kind, "command");
    assert.equal(command.command.affectedRows, 1);
    await assert.rejects(
      () => db.execute(sql.command`SELECT id FROM dbo.braid_pv13`),
      (error) => error instanceof DatabaseResultKindError && error.actualKind === "rows",
    );
    await assert.rejects(
      () => db.execute(sql`SELECT ${sql.bind("1234567890123456", mssqlParameter.decimal(38, 4))}`),
      /BRAID_BIND_DECIMAL_EXACTNESS/u,
    );
    await assert.rejects(() => db.execute(sql`SELECT ${null}`), /BRAID_BIND_TYPE_REQUIRED/u);
    await assert.rejects(
      () => db.execute(sql.rows`SELECT 1 AS duplicate, 2 AS duplicate`),
      /BRAID_RESULT_COLUMNS/u,
    );

    const call = await db.call(sql.call`SELECT 1 AS first; SELECT 2 AS second`);
    assert.equal(call.resultSets.length, 2);
    assert.deepEqual(call.resultSets.map((set) => set.rows), [[{ first: 1 }], [{ second: 2 }]]);
  } finally {
    await createTediousDatabase(connection).execute(sql`DROP TABLE IF EXISTS dbo.braid_pv13`).catch(() => undefined);
    await close(connection);
  }
});

test("SQL Server transaction entry preserves the actual session isolation level", async () => {
  const connection = await connect(inject("mssql") as MssqlSettings, ISOLATION_LEVEL.REPEATABLE_READ);
  try {
    const db = createTediousDatabase(connection);
    const isolation = sql.rows<{ readonly level: number }>`
      SELECT transaction_isolation_level AS level FROM sys.dm_exec_sessions WHERE session_id = @@SPID
    `;
    assert.equal((await db.one(isolation)).level, 3);
    await db.tx(async (tx) => {
      assert.equal((await tx.one(isolation)).level, 3);
      await tx.tx(async (nested) => { assert.equal((await nested.one(isolation)).level, 3); });
    });
    assert.equal((await db.one(isolation)).level, 3);
  } finally {
    await close(connection);
  }
});

test("SQL Server row-event streaming supports early break and abort", async () => {
  const settings = inject("mssql") as MssqlSettings;
  const connection = await connect(settings);
  try {
    const db = createTediousDatabase(connection, { maxBufferedRows: 8 });
    const stream = db.stream(sql.rows<{ readonly n: number }>`
      WITH numbers AS (
        SELECT TOP (100) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS int) AS n
        FROM sys.all_objects a CROSS JOIN sys.all_objects b
      )
      SELECT n FROM numbers ORDER BY n
    `);
    let seen = 0;
    for await (const row of stream) {
      assert.equal(row.n, 1);
      seen += 1;
      break;
    }
    assert.equal(seen, 1);
    assert.equal((await db.one(sql.rows<{ readonly n: number }>`SELECT 7 AS n`)).n, 7);

    const controller = new AbortController();
    const live = db.stream(sql.rows<{ readonly n: number }>`
      SELECT TOP (100) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS int) AS n
      FROM sys.all_objects a CROSS JOIN sys.all_objects b
    `, { signal: controller.signal })[Symbol.asyncIterator]();
    assert.equal((await live.next()).value?.n, 1);
    controller.abort(new Error("live stop"));
    await assert.rejects(() => live.next(), /live stop/u);
    assert.equal((await db.one(sql.rows<{ readonly n: number }>`SELECT 8 AS n`)).n, 8);

    const preAborted = new AbortController();
    preAborted.abort(new Error("stop"));
    const aborted = db.stream(sql.rows`SELECT 1 AS n`, { signal: preAborted.signal });
    await assert.rejects(async () => { for await (const _row of aborted) { /* pre-aborted */ } }, /stop/u);
  } finally {
    await close(connection);
  }
});

test("SQL Server inspector captures conservative catalogs for codegen", async () => {
  const settings = inject("mssql") as MssqlSettings;
  const connection = await connect(settings);
  try {
    const db = createTediousDatabase(connection);
    await db.execute(sql`DROP TABLE IF EXISTS dbo.braid_pv13_codegen`);
    await db.execute(sql`DROP PROCEDURE IF EXISTS dbo.braid_pv13_proc`);
    await db.execute(sql`DROP FUNCTION IF EXISTS dbo.braid_pv13_tvf`);
    await db.execute(sql`DROP TYPE IF EXISTS dbo.braid_pv13_alias`);
    await db.execute(sql`CREATE TYPE dbo.braid_pv13_alias FROM int NOT NULL`);
    await db.execute(sql`CREATE TABLE dbo.braid_pv13_codegen (external_id int NOT NULL PRIMARY KEY, alias_id dbo.braid_pv13_alias, identity_value bigint IDENTITY(1,1) NOT NULL, amount decimal(12,2) NOT NULL DEFAULT 0, label nvarchar(100) NOT NULL, computed AS (external_id + 1))`);
    await db.execute(sql`CREATE PROCEDURE dbo.braid_pv13_proc @value int AS SELECT @value AS value`);
    await db.execute(sql`CREATE FUNCTION dbo.braid_pv13_tvf(@minimum int) RETURNS TABLE AS RETURN (SELECT alias_id FROM dbo.braid_pv13_codegen WHERE external_id >= @minimum)`);

    const snapshot = await createMssqlInspector(connection).inspect();
    const relation = snapshot.relations["dbo.braid_pv13_codegen"];
    assert.ok(relation);
    const columns = new Map(relation.columns.map((column) => [column.name, column]));
    assert.equal(columns.get("external_id")?.type, "int");
    assert.equal(columns.get("external_id")?.identity, undefined);
    assert.equal(columns.get("identity_value")?.identity, true);
    assert.equal(columns.get("amount")?.type, "decimal");
    assert.equal(columns.get("computed")?.generated, true);
    assert.equal(columns.get("computed")?.insertable, false);
    const routine = Object.values(snapshot.routines).flat().find((entry) => entry.name === "braid_pv13_proc");
    assert.equal(routine?.argumentsComplete, true);
    assert.equal(routine?.arguments[0]?.type, "int");
    const tvf = Object.values(snapshot.routines).flat().find((entry) => entry.name === "braid_pv13_tvf");
    assert.equal(tvf?.result.kind, "table");
    assert.equal(tvf?.result.kind === "table" ? tvf.result.columns?.[0]?.name : undefined, "alias_id");
    assert.equal(tvf?.result.kind === "table" ? tvf.result.columns?.[0]?.type : undefined, "dbo.braid_pv13_alias");
    assert.equal(snapshot.types["dbo.braid_pv13_alias"]?.identity, "dbo.braid_pv13_alias");
    const generated = generateModels(snapshot, { typePolicy });
    assert.equal(generated.typePolicyId, typePolicy.id);
    assert.equal(generated.models.some((model) => model.relationIdentity === relation.identity), true);
  } finally {
    await createTediousDatabase(connection).execute(sql`DROP FUNCTION IF EXISTS dbo.braid_pv13_tvf`).catch(() => undefined);
    await createTediousDatabase(connection).execute(sql`DROP PROCEDURE IF EXISTS dbo.braid_pv13_proc`).catch(() => undefined);
    await createTediousDatabase(connection).execute(sql`DROP TABLE IF EXISTS dbo.braid_pv13_codegen`).catch(() => undefined);
    await createTediousDatabase(connection).execute(sql`DROP TYPE IF EXISTS dbo.braid_pv13_alias`).catch(() => undefined);
    await close(connection);
  }
});
