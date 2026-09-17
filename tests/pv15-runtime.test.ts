import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createStatementBindingDescription,
  UnsupportedFeatureError,
  type DriverRoutineResult,
  type ExecutionEvent,
  type QueryExecutor,
  type RowQuery,
  type StandardSchemaV1,
  type StatementBindingAdapter,
  type Dialect,
  type TransactionOptions,
} from "@sqlbraid/core";
import { createSqlTag, sql } from "@sqlbraid/template";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: "pv15-runtime",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "pv15-runtime",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});

const unsupportedTransactionEnvironment = {
  database: { product: "pv15-runtime" },
  driver: { id: "pv15-runtime" },
  capabilities: { "transaction.read-only": { status: "unsupported" as const } },
};

function schema<Output>(validate: (value: unknown) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>): StandardSchemaV1<unknown, Output> {
  return { "~standard": { version: 1, vendor: "pv15-runtime", validate } };
}

function emptyRowsExecutor(overrides: Partial<QueryExecutor> = {}): QueryExecutor {
  return {
    statementBinding,
    async query<Row>() { return { kind: "rows", rows: [] as readonly Row[] }; },
    async *stream<Row>() { yield* [] as readonly Row[]; },
    async call(): Promise<DriverRoutineResult> { return { output: {}, resultSets: [] }; },
    ...overrides,
  };
}

function transactionLease(begin: () => Promise<void> = async () => {}): QueryExecutor & { release(): void } {
  return {
    statementBinding,
    async query<Row>() { return { kind: "rows", rows: [] as readonly Row[] }; },
    async *stream<Row>() { yield* [] as readonly Row[]; },
    async call(): Promise<DriverRoutineResult> { return { output: {}, resultSets: [] }; },
    begin,
    async commit() {},
    async rollback() {},
    release() {},
  };
}

function alternateDialect(id: string): Dialect {
  return {
    id,
    quoteIdentifier: (value) => `"${value.replaceAll('"', '""')}"`,
    lexicalProfile: { lineCommentPrefixes: ["--"] },
  };
}

test("transaction option validators reject before provider acquisition and override conservative capability status", async () => {
  let acquired = 0;
  let began = 0;
  const provider = {
    statementBinding,
    environment: unsupportedTransactionEnvironment,
    validateTransactionOptions(options: TransactionOptions) {
      if (options.readOnly === true) throw new UnsupportedFeatureError("transaction.read-only", "BRAID_TX_OPTION_UNSUPPORTED", "read-only is unavailable");
    },
    async acquire() {
      acquired += 1;
      return transactionLease(async () => { began += 1; });
    },
  };
  const db = createPooledDatabase(provider);
  await db.tx({ readOnly: false }, async () => {});
  assert.equal(acquired, 1);
  assert.equal(began, 1);
  await assert.rejects(() => db.tx({ readOnly: true }, async () => {}), (error) => error instanceof UnsupportedFeatureError && error.feature === "transaction.read-only");
  assert.equal(acquired, 1);
  assert.equal(began, 1);

  let noHookAcquired = 0;
  const noHookDb = createPooledDatabase({
    statementBinding,
    environment: unsupportedTransactionEnvironment,
    async acquire() {
      noHookAcquired += 1;
      return transactionLease();
    },
  });
  await assert.rejects(() => noHookDb.tx({ readOnly: false }, async () => {}), (error) => error instanceof UnsupportedFeatureError);
  assert.equal(noHookAcquired, 0);

  let thenableAcquired = 0;
  const thenableDb = createPooledDatabase({
    statementBinding,
    validateTransactionOptions() {
      return Promise.resolve() as unknown as void;
    },
    async acquire() {
      thenableAcquired += 1;
      return transactionLease();
    },
  });
  await assert.rejects(() => thenableDb.tx({ readOnly: false }, async () => {}), /must be synchronous/u);
  assert.equal(thenableAcquired, 0);
});

