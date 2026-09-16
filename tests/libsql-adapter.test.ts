import assert from "node:assert/strict";
import { test } from "vitest";
import type { RenderedBulk } from "@sqlbraid/core";
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
): LibsqlClientLike {
  return { execute, batch, transaction };
}

test("libSQL requires an explicit exact-string integer assertion", () => {
  const client = fakeClient(async () => rowsResult([], []));
  assert.throws(
    () => createLibsqlExecutor(client, undefined as never),
    (error: unknown) => error instanceof TypeError
      && error.message.includes("BRAID_INTEGER_MODE_REQUIRED"),
  );
  assert.throws(
    () => createLibsqlExecutor(client, { intMode: "bigint" } as never),
    (error: unknown) => error instanceof TypeError
      && error.message.includes("BRAID_INTEGER_MODE_REQUIRED"),
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
  assert.deepEqual(
    await emptyRows.query(sql.rows`SELECT id FROM users WHERE 0`.render()),
    { kind: "rows", rowCount: 0, rows: [] },
  );
});

test("libSQL rejects duplicate labels before row conversion and maps command metadata", async () => {
  const duplicate = createLibsqlExecutor(
    fakeClient(async () => rowsResult(["id", "id"], [{ 0: 1, 1: 2 }])),
    { intMode: "string" },
  );
  await assert.rejects(
    () => duplicate.query(sql.rows`SELECT 1 AS id, 2 AS id`.render()),
    (error: unknown) => error instanceof Error
      && error.message.includes("BRAID_RESULT_COLUMNS"),
  );

  const command = createLibsqlExecutor(
    fakeClient(async () => ({
      columns: [],
      rows: [],
      rowsAffected: 2,
      lastInsertRowid: 17n,
    })),
    { intMode: "string" },
  );
  assert.deepEqual(
    await command.query(sql.command`INSERT INTO users (id) VALUES (1)`.render()),
    {
      kind: "command",
      rowCount: 2,
      rows: [],
      command: { affectedRows: 2, insertId: "17" },
    },
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
    statement: sql.command`INSERT INTO users (name) VALUES (${ "a" })`.render(),
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
  await assert.rejects(() => executor.commit!(), /commit failed/);
  assert.equal(closeCalls, 1);
  await assert.rejects(() => executor.rollback!(), /BRAID_TRANSACTION_STATE/);
  assert.equal(transactionCalls, 1);
});

test("libSQL advertises unsupported session pinning, stream, call, and cancellation", async () => {
  const executor = createLibsqlExecutor(fakeClient(async () => rowsResult([], [])), { intMode: "string" });
  assert.equal(executor.environment?.capabilities["session.pinned"]?.status, "unsupported");
  assert.equal(executor.environment?.capabilities["statement.stream"]?.status, "unsupported");
  const database = createLibsqlDatabase(fakeClient(async () => rowsResult([], [])), { intMode: "string" });
  await assert.rejects(
    () => database.session(async () => undefined),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "session.pinned",
  );
  await assert.rejects(
    async () => {
      for await (const _row of executor.stream(sql.rows`SELECT 1`.render())) {
        void _row;
      }
    },
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.stream",
  );
  await assert.rejects(
    () => executor.call(sql`SELECT 1`.render()),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "routine.call",
  );
  await assert.rejects(
    () => executor.query(sql.rows`SELECT 1`.render(), undefined, { signal: new AbortController().signal }),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.cancel",
  );
});
