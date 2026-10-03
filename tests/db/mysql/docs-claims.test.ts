// Proves the runtime claims of the documentation on a real MySQL server with mysql2.
import assert from "node:assert/strict";
import { createConnection, createPool, type Connection } from "mysql2/promise";
import { inject } from "vitest";
import { mssqlParameter } from "@sqlbraid/mssql";
import { createMysql2Database, createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { MYSQL2_LOSSLESS_TEXT, sql } from "@sqlbraid/mysql";
import type { Database } from "@sqlbraid/core";
import { assertCode, bulkModeObserver, docsClaim, errorCode } from "../docs-claims.js";

const options = () => ({ uri: inject("mysql").connectionUri, ...MYSQL2_LOSSLESS_TEXT.connectionOptions });
const GS = "getting-started/mysql.md";

async function withDb(
  fn: (db: Database, connection: Connection) => Promise<void>,
  extra: Parameters<typeof createMysql2Database>[1] = {},
): Promise<void> {
  const connection = await createConnection(options());
  try {
    await fn(createMysql2Database(connection, { profile: MYSQL2_LOSSLESS_TEXT, ...extra }), connection);
  } finally {
    await connection.end();
  }
}

docsClaim(GS, "MYSQL2_LOSSLESS_TEXT sets the options in the documented table", async () => {
  assert.deepEqual(MYSQL2_LOSSLESS_TEXT.connectionOptions, {
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    rowsAsArray: false,
    jsonStrings: true,
    dateStrings: true,
  });
});

docsClaim(GS, "the lossless profile returns exact strings, numbers for floats and text for JSON and dates", () =>
  withDb(async (db) => {
    const row = await db.one(sql.rows<Record<string, unknown>>`
      SELECT CAST(9223372036854775807 AS SIGNED) AS big, CAST(1.10 AS DECIMAL(10,2)) AS dec1,
        CAST(1.5 AS DOUBLE) AS dbl, CAST(2.5 AS FLOAT) AS flt, JSON_OBJECT('a', 1) AS j,
        CAST('2026-09-14 12:34:56.123456' AS DATETIME(6)) AS dt`);
    assert.equal(row.big, "9223372036854775807");
    assert.equal(row.dec1, "1.10");
    assert.equal(typeof row.dbl, "number");
    assert.equal(typeof row.flt, "number");
    assert.equal(typeof row.j, "string");
    assert.equal(row.dt, "2026-09-14 12:34:56.123456");
  }),
);

docsClaim(GS, "insertId is an exact string in command metadata", () =>
  withDb(async (db) => {
    await db.execute(sql.command`CREATE TEMPORARY TABLE docs_users (id BIGINT AUTO_INCREMENT PRIMARY KEY, name TEXT)`);
    const result = await db.execute(sql.command`INSERT INTO docs_users (name) VALUES ('Ada')`);
    assert.equal(result.kind, "command");
    assert.equal(typeof result.command?.insertId, "string");
  }),
);

docsClaim(GS, "emitted CALL result sets are supported and prepared CALL OUT is rejected", () =>
  withDb(async (db, connection) => {
    await connection.query("DROP PROCEDURE IF EXISTS docs_dashboard");
    await connection.query("DROP PROCEDURE IF EXISTS docs_out");
    await connection.query("CREATE PROCEDURE docs_dashboard() BEGIN SELECT 1 AS id; SELECT 2 AS total; END");
    await connection.query("CREATE PROCEDURE docs_out(OUT x INT) BEGIN SET x = 1; END");
    const result = await db.call(sql.call`CALL docs_dashboard()`);
    assert.equal(result.resultSets.length, 2);
    await assertCode(() => db.call(sql.call`CALL docs_out(${sql.out("x")})`), "BRAID_CALL_OUT_UNSUPPORTED");
  }),
);

docsClaim(GS, "createMysql2Database rejects a pool; createMysql2PoolDatabase accepts it", async () => {
  const pool = createPool(options());
  try {
    assert.notEqual(await errorCode(() => createMysql2Database(pool as never)), "no-error");
    const db = createMysql2PoolDatabase(pool, { profile: MYSQL2_LOSSLESS_TEXT });
    assert.deepEqual(await db.maybeOne(sql.rows`SELECT 1 AS x FROM DUAL WHERE ${1} = 1`), { x: "1" });
  } finally {
    await pool.end();
  }
});

docsClaim("concepts/parameter-hints.md", "MySQL rejects ordinary hints with BRAID_BIND_HINT_UNSUPPORTED", () =>
  withDb(async (db) =>
    assertCode(
      () => db.all(sql.rows`SELECT ${sql.bind("x", mssqlParameter.nvarchar(10))} AS x`),
      "BRAID_BIND_HINT_UNSUPPORTED",
    ),
  ),
);

docsClaim("runtime/streaming.md", "the mysql2 stream yields rows and an early break leaves the connection usable", () =>
  withDb(async (db) => {
    let count = 0;
    for await (const row of db.stream(sql.rows`SELECT 1 AS a UNION ALL SELECT 2 UNION ALL SELECT 3`)) {
      void row;
      count += 1;
      if (count === 1) break;
    }
    assert.equal(count, 1);
    assert.equal((await db.all(sql.rows`SELECT 1 AS x`)).length, 1);
  }),
);

docsClaim("concepts/bulk.md", "mysql2 bulk reports prepared-loop", async () => {
  const bulk = bulkModeObserver();
  await withDb(
    async (db) => {
      await db.execute(sql.command`CREATE TEMPORARY TABLE docs_bulk (name TEXT)`);
      await db.bulk(["a", "b"], (name) => sql.command`INSERT INTO docs_bulk (name) VALUES (${name})`);
      assert.equal(bulk.mode(), "prepared-loop");
    },
    { observers: [bulk.observer] },
  );
});