test("provider transaction option validator is inherited when a lease omits it", async () => {
  let began = 0;
  const db = createPooledDatabase({
    statementBinding,
    environment: unsupportedTransactionEnvironment,
    validateTransactionOptions(options: TransactionOptions) {
      if (options.readOnly !== false) throw new UnsupportedFeatureError("transaction.read-only", "BRAID_TX_OPTION_UNSUPPORTED", "only explicit writable mode is supported");
    },
    async acquire() {
      return transactionLease(async () => { began += 1; });
    },
  });
  await db.tx({ readOnly: false }, async () => {});
  assert.equal(began, 1);
});

test("prepared factory, render, and shape failures emit non-executing query:error events", async () => {
  const events: ExecutionEvent[] = [];
  const failure = new Error("factory failed");
  const db = createDatabase(emptyRowsExecutor(), { observers: [{ onEvent(event) { events.push(event); } }] });
  const prepared = db.prepare("factory-failure", (): RowQuery<unknown> => { throw failure; }, { input: "none" });
  await assert.rejects(() => prepared.execute(), (error) => error === failure);
  let errorEvent = events.at(-1);
  assert.equal(errorEvent?.type, "query:error");
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.stage : undefined, "prepared");
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionStarted : undefined, false);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionCompleted : undefined, false);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.preparedName : undefined, "factory-failure");

  events.length = 0;
  const renderFailure = new Error("render failed");
  const renderPrepared = db.prepare("render-failure", () => {
    const query = sql.rows`SELECT 1`;
    return { ...query, render: () => { throw renderFailure; } };
  }, { input: "none" });
  await assert.rejects(() => renderPrepared.execute(), (error) => error === renderFailure);
  errorEvent = events.at(-1);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.stage : undefined, "render");
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionStarted : undefined, false);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionCompleted : undefined, false);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.preparedName : undefined, "render-failure");

  events.length = 0;
  let alternate = false;
  const otherSql = createSqlTag({ dialect: alternateDialect("other") });
  const shapePrepared = db.prepare("dialect-shape", () => alternate ? otherSql.rows`SELECT 1` : sql.rows`SELECT 1`, { input: "none" });
  await shapePrepared.execute();
  alternate = true;
  await assert.rejects(
    () => shapePrepared.execute(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_PREPARED_SHAPE",
  );
  errorEvent = events.at(-1);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.stage : undefined, "prepared");
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionStarted : undefined, false);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionCompleted : undefined, false);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.preparedName : undefined, "dialect-shape");

  events.length = 0;
  const bindingFailure = new Error("binding failed");
  const bindingDb = createDatabase(emptyRowsExecutor({
    statementBinding: { id: "failing-binding", describe() { throw bindingFailure; } },
  }), { observers: [{ onEvent(event) { events.push(event); } }] });
  const bindingPrepared = bindingDb.prepare("binding-failure", () => sql.rows`SELECT 1`, { input: "none" });
  await assert.rejects(() => bindingPrepared.execute(), (error) => error === bindingFailure);
  errorEvent = events.at(-1);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.stage : undefined, "materialize");
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionStarted : undefined, false);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionCompleted : undefined, false);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.preparedName : undefined, "binding-failure");
});

test("streaming explicitly returns the driver iterator before releasing its lease", async () => {
  const order: string[] = [];
  let returns = 0;
  let releases = 0;
  const db = createPooledDatabase({
    statementBinding,
    async acquire() {
      return {
        statementBinding,
        async query<Row>() { return { kind: "rows", rows: [] as readonly Row[] }; },
        stream<Row>() {
          const iterator: AsyncIterator<Row> = {
            next: async () => ({ done: false, value: 1 as Row }),
            return: async () => { returns += 1; order.push("iterator.return"); return { done: true, value: undefined }; },
          };
          return { [Symbol.asyncIterator]: () => iterator };
        },
        async call() { return { output: {}, resultSets: [] }; },
        release(options) { releases += 1; order.push(`release:${options?.discard === true}`); },
      };
    },
  });

  for await (const row of db.stream(sql.rows<number>`SELECT stream`)) {
    assert.equal(row, 1);
    break;
  }
  assert.equal(returns, 1);
  assert.equal(releases, 1);
  assert.deepEqual(order, ["iterator.return", "release:false"]);
});

