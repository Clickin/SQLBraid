import assert from "node:assert/strict";
import { test } from "vitest";
import type { QueryExecutor, RenderedBulk, TransactionOptions } from "@sqlbraid/core";
import { UnsupportedFeatureError } from "@sqlbraid/core";
import { sql } from "@sqlbraid/sqlite";
import {
  createLibsqlDatabase,
  createLibsqlExecutor,
  type LibsqlClientLike,
  type LibsqlResultSetLike,
  type LibsqlTransactionLike,
} from "../packages/sqlite/src/libsql.js";

function rowsResult(
  columns: readonly string[],
  rows: readonly Record<number | string, unknown>[],
  columnTypes: readonly string[] = [],
): LibsqlResultSetLike {
  return { columns, columnTypes, rows };
}

function fakeClient(
  execute: (statement: unknown) => Promise<LibsqlResultSetLike>,
  batch: (statements: unknown[]) => Promise<readonly LibsqlResultSetLike[]> = async () => [],
  transaction: (mode?: "write" | "read" | "deferred") => Promise<LibsqlTransactionLike> = async () => {
    throw new Error("transaction not configured");
  },
  protocol?: string,
): LibsqlClientLike {
  return { execute, batch, transaction, ...(protocol === undefined ? {} : { protocol }) };
}

test("libSQL requires an explicit exact-string integer assertion", () => {
  const client = fakeClient(async () => rowsResult([], []));
  assert.throws(
    () => createLibsqlExecutor(client, undefined as never),
    (error: unknown) => error instanceof TypeError && error.message.includes("BRAID_INTEGER_MODE_REQUIRED"),
  );
  assert.throws(
    () => createLibsqlExecutor(client, { intMode: "bigint" } as never),
    (error: unknown) => error instanceof TypeError && error.message.includes("BRAID_INTEGER_MODE_REQUIRED"),
  );
});

test("libSQL classifies rows from columns metadata and normalizes integers and binary values", async () => {
  let statement: unknown;
  const bytes = new Uint8Array([2, 3, 5]);
  const buffer = bytes.buffer.slice(0);
  const client = fakeClient(async (input) => {
    statement = input;
    return rowsResult(
      ["id", "payload"],
      [{ 0: "9223372036854775807", 1: buffer, id: "ignored", payload: "ignored" }],
      ["INTEGER", "BLOB"],
    );
  });
  const executor = createLibsqlExecutor(client, { intMode: "string" });
  const result = await executor.query(sql.rows`SELECT 1 AS id, X'020305' AS payload`.render());
  assert.deepEqual(result, {
    kind: "rows",
    rowCount: 1,
    rows: [{ id: "9223372036854775807", payload: bytes }],
  });
  assert.deepEqual(statement, { sql: "SELECT 1 AS id, X'020305' AS payload" });

  const emptyRows = createLibsqlExecutor(
    fakeClient(async () => rowsResult(["id"], [])),
    { intMode: "string" },
  );
  assert.deepEqual(await emptyRows.query(sql.rows`SELECT id FROM users WHERE 0`.render()), {
    kind: "rows",
    rowCount: 0,
    rows: [],
  });

  const nullableInteger = createLibsqlExecutor(
    fakeClient(async () => rowsResult(["value"], [{ 0: null }], ["INTEGER"])),
    { intMode: "string" },
  );
  assert.deepEqual(await nullableInteger.query(sql.rows`SELECT NULL AS value`.render()), {
    kind: "rows",
    rowCount: 1,
    rows: [{ value: null }],
  });

  const dynamicIntegerAffinity = createLibsqlExecutor(
    fakeClient(async () => rowsResult(["value"], [{ 0: 1.5 }, { 0: "text" }], ["INTEGER"])),
    { intMode: "string" },
  );
  assert.deepEqual(await dynamicIntegerAffinity.query(sql.rows`SELECT value FROM dynamic_values`.render()), {
    kind: "rows",
    rowCount: 2,
    rows: [{ value: 1.5 }, { value: "text" }],
  });
});

test("libSQL rejects duplicate labels before row conversion", async () => {
  const duplicate = createLibsqlExecutor(
    fakeClient(async () => rowsResult(["id", "id"], [{ 0: 1, 1: 2 }])),
    { intMode: "string" },
  );
  await assert.rejects(
    async () => duplicate.query(sql.rows`SELECT 1 AS id, 2 AS id`.render()),
    (error: unknown) => error instanceof Error && error.message.includes("BRAID_RESULT_COLUMNS"),
  );
});

