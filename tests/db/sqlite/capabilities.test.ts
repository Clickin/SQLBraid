import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { decodeExactInteger, type ExecutionEvent } from "@sqlbraid/core";
import { createPooledDatabase } from "@sqlbraid/runtime";
import { createNodeSqliteDatabase, createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { sql, typePolicy } from "@sqlbraid/sqlite";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { assertFloatBits, assertRepresentationConformance, binary64Finite, exactJsonText } from "../fidelity.js";
import { runTransparencyCase } from "../../transparency.js";
import { stampSupportEnvironment } from "../support-target.js";

test("sqlite.sql.native-transparency", async () => {
  const native = new DatabaseSync(":memory:");
  const events: ExecutionEvent[] = [];
  const db = createNodeSqliteDatabase(native, {
    observers: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
  try {
    const environment = await db.environment();
    stampSupportEnvironment(
      "sqlite",
      {
        ...environment,
        database: { ...environment.database, edition: "Node bundled SQLite" },
        driver: { ...environment.driver, version: process.versions.node },
      },
      "sqlite.sql.native-transparency",
    );
    assert.equal(environment.capabilities["session.pinned"]?.status, "guaranteed");
    assert.equal(environment.capabilities.transaction?.status, "guaranteed");
    assert.equal(environment.capabilities["transaction.isolation.serializable"]?.status, "guaranteed");
    assert.equal(environment.capabilities["transaction.read-only"]?.status, "unsupported");
    assert.equal(environment.capabilities["statement.cancel"]?.status, "unsupported");
    assert.equal(environment.capabilities["statement.stream"]?.status, "guaranteed");
    assert.equal(environment.capabilities["statement.bulk"]?.status, "guaranteed");
    events.length = 0;
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
      expectedParameterizedSql:
        "\n      WITH inputs(value) AS (SELECT ?)\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract('{\"enabled\":true}', '$.enabled') AS enabled,\n             value AS actual\n      FROM inputs\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [{ marker: "literal $1 :1 @p1 ?", enabled: "1", actual: 7 }],
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
    assert.deepEqual(query.render().segments, ['INSERT INTO "account" ("name") VALUES (', ")"]);
    await db.execute(query);
    assert.deepEqual(await db.all(sql.rows`SELECT name FROM account`), [{ name: "Ada" }]);
  } finally {
    native.close();
  }
});

test("sqlite.numeric.exact-integer", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    const raw = native.prepare("SELECT 42 AS value");
    raw.setReadBigInts(true);
    const canonical = await db.one(sql.rows<{ readonly value: string }>`SELECT 42 AS value`);
    assertRepresentationConformance(raw.get()?.value, 42n, canonical.value, "42", typePolicy, "INTEGER", "string");
    const row = await db.one(sql.rows<{
      readonly safe: string;
      readonly unsafe: string;
      readonly min: string;
      readonly max: string;
      readonly integralReal: number;
      readonly largeReal: number;
    }>`
      SELECT
        ${9007199254740991n} AS safe,
        ${9007199254740992n} AS unsafe,
        ${-9223372036854775808n} AS min,
        ${9223372036854775807n} AS max,
        CAST(1 AS REAL) AS integralReal,
        CAST(1e20 AS REAL) AS largeReal
    `);
    assert.equal(decodeExactInteger(row.safe), 9007199254740991n);
    assert.equal(decodeExactInteger(row.unsafe), 9007199254740992n);
    assert.equal(decodeExactInteger(row.min), -9223372036854775808n);
    assert.equal(decodeExactInteger(row.max), 9223372036854775807n);
    assert.equal(row.safe, "9007199254740991");
    assert.equal(row.unsafe, "9007199254740992");
    assert.equal(row.min, "-9223372036854775808");
    assert.equal(row.max, "9223372036854775807");
    assert.equal(typeof row.integralReal, "number");
    assert.equal(typeof row.largeReal, "number");
  } finally {
    native.close();
  }
});

test("sqlite.numeric.dynamic-storage-and-bind-exact", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    native.exec("CREATE TABLE pv17_dynamic(value); CREATE TABLE pv17_bind(value INTEGER NOT NULL)");
    native.prepare("INSERT INTO pv17_dynamic(value) VALUES (CAST(? AS INTEGER))").run("9007199254740993");
    native.prepare("INSERT INTO pv17_dynamic(value) VALUES (CAST(? AS REAL))").run("1.0");
    assert.deepEqual(
      await db.all(
        sql.rows<{
          readonly value: string | number;
          readonly storage: string;
        }>`SELECT value, typeof(value) AS storage FROM pv17_dynamic ORDER BY rowid`,
      ),
      [
        { value: "9007199254740993", storage: "integer" },
        { value: 1, storage: "real" },
      ],
    );

    await db.execute(sql.command`INSERT INTO pv17_bind(value) VALUES (${"9223372036854775807"})`);
    await db.execute(sql.command`INSERT INTO pv17_bind(value) VALUES (${-9223372036854775808n})`);
    await db.bulk(
      ["9007199254740993", "123456789012345678"],
      (value) => sql.command`INSERT INTO pv17_bind(value) VALUES (${value})`,
    );
    assert.deepEqual(await db.all(sql.rows<{ readonly value: string }>`SELECT value FROM pv17_bind ORDER BY rowid`), [
      { value: "9223372036854775807" },
      { value: "-9223372036854775808" },
      { value: "9007199254740993" },
      { value: "123456789012345678" },
    ]);
    await assert.rejects(() => db.execute(sql.command`INSERT INTO pv17_bind(value) VALUES (${undefined})`), {
      code: "BRAID_BIND_VALUE_UNSUPPORTED",
    });
  } finally {
    native.close();
  }
});

