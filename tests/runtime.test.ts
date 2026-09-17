import assert from "node:assert/strict";
import { test } from "vitest";
import { createStatementBindingDescription } from "@sqlbraid/core";
import type { QueryExecutor, RenderedStatement, StatementBindingAdapter } from "@sqlbraid/core";
import { sql } from "@sqlbraid/template";
import { createDatabase, DatabaseCardinalityError, DatabaseScopeError } from "@sqlbraid/runtime";

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: "runtime-test",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "runtime-test",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});

function statementText(statement: RenderedStatement): string {
  return statement.segments.join("?");
}

function executorFor(
  rows: readonly unknown[],
): QueryExecutor & { readonly calls: readonly (RenderedStatement | string)[] } {
  const calls: (RenderedStatement | string)[] = [];
  return {
    calls,
    statementBinding,
    async query<Row>(rendered: RenderedStatement) {
      calls.push(rendered);
      return { kind: "rows" as const, rows: rows as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {
      calls.push("BEGIN");
    },
    async commit() {
      calls.push("COMMIT");
    },
    async rollback() {
      calls.push("ROLLBACK");
    },
  };
}

test("database wrappers share ownership for the same executor object", async () => {
  const calls: string[] = [];
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const executor = {
    statementBinding,
    async query<Row>(rendered: RenderedStatement) {
      calls.push(statementText(rendered));
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {
      calls.push("BEGIN");
    },
    async commit() {
      calls.push("COMMIT");
    },
    async rollback() {
      calls.push("ROLLBACK");
    },
  };
  const first = createDatabase(executor);
  const second = createDatabase(executor);
  const transaction = first.tx(async (tx) => {
    await tx.execute(sql`SELECT 'inside'`);
    await gate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const outside = second.execute(sql`SELECT 'outside'`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["BEGIN", "SELECT 'inside'"]);
  release();
  await transaction;
  await outside;
  assert.deepEqual(calls, ["BEGIN", "SELECT 'inside'", "COMMIT", "SELECT 'outside'"]);
});

test("runtime normalizes query execution to plain rows and enforces cardinality", async () => {
  const executor = executorFor([{ id: 1 }]);
  const db = createDatabase(executor);
  assert.deepEqual(await db.all(sql.rows`SELECT 1`), [{ id: 1 }]);
  assert.deepEqual(await db.one(sql.rows`SELECT 1`), { id: 1 });
  assert.deepEqual(await db.maybeOne(sql.rows`SELECT 1`), { id: 1 });
  const many = createDatabase(executorFor([{ id: 1 }, { id: 2 }]));
  await assert.rejects(() => many.maybeOne(sql.rows`SELECT 1`), DatabaseCardinalityError);
});

test("transactions commit and rollback through the adapter seam", async () => {
  const executor = executorFor([]);
  const db = createDatabase(executor);
  await db.tx(async (tx) => {
    await tx.execute(sql`UPDATE users SET ok = ${true}`);
  });
  assert.deepEqual(
    executor.calls.map((value) =>
      typeof value === "string" ? value : value.parameters.map((parameter) => parameter.value),
    ),
    ["BEGIN", [true], "COMMIT"],
  );
  await assert.rejects(() =>
    db.tx(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(executor.calls.at(-1), "ROLLBACK");
});

test("same-tick root transactions serialize their executor ownership", async () => {
  const calls: string[] = [];
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const db = createDatabase({
    statementBinding,
    async query(rendered) {
      calls.push(statementText(rendered));
      return { kind: "rows" as const, rows: [] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {
      calls.push("BEGIN");
    },
    async commit() {
      calls.push("COMMIT");
    },
    async rollback() {
      calls.push("ROLLBACK");
    },
  });
  const first = db.tx(async (tx) => {
    await tx.execute(sql`SELECT 1`);
    await gate;
  });
  const second = db.tx(async (tx) => {
    await tx.execute(sql`SELECT 2`);
  });
  const tick = Promise.withResolvers<void>();
  setImmediate(tick.resolve);
  await tick.promise;
  assert.deepEqual(calls, ["BEGIN", "SELECT 1"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["BEGIN", "SELECT 1", "COMMIT", "BEGIN", "SELECT 2", "COMMIT"]);
});

test("root handle use from its transaction callback fails before queueing", async () => {
  const calls: string[] = [];
  const db = createDatabase({
    statementBinding,
    async query(rendered) {
      calls.push(statementText(rendered));
      return { kind: "rows" as const, rows: [] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {
      calls.push("BEGIN");
    },
    async commit() {
      calls.push("COMMIT");
    },
    async rollback() {
      calls.push("ROLLBACK");
    },
  });
  await assert.rejects(
    () => db.tx(async () => db.execute(sql`SELECT 1`)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_SCOPE",
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK"]);
});

test("nested rollback releases its savepoint and preserves the parent scope", async () => {
  const calls: string[] = [];
  const db = createDatabase({
    statementBinding,
    async query(rendered) {
      calls.push(statementText(rendered));
      return { kind: "rows" as const, rows: [] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {
      calls.push("BEGIN");
    },
    async commit() {
      calls.push("COMMIT");
    },
    async rollback() {
      calls.push("ROLLBACK");
    },
    async savepoint(name) {
      calls.push(`SAVEPOINT ${name}`);
    },
    async rollbackTo(name) {
      calls.push(`ROLLBACK TO ${name}`);
    },
    async releaseSavepoint(name) {
      calls.push(`RELEASE ${name}`);
    },
  });
  await db.tx(async (tx) => {
    await assert.rejects(
      () =>
        tx.tx(async () => {
          throw new Error("nested failure");
        }),
      /nested failure/,
    );
    await tx.execute(sql`SELECT 2`);
  });
  assert.equal(calls.filter((entry) => entry.startsWith("RELEASE ")).length, 1);
  assert.equal(calls.at(-2), "SELECT 2");
  assert.equal(calls.at(-1), "COMMIT");
});

test("transaction cleanup failure is not reported as success", async () => {
  const application = new Error("statement failed");
  const cleanup = new Error("rollback failed");
  const db = createDatabase({
    statementBinding,
    async query() {
      return { kind: "rows" as const, rows: [] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {},
    async commit() {},
    async rollback() {
      throw cleanup;
    },
  });
  await assert.rejects(
    () =>
      db.tx(async () => {
        throw application;
      }),
    (error) => {
      return (
        error instanceof AggregateError &&
        error.errors[0] === application &&
        error.errors[1] === cleanup &&
        error.cause === application
      );
    },
  );
  await assert.rejects(
    () => db.execute(sql`SELECT poisoned`),
    (error) =>
      error instanceof DatabaseScopeError &&
      error.code === "BRAID_CONNECTION_POISONED" &&
      error.cause instanceof AggregateError &&
      error.cause.errors[0] === application &&
      error.cause.errors[1] === cleanup,
  );
  await assert.rejects(
    () => db.tx(async () => undefined),
    (error) => error instanceof DatabaseScopeError && error.code === "BRAID_CONNECTION_POISONED",
  );
});

test("poisoned ownership rejects every wrapper sharing the physical resource", async () => {
  const ownershipKey = {};
  const makeExecutor = () => ({
    ownershipKey,
    statementBinding,
    async query<Row>() {
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {},
    async commit() {},
    async rollback() {
      throw new Error("rollback failed");
    },
  });
  const first = createDatabase(makeExecutor());
  const second = createDatabase(makeExecutor());
  await assert.rejects(
    () =>
      first.tx(async () => {
        throw new Error("application failed");
      }),
    AggregateError,
  );
  await assert.rejects(
    () => second.execute(sql`SELECT blocked`),
    (error) => error instanceof DatabaseScopeError && error.code === "BRAID_CONNECTION_POISONED",
  );
});

test("successful transaction cleanup leaves physical ownership reusable", async () => {
  const calls: string[] = [];
  const db = createDatabase({
    statementBinding,
    async query<Row>(rendered: RenderedStatement) {
      calls.push(statementText(rendered));
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {
      calls.push("BEGIN");
    },
    async commit() {
      calls.push("COMMIT");
    },
    async rollback() {
      calls.push("ROLLBACK");
    },
  });
  await assert.rejects(() =>
    db.tx(async () => {
      throw new Error("application failed");
    }),
  );
  await db.execute(sql`SELECT after rollback`);
  await db.tx(async () => undefined);
  await db.execute(sql`SELECT after commit`);
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "SELECT after rollback", "BEGIN", "COMMIT", "SELECT after commit"]);
});

test("nested rollback and release cleanup failures poison the parent ownership", async () => {
  const rollbackFailure = createDatabase({
    statementBinding,
    async query<Row>() {
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {},
    async commit() {},
    async rollback() {},
    async savepoint() {},
    async rollbackTo() {
      throw new Error("rollback-to failed");
    },
    async releaseSavepoint() {},
  });
  await assert.rejects(
    () =>
      rollbackFailure.tx(async (tx) =>
        tx.tx(async () => {
          throw new Error("nested application failed");
        }),
      ),
    AggregateError,
  );
  await assert.rejects(
    () => rollbackFailure.execute(sql`SELECT blocked`),
    (error) => error instanceof DatabaseScopeError && error.code === "BRAID_CONNECTION_POISONED",
  );

  const releaseFailure = createDatabase({
    statementBinding,
    async query<Row>() {
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {},
    async commit() {},
    async rollback() {},
    async savepoint() {},
    async rollbackTo() {},
    async releaseSavepoint() {
      throw new Error("release failed");
    },
  });
  await assert.rejects(() => releaseFailure.tx(async (tx) => tx.tx(async () => undefined)), /release failed/);
  await assert.rejects(
    () => releaseFailure.execute(sql`SELECT blocked`),
    (error) => error instanceof DatabaseScopeError && error.code === "BRAID_CONNECTION_POISONED",
  );
});

test("begin and commit failures conservatively poison the physical ownership", async () => {
  const beginFailure = createDatabase({
    statementBinding,
    async query<Row>() {
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {
      throw new Error("begin uncertain");
    },
    async commit() {},
    async rollback() {},
  });
  await assert.rejects(() => beginFailure.tx(async () => undefined), /begin uncertain/);
  await assert.rejects(
    () => beginFailure.execute(sql`SELECT blocked`),
    (error) => error instanceof DatabaseScopeError && error.code === "BRAID_CONNECTION_POISONED",
  );

  const commitFailure = createDatabase({
    statementBinding,
    async query<Row>() {
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {},
    async commit() {
      throw new Error("commit uncertain");
    },
    async rollback() {
      throw new Error("rollback must not recover commit uncertainty");
    },
  });
  await assert.rejects(() => commitFailure.tx(async () => undefined), /commit uncertain/);
  await assert.rejects(
    () => commitFailure.execute(sql`SELECT blocked`),
    (error) => error instanceof DatabaseScopeError && error.code === "BRAID_CONNECTION_POISONED",
  );
});

test("transaction context does not poison later detached root work", async () => {
  const calls: string[] = [];
  const db = createDatabase({
    statementBinding,
    async query(rendered) {
      calls.push(statementText(rendered));
      return { kind: "rows" as const, rows: [] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
    async begin() {
      calls.push("BEGIN");
    },
    async commit() {
      calls.push("COMMIT");
    },
    async rollback() {
      calls.push("ROLLBACK");
    },
  });
  let detached!: Promise<unknown>;
  await db.tx(async () => {
    const ready = Promise.withResolvers<void>();
    detached = ready.promise.then(() => db.execute(sql`SELECT 3`));
    setImmediate(ready.resolve);
  });
  await detached;
  assert.deepEqual(calls, ["BEGIN", "COMMIT", "SELECT 3"]);
});
