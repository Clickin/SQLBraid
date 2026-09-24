import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { createPooledDatabase, DatabaseScopeError } from "@sqlbraid/runtime";
import type { QueryExecutor } from "@sqlbraid/core";
import { createNodeSqliteDatabase, createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { sql, typePolicy } from "@sqlbraid/sqlite";
import { runStreamingConformance } from "./streaming-conformance.js";

test("SQLite satisfies shared streaming lifecycle and releases only after iterator return", async () => {
  await runStreamingConformance(
    () => {
      const native = new DatabaseSync(":memory:");
      const executor = createNodeSqliteExecutor(native);
      let returns = 0;
      let releases = 0;
      let cleaned = false;
      const db = createPooledDatabase({
        statementBinding: executor.statementBinding,
        async acquire() {
          return {
            ...executor,
            stream<Row>(...args: Parameters<QueryExecutor["stream"]>): AsyncIterable<Row> {
              const iterator = executor.stream<Row>(...args)[Symbol.asyncIterator]();
              return {
                [Symbol.asyncIterator]() {
                  return {
                    next: () => iterator.next(),
                    async return() {
                      returns += 1;
                      const result = await iterator.return?.();
                      cleaned = true;
                      return result ?? { done: true as const, value: undefined };
                    },
                  };
                },
              };
            },
            release() {
              assert.equal(cleaned, true);
              releases += 1;
            },
          };
        },
      });
      const rowSchema = {
        "~standard": {
          version: 1 as const,
          vendor: "sqlite-conformance",
          validate(value: unknown) {
            assert.ok(
              value !== null && typeof value === "object" && "value" in value && typeof value.value === "number",
            );
            return { value: { value: value.value * 2 } };
          },
        },
      };
      return {
        db,
        query: sql.rows(rowSchema)`SELECT CAST(1 AS REAL) AS value UNION ALL SELECT CAST(2 AS REAL)`,
        expected: [{ value: 2 }, { value: 4 }],
        mappingQuery: sql.rows({
          "~standard": {
            version: 1,
            vendor: "sqlite-conformance",
            validate() {
              throw new Error("query mapper failed");
            },
          },
        })`SELECT CAST(1 AS REAL) AS value`,
        released: () => releases,
        iteratorReturns: () => returns,
        close: () => native.close(),
      };
    },
    { cancellation: "unsupported" },
  );
});

test("Node SQLite positional rows preserve hostile labels, exact integers, binary values, and empty metadata sets", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const query = sql.rows`SELECT
    'proto' AS "__proto__",
    'ctor' AS "constructor",
    'prototype' AS "prototype",
    'own' AS "hasOwnProperty",
    'zero' AS "0",
    'leading' AS "01",
    '한국어' AS "한글",
    'emoji' AS "😀",
    NULL AS "null_value",
    9007199254740993 AS "exact",
    X'010203' AS "binary"
  `;
  try {
    const rows = await db.all(query);
    const row = rows[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(row), [
      "0",
      "__proto__",
      "constructor",
      "prototype",
      "hasOwnProperty",
      "01",
      "한글",
      "😀",
      "null_value",
      "exact",
      "binary",
    ]);
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(row, "__proto__")?.value, "proto");
    assert.equal(row.constructor, "ctor");
    assert.equal(row.prototype, "prototype");
    assert.equal(row["hasOwnProperty"], "own");
    assert.equal(row["0"], "zero");
    assert.equal(row["01"], "leading");
    assert.equal(row["한글"], "한국어");
    assert.equal(row["😀"], "emoji");
    assert.equal(row.null_value, null);
    assert.equal(row.exact, "9007199254740993");
    assert.deepEqual(row.binary, new Uint8Array([1, 2, 3]));

    const streamed: unknown[] = [];
    for await (const streamedRow of db.stream(query)) streamed.push(streamedRow);
    assert.deepEqual(streamed, rows);
    assert.deepEqual(await db.all(sql.rows`SELECT 1 AS value WHERE 0`), []);
  } finally {
    native.close();
  }
});

test("SQLite preserves read and cleanup errors and discards an uncertain lease", async () => {
  const readFailure = new Error("native iterator read failed");
  const closeFailure = new Error("native iterator return failed");
  let discarded = 0;
  const executor = createNodeSqliteExecutor({
    prepare() {
      return {
        columns: () => [{ name: "value" }],
        all() {
          throw new Error("must not materialize");
        },
        run() {
          throw new Error("must not execute a command");
        },
        setReadBigInts() {},
        setReturnArrays() {},
        iterate() {
          return {
            [Symbol.iterator]() {
              return this;
            },
            next() {
              throw readFailure;
            },
            return() {
              throw closeFailure;
            },
          };
        },
      };
    },
  });
  const db = createPooledDatabase({
    statementBinding: executor.statementBinding,
    async acquire() {
      return {
        ...executor,
        release(options) {
          assert.equal(options?.discard, true, "uncertain physical lease must not be reused");
          discarded += 1;
        },
      };
    },
  });
  await assert.rejects(
    async () => {
      for await (const row of db.stream(sql.rows`SELECT 1 AS value`)) void row;
    },
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.includes(readFailure) &&
      error.errors.some(
        (nested: unknown) => nested === closeFailure || (nested instanceof Error && nested.cause === closeFailure),
      ),
  );
  assert.equal(discarded, 1);
});