for (const protocol of ["http", "ws", "file", undefined, "unknown"]) {
  test(`libSQL command IDs require known exact transport provenance (${protocol ?? "absent"})`, async () => {
    const exact = protocol === "http" || protocol === "ws";
    const result: LibsqlResultSetLike = {
      columns: [],
      rows: [],
      rowsAffected: 1,
      // The native file path has already rounded before wrapping its ID in bigint.
      lastInsertRowid: exact ? 9007199254740993n : 9007199254740992n,
    };
    const executor = createLibsqlExecutor(
      fakeClient(
        async () => result,
        async () => [result],
        undefined,
        protocol,
      ),
      { intMode: "string" },
    );
    assert.deepEqual(
      await executor.query(sql.command`INSERT INTO users (id) VALUES (${"9007199254740993"})`.render()),
      {
        kind: "command",
        rowCount: 1,
        rows: [],
        command: exact ? { affectedRows: 1, insertId: "9007199254740993" } : { affectedRows: 1 },
      },
    );
    const bulk: RenderedBulk = {
      statement: sql.command`UPDATE users SET name = ${"after"}`.render(),
      parameterSets: [["after"]],
    };
    const binding = executor.statementBinding.describeBulk!(bulk, { dialectId: "sqlite", requestedReuse: "auto" });
    assert.deepEqual(await executor.bulk!(bulk, binding), {
      inputCount: 1,
      affectedRows: 1,
      executionMode: "remote-batch",
    });
    const unsafeExecutor = createLibsqlExecutor(
      fakeClient(
        async () => ({ ...result, lastInsertRowid: Number.MAX_SAFE_INTEGER + 1 }),
        undefined,
        undefined,
        protocol,
      ),
      { intMode: "string" },
    );
    const unsafeResult = unsafeExecutor.query(sql.command`INSERT INTO users (id) VALUES (1)`.render());
    if (exact) {
      await assert.rejects(Promise.resolve(unsafeResult), { code: "BRAID_RESULT_EXACTNESS" });
    } else {
      assert.deepEqual(await unsafeResult, {
        kind: "command",
        rowCount: 1,
        rows: [],
        command: { affectedRows: 1 },
      });
    }
  });
}

test("libSQL materializes hostile row labels as own data properties", async () => {
  const executor = createLibsqlExecutor(
    fakeClient(async () =>
      rowsResult(
        ["__proto__", "constructor", "toString", ""],
        [{ 0: "proto-value", 1: "constructor-value", 2: "toString-value", 3: "empty-key" }],
      ),
    ),
    { intMode: "string" },
  );
  const result = await executor.query(sql.rows`SELECT 1`.render());
  const row = result.kind === "rows" ? (result.rows[0] as Record<string, unknown>) : undefined;
  assert.ok(row);
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.deepEqual(Object.keys(row), ["__proto__", "constructor", "toString", ""]);
  assert.equal(Object.hasOwn(row, "__proto__"), true);
  assert.equal(row["__proto__"], "proto-value");
  assert.equal(row.constructor, "constructor-value");
  assert.equal(row.toString, "toString-value");
  assert.equal(row[""], "empty-key");
  assert.deepEqual(
    JSON.parse(JSON.stringify(row)),
    JSON.parse(
      '{ "__proto__": "proto-value", "constructor": "constructor-value", "toString": "toString-value", "": "empty-key" }',
    ),
  );
});

test("libSQL uses native batch for root and active transactions, never client BEGIN", async () => {
  const clientCalls: unknown[] = [];
  const txCalls: unknown[] = [];
  let handleClosed = 0;
  const tx: LibsqlTransactionLike = {
    async execute(statement) {
      txCalls.push(statement);
      return rowsResult([], []);
    },
    async batch(statements) {
      txCalls.push(statements);
      return statements.map(() => ({ columns: [], rows: [], rowsAffected: 1 }));
    },
    async commit() {},
    async rollback() {},
    close() {
      handleClosed += 1;
    },
  };
  const client = fakeClient(
    async (statement) => {
      clientCalls.push(statement);
      return rowsResult([], []);
    },
    async (statements) => {
      clientCalls.push(statements);
      return statements.map(() => ({ columns: [], rows: [], rowsAffected: 1 }));
    },
    async () => tx,
  );
  const executor = createLibsqlExecutor(client, { intMode: "string" });
  const bulk: RenderedBulk = {
    statement: sql.command`INSERT INTO users (name) VALUES (${"a"})`.render(),
    parameterSets: [["a"], ["b"]],
  };
  const binding = executor.statementBinding.describeBulk!(bulk, { dialectId: "sqlite", requestedReuse: "auto" });
  assert.deepEqual(await executor.bulk!(bulk, binding), {
    inputCount: 2,
    affectedRows: 2,
    executionMode: "remote-batch",
  });
  assert.equal(clientCalls.length, 1);
  assert.equal(JSON.stringify(clientCalls[0]).includes("BEGIN"), false);

  await executor.begin!();
  await executor.query(sql.rows`SELECT 1 AS value`.render());
  await executor.savepoint!("sp_1");
  await executor.rollbackTo!("sp_1");
  await executor.releaseSavepoint!("sp_1");
  await executor.bulk!(bulk, binding);
  await executor.commit!();
  assert.equal(clientCalls.length, 1);
  assert.equal(txCalls.filter((entry) => entry === "SAVEPOINT sp_1").length, 1);
  assert.equal(txCalls.filter((entry) => entry === "ROLLBACK TO SAVEPOINT sp_1").length, 1);
  assert.equal(txCalls.filter((entry) => entry === "RELEASE SAVEPOINT sp_1").length, 1);
  assert.equal(handleClosed, 1);
});