test("stream cleanup failure poisons and discards the lease while preserving the cleanup marker", async () => {
  const cleanup = Object.assign(new Error("cursor close failed"), { code: "BRAID_RESOURCE_CLEANUP" });
  let discarded = false;
  const db = createPooledDatabase({
    statementBinding,
    async acquire() {
      return {
        statementBinding,
        async query<Row>() { return { kind: "rows", rows: [] as readonly Row[] }; },
        stream<Row>() {
          let first = true;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: async () => first ? (first = false, { done: false, value: 1 as Row }) : { done: true, value: undefined },
                return: async () => { throw cleanup; },
              };
            },
          };
        },
        async call() { return { output: {}, resultSets: [] }; },
        release(options) { discarded = options?.discard === true; },
      };
    },
  });
  await assert.rejects(async () => {
    for await (const row of db.stream(sql.rows<number>`SELECT stream`)) {
      void row;
      break;
    }
  }, (error: unknown) => error === cleanup || (error instanceof AggregateError && error.errors.includes(cleanup)));
  assert.equal(discarded, true);
});

test("routine results map output, return value, and heterogeneous result sets after release", async () => {
  const events: ExecutionEvent[] = [];
  let released = false;
  const outputSchema = schema(async (value) => {
    await Promise.resolve();
    assert.equal(released, true, "async output mapping must not retain the lease");
    const ok = value !== null && typeof value === "object" && "ok" in value && value.ok === true;
    return { value: { success: ok } };
  });
  const userSchema = schema((value) => {
    if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "number") {
      return { issues: [{ message: "invalid user" }] };
    }
    return { value: { id: value.id, kind: "user" as const } };
  });
  const paymentSchema = schema((value) => {
    if (typeof value !== "object" || value === null || !("total" in value) || typeof value.total !== "number") {
      return { issues: [{ message: "invalid payment" }] };
    }
    return { value: { total: value.total, kind: "payment" as const } };
  });
  const returnSchema = schema((value) => typeof value === "number" ? { value: `status-${value}` } : { issues: [{ message: "invalid status" }] });
  const result = createPooledDatabase({
    statementBinding,
    async acquire() {
      return {
        statementBinding,
        async query<Row>() { return { kind: "rows", rows: [] as readonly Row[] }; },
        async *stream<Row>() { yield* [] as readonly Row[]; },
        async call() {
          return {
            output: { ok: true },
            returnValue: 7,
            resultSets: [
              { rows: [{ id: 4 }], source: { kind: "emitted", index: 0 } },
              { rows: [{ total: 12 }], source: { kind: "emitted", index: 1 } },
            ],
          };
        },
        release() { released = true; },
      };
    },
  }, { observers: [{ onEvent(event) { events.push(event); } }] });
  const query = sql.call({ output: outputSchema, resultSets: [userSchema, paymentSchema] as const, returnValue: returnSchema })`CALL routine()`;
  const mapped = await result.call(query);
  assert.equal(released, true);
  assert.deepEqual(mapped.output, { success: true });
  assert.deepEqual(mapped.resultSets, [{ rows: [{ id: 4, kind: "user" }] }, { rows: [{ total: 12, kind: "payment" }] }]);
  assert.equal(mapped.returnValue, "status-7");
  const resultEvent = events.find((event) => event.type === "query:result");
  assert.equal(resultEvent?.type === "query:result" ? resultEvent.resultSetCount : undefined, 2);
  assert.equal(resultEvent?.type === "query:result" ? resultEvent.rowCount : undefined, 2);
  assert.deepEqual(resultEvent?.type === "query:result" ? resultEvent.outputKeys : undefined, ["ok"]);
  const mappedEvent = events.find((event) => event.type === "query:mapped");
  assert.equal(mappedEvent?.type === "query:mapped" ? mappedEvent.queryMapped : undefined, true);
  assert.equal(mappedEvent?.type === "query:mapped" ? mappedEvent.rowCount : undefined, 2);
});

