import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sql } from "@sqlbraid/sqlite";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";

const nativeMarkers = "literal $1 :1 @p1 ?";
const jsonText = '{"enabled":true,"nested":{"count":2}}';

function fail(message) {
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function latestReady(events) {
  const ready = events.findLast((event) => event.type === "query:ready");
  expect(ready !== undefined, "SQLite WASM did not emit query:ready evidence.");
  return ready;
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function serialValue(value) {
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) return { type: "Uint8Array", value: [...value] };
  return { type: typeof value, value };
}

function database(sqlite3, integerMode = "number", observers = []) {
  const native = new sqlite3.oo1.DB(":memory:");
  const db = createSqliteWasmDatabase(native, { integerMode, sqlite3, observers });
  return { native, db };
}

async function nativeTransparency(sqlite3) {
  const events = [];
  const { native, db } = database(sqlite3, "number", [{ onEvent(event) { events.push(event); } }]);
  try {
    const query = sql.rows`
      SELECT 'literal $1 :1 @p1 ?' AS marker,
             json_extract(${'{"enabled":true}'}, '$.enabled') AS enabled,
             ${7} AS actual
    `;
    const rendered = query.render();
    const expectedSegments = [
      "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract(",
      ", '$.enabled') AS enabled,\n             ",
      " AS actual\n    ",
    ];
    const expectedParameterizedSql = "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract(?1, '$.enabled') AS enabled,\n             ?2 AS actual\n    ";
    expect(JSON.stringify(rendered.segments) === JSON.stringify(expectedSegments), "SQLite WASM logical SQL segments changed.");
    const rows = await db.all(query);
    const ready = latestReady(events);
    expect(ready.sql === expectedParameterizedSql, "SQLite WASM observed parameterized SQL changed.");
    expect(rows.length === 1 && rows[0].marker === nativeMarkers && rows[0].enabled === 1 && rows[0].actual === 7, "SQLite WASM returned an unexpected transparency row.");
    return {
      logicalSegments: rendered.segments,
      parameterizedSql: ready.sql,
      observedValues: ready.values,
      rows,
    };
  } finally {
    native.close();
  }
}

async function generatedStructure(sqlite3) {
  const events = [];
  const { native, db } = database(sqlite3, "number", [{ onEvent(event) { events.push(event); } }]);
  try {
    native.exec("CREATE TABLE generated_table (name TEXT NOT NULL)");
    const insert = sql.command`INSERT INTO ${sql.ident("generated_table")} (${sql.ident("name")}) VALUES (${"Ada"})`;
    const rendered = insert.render();
    const expectedSegments = ["INSERT INTO \"generated_table\" (\"name\") VALUES (", ")"];
    const expectedParameterizedSql = "INSERT INTO \"generated_table\" (\"name\") VALUES (?1)";
    expect(JSON.stringify(rendered.segments) === JSON.stringify(expectedSegments), "SQLite WASM generated identifier structure changed.");
    await db.execute(insert);
    const ready = latestReady(events);
    expect(ready.sql === expectedParameterizedSql, "SQLite WASM generated statement SQL changed.");
    const rows = await db.all(sql.rows`SELECT ${sql.ident("name")} AS name FROM ${sql.ident("generated_table")}`);
    expect(rows.length === 1 && rows[0].name === "Ada", "SQLite WASM generated identifier row was not stored.");
    return { logicalSegments: rendered.segments, parameterizedSql: ready.sql, rows };
  } finally {
    native.close();
  }
}

async function exactInteger(sqlite3) {
  const { native, db } = database(sqlite3, "bigint");
  try {
    const safe = 9007199254740991n;
    const safePlusOne = 9007199254740992n;
    const minimum = -9223372036854775808n;
    const maximum = 9223372036854775807n;
    const row = await db.one(sql.rows`
      SELECT ${safe} AS safe,
             ${safePlusOne} AS safe_plus_one,
             ${minimum} AS minimum,
             ${maximum} AS maximum,
             CAST(1 AS REAL) AS integral_real,
             CAST(1e20 AS REAL) AS large_real
    `);
    const values = {
      safe: serialValue(row.safe),
      safePlusOne: serialValue(row.safe_plus_one),
      minimum: serialValue(row.minimum),
      maximum: serialValue(row.maximum),
    };
    expect(BigInt(values.safe.value) === safe, "SQLite WASM safe integer changed.");
    expect(BigInt(values.safePlusOne.value) === safePlusOne, "SQLite WASM safe-plus-one integer changed.");
    expect(BigInt(values.minimum.value) === minimum, "SQLite WASM signed int64 minimum changed.");
    expect(BigInt(values.maximum.value) === maximum, "SQLite WASM signed int64 maximum changed.");
    expect(Object.values(values).every((value) => value.type === "bigint"), "SQLite WASM INTEGER values were not returned uniformly as bigint.");
    const realValues = [serialValue(row.integral_real), serialValue(row.large_real)];
    expect(realValues.every((value) => value.type === "number"), "SQLite WASM confused integral REAL values with INTEGER.");
    let unsafeRejected = false;
    try {
      await createSqliteWasmDatabase(native).one(sql.rows`SELECT ${maximum} AS value`);
    } catch (error) {
      unsafeRejected = error instanceof RangeError && error.message.startsWith("BRAID_INTEGER_UNSAFE");
    }
    expect(unsafeRejected, "SQLite WASM number mode did not reject an unsafe INTEGER.");
    return { values, realValues, unsafeRejected };
  } finally {
    native.close();
  }
}

async function jsonTextCase(sqlite3) {
  const { native, db } = database(sqlite3, "number");
  try {
    const row = await db.one(sql.rows`
      SELECT ${jsonText} AS payload,
             json_extract(${'{"enabled":true}'}, '$.enabled') AS enabled
    `);
    expect(row.payload === jsonText && row.enabled === 1, "SQLite WASM JSON text row changed.");
    return { rows: [{ payload: row.payload, enabled: row.enabled }] };
  } finally {
    native.close();
  }
}

async function streamCase(sqlite3) {
  const { native, db } = database(sqlite3, "number");
  try {
    const query = sql.rows`
      WITH RECURSIVE numbers(value) AS (
        SELECT 1
        UNION ALL SELECT value + 1 FROM numbers WHERE value < 3
      )
      SELECT value FROM numbers ORDER BY value
    `;
    const iterator = db.stream(query)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done === false && first.value.value === 1, "SQLite WASM stream did not yield its first real row.");
    let blockedCode = "NONE";
    try {
      await db.all(sql.rows`SELECT 99 AS value`);
    } catch (error) {
      blockedCode = errorCode(error);
    }
    expect(blockedCode === "BRAID_STREAM_SCOPE", "SQLite WASM stream did not retain its resource lease.");
    const rest = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value.value);
    }
    expect(JSON.stringify(rest) === "[2,3]", "SQLite WASM stream lost rows after its first pull.");
    const after = await db.all(sql.rows`SELECT 4 AS value`);
    expect(after.length === 1 && after[0].value === 4, "SQLite WASM stream did not release its resource after completion.");
    return { first: first.value, blockedCode, rows: [first.value.value, ...rest], after };
  } finally {
    native.close();
  }
}

