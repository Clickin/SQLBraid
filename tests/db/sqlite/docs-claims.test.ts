// Proves the runtime claims of the documentation on node:sqlite, libSQL and better-sqlite3.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { createClient } from "@libsql/client";
import { mssqlParameter } from "@sqlbraid/mssql";
import { createBetterSqlite3Database } from "@sqlbraid/sqlite/better-sqlite3";
import { createLibsqlDatabase } from "@sqlbraid/sqlite/libsql";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";
import { assertCode, bulkModeObserver, docsClaim, errorCode } from "../docs-claims.js";

const GS = "getting-started/sqlite.md";

docsClaim(GS, "the quickstart prints [{ id: '1', name: 'Ada' }]", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    const db = createNodeSqliteDatabase(native);
    await db.execute(sql.command`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    await db.execute(sql.command`INSERT INTO users (name) VALUES (${"Ada"})`);
    assert.deepEqual(await db.all(sql.rows`SELECT id, name FROM users WHERE id = ${1}`), [{ id: "1", name: "Ada" }]);
  } finally {
    native.close();
  }
});

docsClaim(GS, "node:sqlite: INTEGER is a string, REAL a number, BLOB bytes and JSON1 text", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    const db = createNodeSqliteDatabase(native);
    const row = await db.one(sql.rows<Record<string, unknown>>`
      SELECT 9223372036854775807 AS big, 1.5 AS real, 2.0 AS realint, x'0102' AS blob, json_object('a', 1) AS j`);
    assert.equal(row.big, "9223372036854775807");
    assert.equal(row.real, 1.5);
    assert.equal(row.realint, 2);
    assert.ok(row.blob instanceof Uint8Array);
    assert.equal(row.j, '{"a":1}');
  } finally {
    native.close();
  }
});

docsClaim(
  GS,
  "node:sqlite: calls are unsupported, hints are rejected, iterate() streams and bulk is prepared-loop",
  async () => {
    const native = new DatabaseSync(":memory:");
    const bulk = bulkModeObserver();
    try {
      const db = createNodeSqliteDatabase(native, { observers: [bulk.observer] });
      await assertCode(() => db.call(sql.call`SELECT 1`), "BRAID_CALL_UNSUPPORTED");
      await assertCode(
        () => db.all(sql.rows`SELECT ${sql.bind("x", mssqlParameter.nvarchar(10))} AS x`),
        "BRAID_BIND_HINT_UNSUPPORTED",
      );
      let count = 0;
      for await (const row of db.stream(sql.rows`SELECT 1 AS a UNION ALL SELECT 2`)) {
        void row;
        count += 1;
      }
      assert.equal(count, 2);
      await db.execute(sql.command`CREATE TABLE t (v TEXT)`);
      await db.bulk(["a"], (value) => sql.command`INSERT INTO t (v) VALUES (${value})`);
      assert.equal(bulk.mode(), "prepared-loop");
    } finally {
      native.close();
    }
  },
);

const optionalNameQuery = (name: string | undefined) => sql.rows`
  SELECT id, name FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
  /*@braid end*/`;

docsClaim(
  "concepts/dynamic-braid.md",
  "@braid where emits WHERE only for an active child and removes a leading AND",
  async () => {
    const native = new DatabaseSync(":memory:");
    try {
      const db = createNodeSqliteDatabase(native);
      await db.execute(sql.command`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)`);
      await db.execute(sql.command`INSERT INTO users (name) VALUES ('Ada'), ('Grace')`);

      assert.equal((await db.all(optionalNameQuery("Ada"))).length, 1);
      assert.equal((await db.all(optionalNameQuery(undefined))).length, 2);
    } finally {
      native.close();
    }
  },
);

docsClaim(
  `${GS}#libsql`,
  "libSQL needs intMode string and rejects stream, read-only, isolation and session",
  async () => {
    assert.notEqual(
      await errorCode(() => createLibsqlDatabase(createClient({ url: ":memory:" }), {} as never)),
      "no-error",
    );
    const client = createClient({ url: ":memory:", intMode: "string" });
    const bulk = bulkModeObserver();
    try {
      const db = createLibsqlDatabase(client, { intMode: "string", observers: [bulk.observer] });
      await db.execute(sql.command`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
      const inserted = await db.execute(sql.command`INSERT INTO t (v) VALUES ('a')`);
      assert.equal(inserted.command?.insertId, undefined);
      await assertCode(() => db.stream(sql.rows`SELECT 1 AS x`), "BRAID_STREAM_UNSUPPORTED");
      await assertCode(() => db.tx({ readOnly: true }, async () => 1), "BRAID_TX_OPTION_UNSUPPORTED");
      await assertCode(() => db.tx({ isolation: "serializable" }, async () => 1), "BRAID_TX_OPTION_UNSUPPORTED");
      await assertCode(() => db.session(async () => 1), "BRAID_SESSION_UNSUPPORTED");
      await db.bulk(["x"], (value) => sql.command`INSERT INTO t (v) VALUES (${value})`);
      assert.equal(bulk.mode(), "remote-batch");
    } finally {
      client.close();
    }
  },
);

docsClaim(
  `${GS}#better-sqlite3`,
  "better-sqlite3 returns exact INTEGER strings, streams with iterate() and bulk is prepared-loop",
  async () => {
    const native = new Database(":memory:");
    const bulk = bulkModeObserver();
    try {
      const db = createBetterSqlite3Database(native, { observers: [bulk.observer] });
      assert.deepEqual(await db.one(sql.rows`SELECT 9223372036854775807 AS big, 1.5 AS r`), {
        big: "9223372036854775807",
        r: 1.5,
      });
      let count = 0;
      for await (const row of db.stream(sql.rows`SELECT 1 AS a UNION ALL SELECT 2`)) {
        void row;
        count += 1;
      }
      assert.equal(count, 2);
      await db.execute(sql.command`CREATE TABLE t (v TEXT)`);
      await db.bulk(["x"], (value) => sql.command`INSERT INTO t (v) VALUES (${value})`);
      assert.equal(bulk.mode(), "prepared-loop");
    } finally {
      native.close();
    }
  },
);