test("libSQL leaves default transaction mode to the client and maps explicit readOnly", async () => {
  const calls: unknown[][] = [];
  const tx: LibsqlTransactionLike = {
    async execute() {
      return rowsResult([], []);
    },
    async batch() {
      return [];
    },
    async commit() {},
    async rollback() {},
  };
  const client = fakeClient(
    async () => rowsResult([], []),
    async () => [],
    async function transaction(_mode?: "write" | "read" | "deferred") {
      calls.push([...arguments]);
      return tx;
    },
    "http",
  );
  const executor = createLibsqlExecutor(client, { intMode: "string" });
  await executor.begin!();
  await executor.commit!();
  await executor.begin!({});
  await executor.rollback!();
  await executor.begin!({ readOnly: true });
  await executor.rollback!();
  await executor.begin!({ readOnly: false });
  await executor.rollback!();
  assert.deepEqual(calls, [[], [], ["read"], ["write"]]);
});

test("libSQL validates transaction options without acquiring and preserves isolation precedence", () => {
  let transactionCalls = 0;
  const executor = createLibsqlExecutor(
    fakeClient(
      async () => rowsResult([], []),
      async () => [],
      async () => {
        transactionCalls += 1;
        return {
          async execute() {
            return rowsResult([], []);
          },
          async batch() {
            return [];
          },
          async commit() {},
          async rollback() {},
        };
      },
    ),
    { intMode: "string" },
  );
  const validate = (
    executor as QueryExecutor & {
      readonly validateTransactionOptions: (options?: TransactionOptions) => void;
    }
  ).validateTransactionOptions;
  assert.doesNotThrow(() => validate({ readOnly: false }));
  assert.throws(
    () => validate({ readOnly: true }),
    (error: unknown) =>
      error instanceof UnsupportedFeatureError &&
      error.feature === "transaction.read-only" &&
      error.code === "BRAID_TX_OPTION_UNSUPPORTED",
  );
  assert.throws(
    () => validate({ isolation: "serializable", readOnly: true }),
    (error: unknown) =>
      error instanceof UnsupportedFeatureError &&
      error.feature === "transaction.isolation.serializable" &&
      error.code === "BRAID_TX_OPTION_UNSUPPORTED",
  );
  assert.equal(transactionCalls, 0);
});

test("libSQL transaction cleanup clears continuity after commit or rollback failure", async () => {
  let transactionCalls = 0;
  let closeCalls = 0;
  const failingCommit: LibsqlTransactionLike = {
    async execute() {
      return rowsResult([], []);
    },
    async batch() {
      return [];
    },
    async commit() {
      throw new Error("commit failed");
    },
    async rollback() {},
    close() {
      closeCalls += 1;
    },
  };
  const client = fakeClient(
    async () => rowsResult([], []),
    async () => [],
    async () => {
      transactionCalls += 1;
      return failingCommit;
    },
  );
  const executor = createLibsqlExecutor(client, { intMode: "string" });
  await executor.begin!();
  await assert.rejects(async () => executor.commit!(), /commit failed/);
  assert.equal(closeCalls, 1);
  await assert.rejects(async () => executor.rollback!(), /BRAID_TRANSACTION_STATE/);
  assert.equal(transactionCalls, 1);
});

test("[contract:libsql:resource.init-failure:boundary] [ownership:direct] libSQL closes invalid acquired transaction handles and preserves validation failures", async () => {
  let closeCalls = 0;
  let rootQueries = 0;
  const invalid = {
    close() {
      closeCalls += 1;
    },
  } as unknown as LibsqlTransactionLike;
  const executor = createLibsqlExecutor(
    fakeClient(
      async () => {
        rootQueries += 1;
        return rowsResult(["value"], [{ 0: "root" }]);
      },
      async () => [],
      async () => invalid,
    ),
    { intMode: "string" },
  );
  await assert.rejects(
    async () => await executor.begin!(),
    (error: unknown) => error instanceof TypeError && error.message.includes("invalid transaction handle"),
  );
  assert.equal(closeCalls, 1);
  assert.equal(rootQueries, 0);
  assert.deepEqual(await executor.query(sql.rows`SELECT 'root' AS value`.render()), {
    kind: "rows",
    rowCount: 1,
    rows: [{ value: "root" }],
  });
  assert.equal(rootQueries, 1);
});