test("SQLite exact INTEGER reads are strings while REAL remains number", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(
      await createNodeSqliteDatabase(native).one(sql.rows<{ value: string }>`SELECT 9007199254740993 AS value`),
      { value: "9007199254740993" },
    );
    assert.deepEqual(
      await createNodeSqliteDatabase(native).one(sql.rows<{ value: string }>`SELECT -9223372036854775808 AS value`),
      { value: "-9223372036854775808" },
    );
    assert.deepEqual(
      await createNodeSqliteDatabase(native).one(sql.rows<{ value: number }>`SELECT CAST(0.1 AS REAL) AS value`),
      { value: 0.1 },
    );
    const streamed: string[] = [];
    for await (const row of createNodeSqliteDatabase(native).stream(
      sql.rows<{ value: string }>`SELECT 9223372036854775807 AS value`,
    )) {
      streamed.push(row.value);
    }
    assert.deepEqual(streamed, ["9223372036854775807"]);

    assert.equal(typePolicy.mappings.find((mapping) => mapping.databaseType === "INTEGER")?.outputType, "string");
    assert.equal(
      typePolicy.mappings.find((mapping) => mapping.databaseType === "INTEGER")?.numeric?.representation,
      "string",
    );
  } finally {
    native.close();
  }
});

test("SQLite preserves large ROWID command metadata across INSERT, UPDATE, and DELETE on one connection", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const id = 9007199254740993n;
  try {
    native.exec("CREATE TABLE command_rowid (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    assert.deepEqual(await db.execute(sql.command`INSERT INTO command_rowid (id, name) VALUES (${id}, ${"before"})`), {
      rows: [],
      rowCount: 1,
      kind: "command",
      command: { affectedRows: 1, insertId: "9007199254740993" },
    });
    assert.deepEqual(await db.one(sql.rows`SELECT id, name FROM command_rowid`), {
      id: "9007199254740993",
      name: "before",
    });

    const updated = await db.execute(sql.command`UPDATE command_rowid SET name = ${"after"} WHERE id = ${id}`);
    assert.equal(updated.command?.affectedRows, 1);
    assert.deepEqual(await db.one(sql.rows`SELECT id, name FROM command_rowid`), {
      id: "9007199254740993",
      name: "after",
    });

    const deleted = await db.execute(sql.command`DELETE FROM command_rowid WHERE id = ${id}`);
    assert.equal(deleted.command?.affectedRows, 1);
    assert.deepEqual(await db.all(sql.rows`SELECT id, name FROM command_rowid`), []);
  } finally {
    native.close();
  }
});

test("SQLite rejects unsafe Number command metadata from custom statements", async () => {
  const db = createNodeSqliteDatabase({
    prepare() {
      return {
        columns: () => [],
        all: () => [],
        run: () => ({ changes: 1, lastInsertRowid: 9007199254740992 }),
      };
    },
  });
  await assert.rejects(() => db.execute(sql.command`INSERT INTO values_table DEFAULT VALUES`), {
    code: "BRAID_RESULT_EXACTNESS",
  });
});

test("SQLite rejects row reads without native integer transport but keeps command-only usage", async () => {
  let allCalls = 0;
  let iterateCalls = 0;
  let runCalls = 0;
  const db = createNodeSqliteDatabase({
    prepare(text) {
      const rows = text.startsWith("SELECT");
      return {
        columns: () => (rows ? [{ name: "value" }] : []),
        all: () => {
          allCalls += 1;
          return [{ value: 9007199254740992 }];
        },
        iterate: () => {
          iterateCalls += 1;
          return [{ value: 9007199254740992 }][Symbol.iterator]();
        },
        run: () => {
          runCalls += 1;
          return { changes: 1 };
        },
      };
    },
  });

  await assert.rejects(() => db.all(sql.rows`SELECT 9007199254740993 AS value`), /BRAID_INTEGER_MODE_UNSUPPORTED/);
  await assert.rejects(async () => {
    for await (const row of db.stream(sql.rows`SELECT 9007199254740993 AS value`)) void row;
  }, /BRAID_INTEGER_MODE_UNSUPPORTED/);
  assert.equal(allCalls, 0);
  assert.equal(iterateCalls, 0);

  assert.deepEqual(await db.execute(sql.command`UPDATE values_table SET value = ${1}`), {
    rows: [],
    rowCount: 1,
    kind: "command",
    command: { affectedRows: 1 },
  });
  assert.equal(runCalls, 1);
});