test("sqlite.numeric.approximate-float preserves SQLite REAL binary64 values", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    for (const expected of binary64Finite.filter((value) => value !== 0 && !Object.is(value, -0))) {
      const row = await db.one(sql.rows<{ readonly value: number }>`SELECT CAST(${expected} AS REAL) AS value`);
      assertFloatBits(row.value, expected, 64);
    }
    const specials = await db.one(
      sql.rows<{ readonly overflow: number; readonly nan: null }>`SELECT 1e999 AS overflow, 0.0 / 0.0 AS nan`,
    );
    assert.equal(specials.overflow, Infinity);
    assert.equal(specials.nan, null);
  } finally {
    native.close();
  }
});

test("sqlite.data.json-text", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    const row = await db.one(sql.rows<{ readonly payload: string; readonly enabled: string }>`
      SELECT ${exactJsonText} AS payload,
             json_extract(${'{"enabled":true}'}, '$.enabled') AS enabled
    `);
    assert.equal(row.payload, exactJsonText);
    assert.equal(row.enabled, "1");
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
    const row = await db.one(
      sql.rows<{ readonly payload: Uint8Array }>`SELECT ${Buffer.from([0, 255, 16])} AS payload`,
    );
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
      await db.all(
        sql.rows<{
          id: string;
          name: string;
        }>`INSERT INTO account (name, payload) VALUES (${"Grace"}, ${"{}"}) RETURNING id, name`,
      ),
      [{ id: "2", name: "Grace" }],
    );
    assert.deepEqual(
      await db.all(
        sql.rows<{
          id: string;
          name: string;
        }>`UPDATE account SET name = ${"Ada Lovelace"} WHERE id = ${1} RETURNING id, name`,
      ),
      [{ id: "1", name: "Ada Lovelace" }],
    );
    assert.deepEqual(await db.all(sql.rows<{ id: string }>`DELETE FROM account WHERE id = ${2} RETURNING id`), [
      { id: "2" },
    ]);
    assert.deepEqual(
      await db.all(
        sql.rows<{
          key: string;
          value: string;
        }>`INSERT INTO kv (key, value) VALUES (${"answer"}, ${41}) ON CONFLICT(key) DO UPDATE SET value = excluded.value + 1 RETURNING key, value`,
      ),
      [{ key: "answer", value: "41" }],
    );
    assert.deepEqual(
      await db.all(
        sql.rows<{
          enabled: string;
        }>`WITH RECURSIVE nums(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM nums WHERE value < ${3}) SELECT json_extract(${'{"enabled":true}'}, '$.enabled') AS enabled FROM nums`,
      ),
      [{ enabled: "1" }, { enabled: "1" }, { enabled: "1" }],
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
    native.exec(
      "CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO account VALUES (1, 'Ada'), (2, 'Bob')",
    );
    assert.deepEqual(await db.all(sql.rows`UPDATE account SET name = ${"Bobby"} WHERE id = ${2} RETURNING id, name`), [
      { id: "2", name: "Bobby" },
    ]);
  } finally {
    native.close();
  }
});

test("sqlite.dml.delete-returning", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  try {
    native.exec(
      "CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO account VALUES (1, 'Ada'), (2, 'Bob')",
    );
    assert.deepEqual(await db.all(sql.rows`DELETE FROM account WHERE id = ${1} RETURNING id, name`), [
      { id: "1", name: "Ada" },
    ]);
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
    const db = createNodeSqliteDatabase(
      {
        prepare(text) {
          prepares += 1;
          return native.prepare(text);
        },
        exec(text) {
          native.exec(text);
        },
      },
      {
        observers: [
          {
            onEvent(event) {
              events.push(event);
            },
          },
        ],
      },
    );
    const result = await db.bulk(
      ["Ada", "Grace", "Lin"],
      (name) => sql.command`INSERT INTO account (name) VALUES (${name})`,
    );
    assert.deepEqual(result, { inputCount: 3, affectedRows: 3 });
    assert.equal(prepares, 1);
    assert.deepEqual(
      native
        .prepare("SELECT name FROM account ORDER BY id")
        .all()
        .map((row) => row.name),
      ["Ada", "Grace", "Lin"],
    );
    events.length = 0;
    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "sqlite",
      expectedMode: "prepared-loop",
      events,
    });
    assert.equal(bulkReport.executionMode, "prepared-loop");
    assert.deepEqual(
      await db.bulk([], () => {
        throw new Error("factory must not run");
      }),
      { inputCount: 0, affectedRows: 0 },
    );
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
      { code: "BRAID_BIND_VALUE_UNSUPPORTED" },
    );
    assert.equal(prepares, 0);
    assert.equal(acquires, 0);
    assert.deepEqual(native.prepare("SELECT name FROM account").all(), []);
  } finally {
    native.close();
  }
});
