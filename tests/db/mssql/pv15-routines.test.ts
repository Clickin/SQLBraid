import assert from "node:assert/strict";
import { Connection, ISOLATION_LEVEL } from "tedious";
import { inject, test } from "vitest";
import { createTediousDatabase, createTediousExecutor } from "@sqlbraid/mssql/tedious";
import { mssqlParameter, sql } from "@sqlbraid/mssql";
import { runStreamingConformance } from "../../streaming-conformance.js";

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

test("SQL Server routine fixture exposes OUTPUT, RETURN status, and heterogeneous SELECT sets", { timeout: 30_000 }, async () => {
  const settings = inject("mssql") as MssqlSettings;
  const connection = await connect(settings);
  try {
    const db = createTediousDatabase(connection);
    await db.execute(sql`DROP PROCEDURE IF EXISTS dbo.braid_pv15_routine`);
    await db.execute(sql`CREATE PROCEDURE dbo.braid_pv15_routine @answer int OUTPUT, @minimum int AS BEGIN SET NOCOUNT ON; SET @answer = @minimum + 41; SELECT @minimum AS USER_ID; SELECT CONCAT('payment-', @minimum) AS PAYMENT_ID; RETURN 17; END`);
    const query = sql.call({ procedure: { name: "dbo.braid_pv15_routine", parameterNames: ["answer", "minimum"] } })`${sql.out("answer", mssqlParameter.int())}, ${1}`;
    const result = await db.call(query);
    assert.deepEqual(result.output, { answer: "42" });
    assert.equal(result.returnValue, 17);
    assert.deepEqual(result.resultSets.map((set) => set.rows), [[{ USER_ID: "1" }], [{ PAYMENT_ID: "payment-1" }]]);
    assert.equal(result.resultSets.some((set) => "source" in set), false);
  } finally {
    await createTediousDatabase(connection).execute(sql`DROP PROCEDURE IF EXISTS dbo.braid_pv15_routine`).catch(() => undefined);
    await close(connection);
  }
});

test("SQL Server rejects CURSOR VARYING output before sending a request", { timeout: 30_000 }, async () => {
  const settings = inject("mssql") as MssqlSettings;
  const connection = await connect(settings);
  try {
    const executor = createTediousExecutor(connection);
    const query = sql.call({ procedure: { name: "dbo.braid_pv15_cursor", parameterNames: ["cursor"] } })`${sql.out("cursor", { databaseType: "cursor" })}`;
    await assert.rejects(() => executor.call(query.render()), /BRAID_CALL_CURSOR_UNSUPPORTED/u);
  } finally {
    await close(connection);
  }
});

test("SQL Server real streaming satisfies the shared streaming lifecycle contract", { timeout: 120_000 }, async () => {
  const settings = inject("mssql") as MssqlSettings;
  let runs = 0;
  const expected = [{ VALUE: "1" }, { VALUE: "2" }, { VALUE: "3" }] as const;
  const query = sql.rows<typeof expected[number]>`
    SELECT VALUE
    FROM (VALUES (1), (2), (3)) AS values_table(VALUE)
    ORDER BY VALUE
  `;
  const mappingQuery = sql.rows({
    "~standard": {
      version: 1,
      vendor: "sqlbraid-pv15",
      validate() {
        throw new Error("query-bound mapper failed");
      },
    },
  })`
    SELECT VALUE
    FROM (VALUES (1), (2), (3)) AS values_table(VALUE)
    ORDER BY VALUE
  `;
  await runStreamingConformance(async () => {
    runs += 1;
    const connection = await connect(settings);
    return {
      db: createTediousDatabase(connection, { maxBufferedRows: 2 }),
      query,
      expected,
      mappingQuery,
      close: () => close(connection),
    };
  }, { abortError: new Error("SQL Server real stream aborted") });
  assert.equal(runs, 8);
});

test("SQL Server transaction streams retain their pinned session until cleanup", { timeout: 30_000 }, async () => {
  const settings = inject("mssql") as MssqlSettings;
  const connection = await connect(settings);
  try {
    const db = createTediousDatabase(connection);
    const query = sql.rows<{ readonly VALUE: string }>`
      SELECT VALUE
      FROM (VALUES (1), (2)) AS values_table(VALUE)
      ORDER BY VALUE
    `;
    await db.tx(async (tx) => {
      const iterator = tx.stream(query)[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.VALUE, "1");
      await assert.rejects(
        () => tx.one(sql.rows<{ readonly VALUE: string }>`SELECT 7 AS VALUE`),
        { code: "BRAID_STREAM_SCOPE" },
      );
      await iterator.return?.();
      assert.equal((await tx.one(sql.rows<{ readonly VALUE: string }>`SELECT 7 AS VALUE`)).VALUE, "7");
    });
  } finally {
    await close(connection);
  }
});