test("SQLite streams 100k rows without materializing an application array", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    native.exec(`
      CREATE TABLE pv15_stream (value INTEGER NOT NULL);
      WITH RECURSIVE nums(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM nums WHERE value < 100000
      )
      INSERT INTO pv15_stream SELECT value FROM nums;
    `);
    let allCalls = 0;
    let iterateCalls = 0;
    const db = createNodeSqliteDatabase({
      prepare(text) {
        const statement = native.prepare(text);
        return {
          columns: () => statement.columns(),
          all: () => {
            allCalls += 1;
            return statement.all();
          },
          run: () => statement.run(),
          iterate: () => {
            iterateCalls += 1;
            return statement.iterate();
          },
          setReadBigInts: (enabled) => statement.setReadBigInts(enabled),
          setReturnArrays: (enabled: boolean) => statement.setReturnArrays(enabled),
        };
      },
    });
    let count = 0;
    let sum = 0;
    for await (const row of db.stream(sql.rows<{ value: string }>`SELECT value FROM pv15_stream ORDER BY value`)) {
      count += 1;
      sum += Number(row.value);
    }
    assert.equal(count, 100000);
    assert.equal(sum, 5000050000);
    assert.equal(iterateCalls, 1);
    assert.equal(allCalls, 0);

    let stopped = "";
    for await (const row of db.stream(sql.rows<{ value: string }>`SELECT value FROM pv15_stream ORDER BY value`)) {
      stopped = row.value;
      break;
    }
    assert.equal(stopped, "1");

    const abort = new AbortController();
    abort.abort(new Error("stop"));
    await assert.rejects(
      async () => {
        for await (const row of db.stream(sql.rows<{ value: string }>`SELECT value FROM pv15_stream`, {
          signal: abort.signal,
        })) {
          void row;
        }
      },
      (error: unknown) => error instanceof Error && error.message === "stop",
    );
  } finally {
    native.close();
  }
}, 10_000);

test("SQLite stream mapper errors and transaction ownership release iteration", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    native.exec("CREATE TABLE pv15_tx (value INTEGER); INSERT INTO pv15_tx VALUES (1), (2)");
    const db = createNodeSqliteDatabase(native);
    const failure = new Error("mapper failed");
    await assert.rejects(
      async () => {
        for await (const row of db.stream(sql.rows<{ value: string }>`SELECT value FROM pv15_tx`, {
          schema: {
            "~standard": {
              version: 1,
              vendor: "pv15",
              validate() {
                throw failure;
              },
            },
          },
        })) {
          void row;
        }
      },
      (error: unknown) => error === failure,
    );

    await db.tx(async (tx) => {
      const values: string[] = [];
      for await (const row of tx.stream(sql.rows<{ value: string }>`SELECT value FROM pv15_tx`)) values.push(row.value);
      assert.deepEqual(values, ["1", "2"]);
      await assert.rejects(
        () => db.one(sql.rows<{ value: string }>`SELECT value FROM pv15_tx LIMIT 1`),
        (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_TX_SCOPE",
      );
    });
    assert.deepEqual(await db.all(sql.rows<{ value: string }>`SELECT value FROM pv15_tx`), [
      { value: "1" },
      { value: "2" },
    ]);
  } finally {
    native.close();
  }
});

test("SQLite custom scalar and aggregate functions remain ordinary row queries", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    native.function("pv15_double", (value) => {
      assert.equal(typeof value, "number");
      return Number(value) * 2;
    });
    native.aggregate("pv15_total", {
      start: 0,
      step: (total: number, value) => total + Number(value),
      result: (total: number) => total,
    });
    const db = createNodeSqliteDatabase(native);
    assert.deepEqual(
      await db.all(
        sql.rows<{ value: number }>`SELECT CAST(pv15_double(value) AS REAL) AS value FROM (SELECT 3 AS value)`,
      ),
      [{ value: 6 }],
    );
    assert.deepEqual(
      await db.all(
        sql.rows<{
          value: number;
        }>`SELECT CAST(pv15_total(value) AS REAL) AS value FROM (SELECT 3 AS value UNION ALL SELECT 4)`,
      ),
      [{ value: 7 }],
    );
    await assert.rejects(
      () => db.call(sql.call`CALL pv15_total()`),
      (error: unknown) => error instanceof Error && error.message.startsWith("BRAID_CALL_UNSUPPORTED:"),
    );
  } finally {
    native.close();
  }
});
