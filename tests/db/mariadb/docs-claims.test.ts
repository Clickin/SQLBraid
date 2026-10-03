// Proves the runtime claims of the documentation on a real MariaDB server with Connector/Node.js.
import assert from "node:assert/strict";
import mariadb, { type Connection } from "mariadb";
import { inject } from "vitest";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";
import { MARIADB_LOSSLESS_TEXT, sql } from "@sqlbraid/mariadb";
import type { Database } from "@sqlbraid/core";
import { assertCode, bulkModeObserver, docsClaim, errorCode } from "../docs-claims.js";

const GS = "getting-started/mariadb.md";

async function withDb(
  fn: (db: Database, connection: Connection) => Promise<void>,
  extra: Parameters<typeof createMariaDbDatabase>[1] = {},
): Promise<void> {
  const uri = new URL(inject("mariadb").connectionUri);
  const connection = await mariadb.createConnection({
    host: uri.hostname,
    port: Number(uri.port || 3306),
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.slice(1)),
    ...MARIADB_LOSSLESS_TEXT.connectionOptions,
  });
  try {
    await fn(createMariaDbDatabase(connection, { profile: MARIADB_LOSSLESS_TEXT, ...extra }), connection);
  } finally {
    await connection.end();
  }
}

docsClaim(GS, "MARIADB_LOSSLESS_TEXT sets the documented connector options", async () => {
  assert.deepEqual(MARIADB_LOSSLESS_TEXT.connectionOptions, {
    bigIntAsNumber: false,
    decimalAsNumber: false,
    insertIdAsNumber: false,
    timezone: "Z",
    autoJsonMap: false,
    dateStrings: true,
  });
});

docsClaim(GS, "the lossless profile returns exact strings, numbers for floats and text for JSON and dates", () =>
  withDb(async (db) => {
    const row = await db.one(sql.rows<Record<string, unknown>>`
      SELECT CAST(9223372036854775807 AS SIGNED) AS big, CAST(1.10 AS DECIMAL(10,2)) AS d, JSON_OBJECT('a', 1) AS j,
        CAST('2026-09-14 12:34:56.123' AS DATETIME(3)) AS dt, CAST(1.5 AS DOUBLE) AS dbl`);
    assert.equal(row.big, "9223372036854775807");
    assert.equal(row.d, "1.10");
    assert.equal(typeof row.j, "string");
    assert.equal(typeof row.dt, "string");
    assert.equal(typeof row.dbl, "number");
  }),
);

docsClaim(GS, "INSERT, DELETE and REPLACE ... RETURNING work; UPDATE ... RETURNING is not available", () =>
  withDb(async (db) => {
    await db.execute(sql.command`CREATE TEMPORARY TABLE docs_users (id BIGINT AUTO_INCREMENT PRIMARY KEY, name TEXT)`);
    assert.equal((await db.all(sql.rows`INSERT INTO docs_users (name) VALUES ('Ada') RETURNING id, name`)).length, 1);
    assert.equal(
      (await db.all(sql.rows`REPLACE INTO docs_users (id, name) VALUES (1, 'Ada2') RETURNING id`)).length,
      1,
    );
    assert.equal((await db.all(sql.rows`DELETE FROM docs_users WHERE id = 1 RETURNING id`)).length, 1);
    assert.notEqual(await errorCode(() => db.all(sql.rows`UPDATE docs_users SET name = 'x' RETURNING id`)), "no-error");
  }),
);

docsClaim(GS, "emitted CALL result sets are supported and prepared CALL OUT is rejected", () =>
  withDb(async (db, connection) => {
    await connection.query("DROP PROCEDURE IF EXISTS docs_dash");
    await connection.query("DROP PROCEDURE IF EXISTS docs_out");
    await connection.query("CREATE PROCEDURE docs_dash() BEGIN SELECT 1 AS a; SELECT 'x' AS b; END");
    await connection.query("CREATE PROCEDURE docs_out(OUT x INT) BEGIN SET x = 1; END");
    assert.equal((await db.call(sql.call`CALL docs_dash()`)).resultSets.length, 2);
    await assertCode(() => db.call(sql.call`CALL docs_out(${sql.out("x")})`), "BRAID_CALL_OUT_UNSUPPORTED");
  }),
);

docsClaim("concepts/bulk.md", "MariaDB bulk reports native-bulk", async () => {
  const bulk = bulkModeObserver();
  await withDb(
    async (db) => {
      await db.execute(sql.command`CREATE TEMPORARY TABLE docs_bulk (name TEXT)`);
      await db.bulk(["a", "b"], (name) => sql.command`INSERT INTO docs_bulk (name) VALUES (${name})`);
      assert.equal(bulk.mode(), "native-bulk");
    },
    { observers: [bulk.observer] },
  );
});

docsClaim("runtime/streaming.md", "the MariaDB native stream yields all rows", () =>
  withDb(async (db) => {
    let count = 0;
    for await (const row of db.stream(sql.rows`SELECT 1 AS a UNION ALL SELECT 2`)) {
      void row;
      count += 1;
    }
    assert.equal(count, 2);
  }),
);
