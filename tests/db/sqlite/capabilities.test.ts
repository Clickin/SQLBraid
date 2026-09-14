import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { decodeExactInteger, type ExecutionEvent } from "@sqlbraid/core";
import { createPooledDatabase } from "@sqlbraid/runtime";
import { createNodeSqliteDatabase, createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { runTransparencyCase } from "../../transparency.js";

test("sqlite.sql.native-transparency", async () => {
  const native = new DatabaseSync(":memory:");
  const events: ExecutionEvent[] = [];
  const db = createNodeSqliteDatabase(native, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    const query = sql.rows`
      WITH inputs(value) AS (SELECT ${7})
      SELECT 'literal $1 :1 @p1 ?' AS marker,
             json_extract('{"enabled":true}', '$.enabled') AS enabled,
             value AS actual
      FROM inputs
    `;
    await runTransparencyCase({
      capabilityId: "sqlite.sql.native-transparency",
      query: query.render(),
      expectedSegments: [
        "\n      WITH inputs(value) AS (SELECT ",
        ")\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract('{\"enabled\":true}', '$.enabled') AS enabled,\n             value AS actual\n      FROM inputs\n    ",
      ],
      expectedParameterizedSql: "\n      WITH inputs(value) AS (SELECT ?)\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract('{\"enabled\":true}', '$.enabled') AS enabled,\n             value AS actual\n      FROM inputs\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [{ marker: "literal $1 :1 @p1 ?", enabled: 1, actual: 7 }],
    });
  } finally {
    native.close();
  }
});

test("sqlite.sql.generated-structure", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    native.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const query = sql.command`INSERT INTO ${sql.ident("account")} (${sql.ident("name")}) VALUES (${"Ada"})`;
    assert.deepEqual(query.render().segments, ["INSERT INTO \"account\" (\"name\") VALUES (", ")"]);
    await db.execute(query);
    assert.deepEqual(await db.all(sql.rows`SELECT name FROM account`), [{ name: "Ada" }]);
  } finally {
    native.close();
  }
});

test("sqlite.numeric.exact-integer", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native, { integerMode: "bigint" });
  try {
    const row = await db.one(sql.rows<{
      readonly safe: bigint;
      readonly unsafe: bigint;
      readonly min: bigint;
      readonly max: bigint;
    }>`
      SELECT
        ${9007199254740991n} AS safe,
        ${9007199254740992n} AS unsafe,
        ${-9223372036854775808n} AS min,
        ${9223372036854775807n} AS max
    `);
    assert.equal(decodeExactInteger(row.safe), 9007199254740991n);
    assert.equal(decodeExactInteger(row.unsafe), 9007199254740992n);
    assert.equal(decodeExactInteger(row.min), -9223372036854775808n);
    assert.equal(decodeExactInteger(row.max), 9223372036854775807n);
  } finally {
    native.close();
  }
});

test("sqlite.data.json-text", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    const row = await db.one(sql.rows<{ readonly payload: string; readonly enabled: number }>`
      SELECT ${'{"enabled":true,"nested":{"count":2}}' } AS payload,
             json_extract(${'{"enabled":true}'}, '$.enabled') AS enabled
    `);
    assert.equal(row.payload, '{"enabled":true,"nested":{"count":2}}');
    assert.equal(row.enabled, 1);
  } finally {
    native.close();
  }
});

test("sqlite.data.temporal", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    const row = await db.one(sql.rows<{ readonly value: string }>`SELECT ${"2026-09-14T12:34:56.000Z"} AS value`);
    assert.equal(row.value, "2026-09-14T12:34:56.000Z");
  } finally {
    native.close();
  }
});

test("sqlite.data.binary", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    const row = await db.one(sql.rows<{ readonly payload: Uint8Array }>`SELECT ${Buffer.from([0, 255, 16])} AS payload`);
    assert.ok(row.payload instanceof Uint8Array);
    assert.deepEqual([...row.payload], [0, 255, 16]);
  } finally {
    native.close();
  }
});