async function bulkCase(sqlite3) {
  let prepareCount = 0;
  const events = [];
  const native = new sqlite3.oo1.DB(":memory:");
  native.exec("CREATE TABLE bulk_values (value INTEGER NOT NULL)");
  const observed = {
    prepare(sqlText) {
      prepareCount += 1;
      return native.prepare(sqlText);
    },
    exec: native.exec.bind(native),
    changes: native.changes.bind(native),
  };
  const db = createSqliteWasmDatabase(observed, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    const result = await db.bulk([1, 2, 3], (value) => sql.command`INSERT INTO bulk_values (value) VALUES (${value})`);
    const rows = await db.all(sql.rows`SELECT value FROM bulk_values ORDER BY value`);
    expect(result.inputCount === 3 && result.affectedRows === 3, "SQLite WASM bulk did not report all affected rows.");
    expect(prepareCount === 2, "SQLite WASM bulk did not use one prepared statement for all items.");
    expect(JSON.stringify(rows) === JSON.stringify([{ value: 1 }, { value: 2 }, { value: 3 }]), "SQLite WASM bulk rows were not stored.");
    const ready = events.find((event) => event.type === "bulk:ready");
    const completed = events.find((event) => event.type === "bulk:result");
    expect(ready !== undefined && ready.sql === "INSERT INTO bulk_values (value) VALUES (?1)", "SQLite WASM bulk parameterized SQL was not observed.");
    expect(completed !== undefined && completed.executionMode === "prepared-loop", "SQLite WASM bulk execution mode was not observed.");
    return { result, parameterizedSql: ready.sql, executionMode: completed.executionMode, prepareCount, rows };
  } finally {
    native.close();
  }
}