test("[contract:libsql:resource.cleanup-failure:boundary] [ownership:direct] libSQL aggregates invalid-handle validation and close failures", async () => {
  const primaryMessage = "invalid transaction handle";
  const closeFailure = new Error("transaction close failed");
  const invalid = {
    close() {
      throw closeFailure;
    },
  } as unknown as LibsqlTransactionLike;
  const executor = createLibsqlExecutor(
    fakeClient(
      async () => rowsResult([], []),
      async () => [],
      async () => invalid,
    ),
    { intMode: "string" },
  );
  await assert.rejects(
    async () => await executor.begin!(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal((error as { readonly code?: unknown }).code, "BRAID_RESOURCE_CLEANUP");
      assert.equal((error as AggregateError).errors.length, 2);
      assert.ok((error as AggregateError).errors[0] instanceof TypeError);
      assert.match(String((error as AggregateError).errors[0]), new RegExp(primaryMessage, "u"));
      assert.equal((error as AggregateError).errors[1], closeFailure);
      assert.equal((error as { readonly cause?: unknown }).cause, (error as AggregateError).errors[0]);
      return true;
    },
  );
});

test("libSQL rejects hostile savepoint names before transaction I/O", async () => {
  const calls: string[] = [];
  const transaction: LibsqlTransactionLike = {
    async execute(statement) {
      calls.push(String(statement));
      return rowsResult([], []);
    },
    async batch() {
      return [];
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createLibsqlExecutor(
    fakeClient(
      async () => rowsResult([], []),
      async () => [],
      async () => transaction,
    ),
    { intMode: "string" },
  );
  await executor.begin!();
  for (const name of [
    "",
    "white space",
    "bad;name",
    "bad'name",
    "--comment",
    "/*comment*/",
    "line\nbreak",
    "tab\tbreak",
  ]) {
    await assert.rejects(
      async () => await executor.savepoint!(name),
      (error: unknown) => error instanceof TypeError,
    );
  }
  assert.deepEqual(calls, []);
  await executor.savepoint!("braid_sp_1");
  assert.deepEqual(calls, ["SAVEPOINT braid_sp_1"]);
  await executor.rollback!();
});

for (const cleanupFails of [false, true]) {
  test(`[contract:libsql:resource.init-failure:boundary] [ownership:direct] throwing native transaction accessors close the acquired handle${cleanupFails ? " and retain cleanup failure" : ""}`, async () => {
    const primary = new Error("native handle validation failed");
    const cleanup = new Error("native handle close failed");
    let acquired = 0;
    let closed = 0;
    let callbackRan = false;
    const db = createLibsqlDatabase(
      fakeClient(
        async () => rowsResult([], []),
        async () => [],
        async () => {
          acquired++;
          return {
            get execute(): never {
              throw primary;
            },
            async batch() {
              return [];
            },
            async commit() {},
            async rollback() {},
            async close() {
              closed++;
              if (cleanupFails) throw cleanup;
            },
          };
        },
      ),
      { intMode: "string" },
    );
    await assert.rejects(
      db.tx(async () => {
        callbackRan = true;
      }),
      (error) =>
        cleanupFails
          ? error instanceof AggregateError &&
            error.cause === primary &&
            error.errors.includes(primary) &&
            error.errors.includes(cleanup)
          : error === primary,
    );
    assert.equal(callbackRan, false);
    assert.equal(acquired, 1);
    assert.equal(closed, 1);
  });
}

test("libSQL advertises unsupported session pinning, stream, call, and cancellation", async () => {
  const executor = createLibsqlExecutor(
    fakeClient(async () => rowsResult([], [])),
    { intMode: "string" },
  );
  assert.equal(executor.environment?.capabilities["session.pinned"]?.status, "unsupported");
  assert.equal(executor.environment?.capabilities["statement.stream"]?.status, "unsupported");
  const database = createLibsqlDatabase(
    fakeClient(async () => rowsResult([], [])),
    { intMode: "string" },
  );
  await assert.rejects(
    () => database.session(async () => undefined),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "session.pinned",
  );
  await assert.rejects(
    async () => {
      for await (const _row of executor.stream(sql.rows`SELECT 1`.render())) {
        void _row;
      }
    },
    (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "statement.stream",
  );
  await assert.rejects(
    async () => executor.call(sql`SELECT 1`.render()),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "routine.call",
  );
  await assert.rejects(
    async () => executor.query(sql.rows`SELECT 1`.render(), undefined, { signal: new AbortController().signal }),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "statement.cancel",
  );
});