test("refcursor routine calls require a caller-owned transaction before acquiring a lease", async () => {
  let acquired = 0;
  const events: ExecutionEvent[] = [];
  const db = createPooledDatabase({
    statementBinding,
    async acquire() {
      acquired += 1;
      return {
        statementBinding,
        async query<Row>() { return { kind: "rows", rows: [] as readonly Row[] }; },
        async *stream<Row>() { yield* [] as readonly Row[]; },
        async call() { return { output: {}, resultSets: [] }; },
        release() {},
      };
    },
  }, { observers: [{ onEvent(event) { events.push(event); } }] });
  const query = sql.call`CALL cursor_routine(${sql.out("portal", { databaseType: "refcursor" })})`;
  await assert.rejects(() => db.call(query), /BRAID_CALL_CURSOR_TX_REQUIRED/u);
  assert.equal(acquired, 0);
  const errorEvent = events.find((event) => event.type === "query:error");
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.stage : undefined, "materialize");
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionStarted : undefined, false);
  assert.equal(errorEvent?.type === "query:error" ? errorEvent.executionCompleted : undefined, false);
});

test("routine mapping errors identify the failing result set and row", async () => {
  const passing = schema((value) => ({ value }));
  const failing = schema((value) => {
    if (value !== null && typeof value === "object" && "id" in value && value.id === 1) return { value };
    return { issues: [{ message: "bad" }] };
  });
  const db = createDatabase(emptyRowsExecutor({
    async call() {
      return {
        output: {},
        resultSets: [
          { rows: [{ status: "ready" }], source: { kind: "emitted", index: 0 } },
          { rows: [{ id: 1 }, { id: 2 }], source: { kind: "emitted", index: 1 } },
        ],
      };
    },
  }));
  const query = sql.call({ resultSets: [passing, failing] as const })`CALL routine()`;
  await assert.rejects(() => db.call(query), (error: unknown) => {
    if (error === null || typeof error !== "object" || !("location" in error)) return false;
    assert.deepEqual(error.location, { kind: "result-set", resultSetIndex: 1, rowIndex: 1 });
    return true;
  });
});

test("routine mapping preserves output and return failure locations", async () => {
  const failure = new Error("domain mapping failed");
  const outputSchema = schema<Readonly<Record<string, unknown>>>(() => { throw failure; });
  const returnSchema = schema(() => ({ issues: [{ message: "invalid return status" }] }));
  const db = createDatabase(emptyRowsExecutor({
    async call() { return { output: {}, returnValue: 7, resultSets: [] }; },
  }));
  await assert.rejects(() => db.call(sql.call({ output: outputSchema })`CALL routine()`), {
    code: "BRAID_CALL_MAP",
    location: { kind: "output" },
    cause: failure,
  });
  await assert.rejects(() => db.call(sql.call({ returnValue: returnSchema })`CALL routine()`), {
    code: "BRAID_CALL_MAP",
    location: { kind: "return-value" },
  });
});

test("routine contracts reject missing return channels and extra result sets", async () => {
  const db = createDatabase(emptyRowsExecutor({
    async call() { return { output: {}, resultSets: [{ rows: [], source: { kind: "emitted", index: 0 } }] }; },
  }));
  const result = await db.call(sql.call`CALL routine()`);
  assert.equal(Object.hasOwn(result, "returnValue"), false);
  await assert.rejects(
    () => db.call(sql.call({ returnValue: schema(() => ({ value: 123 })) })`CALL routine()`),
    { code: "BRAID_CALL_RETURN_UNSUPPORTED" },
  );
  await assert.rejects(
    () => db.call(sql.call({ resultSets: [] as const })`CALL routine()`),
    { code: "BRAID_CALL_RESULT_SETS" },
  );
});