async function mappedTransaction(sqlite3) {
  const { native, db } = database(sqlite3);
  const schema = {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-browser-fixture",
      validate: (row) => ({ value: { ...row, name: row.name.toUpperCase(), payload: JSON.parse(row.payload), bytes: [...row.bytes] } }),
    },
  };
  try {
    await db.execute(sql.command`CREATE TABLE mapped (id INTEGER PRIMARY KEY, name TEXT, payload TEXT, bytes BLOB, stamp TEXT, uuid TEXT)`);
    const inserted = await db.tx(async (tx) => {
      const result = await tx.one(sql.rows(schema)`INSERT INTO mapped VALUES (1, ${"Ada"}, ${'{"active":true}'}, ${new Uint8Array([0, 128, 255])}, ${"2026-09-14T00:00:00Z"}, ${"123e4567-e89b-12d3-a456-426614174000"}) RETURNING *`);
      const rollback = new Error("rollback nested insert");
      try {
        await tx.tx(async (nested) => {
          await nested.execute(sql.command`INSERT INTO mapped (id, name) VALUES (2, 'discarded')`);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const prepared = tx.prepare("mapped-row", () => sql.rows(schema)`SELECT * FROM mapped WHERE id = ${1}`);
      expect(JSON.stringify((await prepared.execute()).rows) === JSON.stringify([result]), "SQLite WASM prepared mapping lost the query-bound schema.");
      return result;
    });
    const stored = await db.all(sql.rows`SELECT id FROM mapped ORDER BY id`);
    expect(JSON.stringify(stored) === '[{"id":1}]', "SQLite WASM nested rollback did not preserve only the committed row.");
    const updated = await db.one(sql.rows`UPDATE mapped SET name = ${"Grace"} WHERE id = 1 RETURNING id, name`);
    const deleted = await db.one(sql.rows`DELETE FROM mapped WHERE id = 1 RETURNING id`);
    const remaining = await db.all(sql.rows`SELECT id FROM mapped`);
    return { inserted, updated, deleted, remaining };
  } finally {
    native.close();
  }
}

async function run() {
  expect(typeof WebAssembly === "object", "SQLite WASM conformance did not run with WebAssembly.");
  const sqlite3 = await sqlite3InitModule();
  const report = {
    runtime: "browser-wasm",
    sqliteVersion: sqlite3.version.libVersion,
    cases: {
      "wasm.sql.native-transparency": await nativeTransparency(sqlite3),
      "wasm.sql.generated-structure": await generatedStructure(sqlite3),
      "wasm.numeric.exact-integer": await exactInteger(sqlite3),
      "wasm.data.json-text": await jsonTextCase(sqlite3),
      "wasm.execution.stream": await streamCase(sqlite3),
      "wasm.execution.bulk": await bulkCase(sqlite3),
      "wasm.execution.mapped-transaction": await mappedTransaction(sqlite3),
    },
  };
  window.__sqlbraidWasmConformance = report;
}

run().catch((error) => {
  window.__sqlbraidWasmConformanceError = error instanceof Error ? error.message : String(error);
});