test("sqlite.result.rows", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    native.exec(`
      CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, payload TEXT) STRICT;
      CREATE TABLE kv (key TEXT PRIMARY KEY, value INTEGER) WITHOUT ROWID;
      INSERT INTO account (id, name, payload) VALUES (1, 'Ada', '{"enabled":true}');
    `);
    const db = createNodeSqliteDatabase(native);
    assert.deepEqual(
      await db.all(sql.rows<{ id: number; name: string }>`INSERT INTO account (name, payload) VALUES (${"Grace"}, ${"{}"}) RETURNING id, name`),
      [{ id: 2, name: "Grace" }],
    );
    assert.deepEqual(
      await db.all(sql.rows<{ id: number; name: string }>`UPDATE account SET name = ${"Ada Lovelace"} WHERE id = ${1} RETURNING id, name`),
      [{ id: 1, name: "Ada Lovelace" }],
    );
    assert.deepEqual(
      await db.all(sql.rows<{ id: number }>`DELETE FROM account WHERE id = ${2} RETURNING id`),
      [{ id: 2 }],
    );
    assert.deepEqual(
      await db.all(sql.rows<{ key: string; value: number }>`INSERT INTO kv (key, value) VALUES (${"answer"}, ${41}) ON CONFLICT(key) DO UPDATE SET value = excluded.value + 1 RETURNING key, value`),
      [{ key: "answer", value: 41 }],
    );
    assert.deepEqual(
      await db.all(sql.rows<{ enabled: number }>`WITH RECURSIVE nums(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM nums WHERE value < ${3}) SELECT json_extract(${"{\"enabled\":true}"}, '$.enabled') AS enabled FROM nums`),
      [{ enabled: 1 }, { enabled: 1 }, { enabled: 1 }],
    );
    assert.deepEqual(await db.all(sql.rows`SELECT 1 AS value WHERE 0`), []);
    await assert.rejects(() => db.execute(sql`SELECT 1 AS duplicate, 2 AS duplicate`), /BRAID_RESULT_COLUMNS/);
  } finally {
    native.close();
  }
});

test("sqlite.dml.update-returning", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    native.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO account VALUES (1, 'Ada'), (2, 'Bob')");
    assert.deepEqual(
      await db.all(sql.rows`UPDATE account SET name = ${"Bobby"} WHERE id = ${2} RETURNING id, name`),
      [{ id: 2, name: "Bobby" }],
    );
  } finally {
    native.close();
  }
});

test("sqlite.dml.delete-returning", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    native.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO account VALUES (1, 'Ada'), (2, 'Bob')");
    assert.deepEqual(
      await db.all(sql.rows`DELETE FROM account WHERE id = ${1} RETURNING id, name`),
      [{ id: 1, name: "Ada" }],
    );
  } finally {
    native.close();
  }
});

test("node:sqlite bulk prepares once and runs every parameter set", async () => {
  const native = new DatabaseSync(":memory:");
  let prepares = 0;
  const events: ExecutionEvent[] = [];
  try {
    native.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const db = createNodeSqliteDatabase({
      prepare(text) {
        prepares += 1;
        return native.prepare(text);
      },
      exec(text) {
        native.exec(text);
      },
    }, { observers: [{ onEvent(event) { events.push(event); } }] });
    const result = await db.bulk(["Ada", "Grace", "Lin"], (name) => sql.command`INSERT INTO account (name) VALUES (${name})`);
    assert.deepEqual(result, { inputCount: 3, affectedRows: 3 });
    assert.equal(prepares, 1);
    assert.deepEqual(native.prepare("SELECT name FROM account ORDER BY id").all().map((row) => row.name), ["Ada", "Grace", "Lin"]);
    events.length = 0;
    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "sqlite",
      expectedMode: "prepared-loop",
      events,
    });
    assert.equal(bulkReport.executionMode, "prepared-loop");
    assert.deepEqual(await db.bulk([], () => { throw new Error("factory must not run"); }), { inputCount: 0, affectedRows: 0 });
  } finally {
    native.close();
  }
});

test("node:sqlite bulk preflights every row before preparing or writing", async () => {
  const native = new DatabaseSync(":memory:");
  let prepares = 0;
  let acquires = 0;
  try {
    native.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const executor = createNodeSqliteExecutor({
      prepare(text) {
        prepares += 1;
        return native.prepare(text);
      },
      exec(text) {
        native.exec(text);
      },
    });
    const db = createPooledDatabase({
      statementBinding: executor.statementBinding,
      async acquire() {
        acquires += 1;
        return { ...executor, release() {} };
      },
    });
    await assert.rejects(
      () => db.bulk(["Ada", undefined], (name) => sql.command`INSERT INTO account (name) VALUES (${name})`),
      /BRAID_BIND_VALUE_UNSUPPORTED/u,
    );
    assert.equal(prepares, 0);
    assert.equal(acquires, 0);
    assert.deepEqual(native.prepare("SELECT name FROM account").all(), []);
  } finally {
    native.close();
  }
});
