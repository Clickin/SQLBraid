import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createStatementBindingDescription,
  type ExecutableQuery,
  type ExecutionEvent,
  type QueryExecutor,
  type StandardSchemaV1,
  type StatementBindingAdapter,
} from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";

const statementBinding: StatementBindingAdapter = Object.freeze({
  id: "runtime-batch-lifecycle",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "runtime-batch-lifecycle",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});

function executor(overrides: Partial<QueryExecutor> = {}): QueryExecutor {
  return {
    statementBinding,
    async query<Row>() { return { kind: "rows", rows: [{ value: 1 }] as readonly Row[] }; },
    async *stream<Row>() { yield* [] as readonly Row[]; },
    async call() { return { output: {}, resultSets: [] }; },
    ...overrides,
  };
}

function terminalEvents(events: readonly ExecutionEvent[]): Extract<ExecutionEvent, { type: "query:error" | "query:mapped" }>[] {
  return events.filter((event): event is Extract<ExecutionEvent, { type: "query:error" | "query:mapped" }> => event.type === "query:error" || event.type === "query:mapped");
}

function rowQueries(count: number): readonly ExecutableQuery[] {
  return Array.from({ length: count }, (_, index) => sql.rows`SELECT ${index}`);
}

test("batch driver failure terminates every ready sibling without extra execution", async () => {
  const events: ExecutionEvent[] = [];
  let calls = 0;
  const driverFailure = new Error("driver failed");
  const db = createDatabase(executor({
    async query<Row>() {
      calls += 1;
      if (calls === 2) throw driverFailure;
      return { kind: "rows", rows: [{ value: calls }] as readonly Row[] };
    },
  }), { observers: [{ onEvent(event) { events.push(event); } }] });

  await assert.rejects(() => db.batch(rowQueries(3)), (error) => error === driverFailure);
  const ready = events.filter((event): event is Extract<ExecutionEvent, { type: "query:ready" }> => event.type === "query:ready");
  const terminals = terminalEvents(events);
  assert.equal(calls, 2);
  assert.equal(ready.length, 3);
  assert.equal(terminals.length, ready.length);
  const byOperation = new Map(terminals.map((event) => [event.operationId, event]));
  assert.equal(byOperation.size, 3);
  const first = byOperation.get(ready[0]!.operationId);
  const second = byOperation.get(ready[1]!.operationId);
  const third = byOperation.get(ready[2]!.operationId);
  assert.equal(first?.type, "query:error");
  assert.equal(first?.type === "query:error" ? first.executionStarted : undefined, true);
  assert.equal(first?.type === "query:error" ? first.executionCompleted : undefined, true);
  const firstError = first?.type === "query:error" ? first.error : undefined;
  assert.equal(
    typeof firstError === "object" && firstError !== null && "code" in firstError ? firstError.code : undefined,
    "BRAID_BATCH_ABORTED",
  );
  assert.equal(second?.type, "query:error");
  assert.equal(second?.type === "query:error" ? second.executionStarted : undefined, true);
  assert.equal(second?.type === "query:error" ? second.executionCompleted : undefined, false);
  assert.equal(third?.type, "query:error");
  assert.equal(third?.type === "query:error" ? third.executionStarted : undefined, false);
  assert.equal(third?.type === "query:error" ? third.executionCompleted : undefined, false);
  const thirdError = third?.type === "query:error" ? third.error : undefined;
  assert.equal(
    typeof thirdError === "object" && thirdError !== null && "code" in thirdError ? thirdError.code : undefined,
    "BRAID_BATCH_ABORTED",
  );
});

test("driver failure at each batch item preserves one terminal event per announced operation", async () => {
  for (const failureAt of [0, 1, 2]) {
    const events: ExecutionEvent[] = [];
    let calls = 0;
    const driverFailure = new Error(`driver failed at ${failureAt}`);
    const db = createDatabase(executor({
      async query<Row>() {
        const index = calls;
        calls += 1;
        if (index === failureAt) throw driverFailure;
        return { kind: "rows", rows: [{ value: index }] as readonly Row[] };
      },
    }), { observers: [{ onEvent(event) { events.push(event); } }] });
    await assert.rejects(() => db.batch(rowQueries(3)), (error) => error === driverFailure);
    const ready = events.filter((event): event is Extract<ExecutionEvent, { type: "query:ready" }> => event.type === "query:ready");
    const terminals = terminalEvents(events);
    assert.equal(calls, failureAt + 1);
    assert.equal(ready.length, 3);
    assert.equal(terminals.length, 3);
    assert.equal(terminals.every((event) => event.type === "query:error"), true);
    assert.equal(terminals.filter((event) => event.type === "query:error" && event.executionStarted && !event.executionCompleted).length, 1);
  }
});

test("batch mapper failure is fail-fast while remaining ready siblings still terminate", async () => {
  const events: ExecutionEvent[] = [];
  let calls = 0;
  let mapperCalls = 0;
  const mapperFailure = new Error("mapper failed");
  const schema: StandardSchemaV1<unknown, unknown> = {
    "~standard": {
      version: 1,
      vendor: "runtime-batch-lifecycle",
      validate() {
        mapperCalls += 1;
        throw mapperFailure;
      },
    },
  };
  const db = createDatabase(executor({
    async query<Row>() {
      calls += 1;
      return { kind: "rows", rows: [{ value: calls }] as readonly Row[] };
    },
  }), { observers: [{ onEvent(event) { events.push(event); } }] });
  const queries = [sql.rows(schema)`SELECT 1`, sql.rows(schema)`SELECT 2`, sql.rows(schema)`SELECT 3`] as const;

  await assert.rejects(() => db.batch(queries), (error) => error === mapperFailure);
  const ready = events.filter((event): event is Extract<ExecutionEvent, { type: "query:ready" }> => event.type === "query:ready");
  const terminals = terminalEvents(events);
  assert.equal(calls, 3);
  assert.equal(mapperCalls, 1);
  assert.equal(ready.length, 3);
  assert.equal(terminals.length, 3);
  assert.equal(terminals.filter((event) => event.type === "query:mapped").length, 0);
  assert.equal(terminals.filter((event) => event.type === "query:error").length, 3);
  assert.equal(terminals[1]?.type === "query:error" ? terminals[1].executionStarted : undefined, true);
  assert.equal(terminals[1]?.type === "query:error" ? terminals[1].executionCompleted : undefined, true);
  assert.equal(terminals[2]?.type === "query:error" ? terminals[2].executionStarted : undefined, true);
  assert.equal(terminals[2]?.type === "query:error" ? terminals[2].executionCompleted : undefined, true);
});

test("batch acquisition failure terminates every prepared sibling before physical execution", async () => {
  const events: ExecutionEvent[] = [];
  const acquireFailure = new Error("acquire failed");
  const db = createPooledDatabase({
    statementBinding,
    async acquire() { throw acquireFailure; },
  }, { observers: [{ onEvent(event) { events.push(event); } }] });

  await assert.rejects(() => db.batch(rowQueries(3)), (error) => error === acquireFailure);
  const ready = events.filter((event): event is Extract<ExecutionEvent, { type: "query:ready" }> => event.type === "query:ready");
  const terminals = terminalEvents(events);
  assert.equal(ready.length, 3);
  assert.equal(terminals.length, 3);
  assert.equal(terminals.every((event) => event.type === "query:error"), true);
  assert.equal(terminals.every((event) => event.type === "query:error" && !event.executionStarted && !event.executionCompleted), true);
});

test("batch preparation failure terminates only the already announced siblings", async () => {
  const events: ExecutionEvent[] = [];
  let calls = 0;
  const preparationFailure = new Error("render failed");
  const bad = {
    ...sql.rows`SELECT 2`,
    render() { throw preparationFailure; },
  };
  const db = createDatabase(executor({
    async query<Row>() {
      calls += 1;
      return { kind: "rows", rows: [{ value: calls }] as readonly Row[] };
    },
  }), { observers: [{ onEvent(event) { events.push(event); } }] });

  await assert.rejects(
    () => db.batch([sql.rows`SELECT 1`, bad, sql.rows`SELECT 3`] as const),
    (error) => error === preparationFailure,
  );
  const ready = events.filter((event): event is Extract<ExecutionEvent, { type: "query:ready" }> => event.type === "query:ready");
  const terminals = terminalEvents(events);
  assert.equal(calls, 0);
  assert.equal(ready.length, 1);
  assert.equal(terminals.length, 2);
  assert.equal(terminals.every((event) => event.type === "query:error"), true);
});

test("batch release failure still reports all ready siblings when error observers throw", async () => {
  const events: ExecutionEvent[] = [];
  let releases = 0;
  const releaseFailure = new Error("release failed");
  const db = createPooledDatabase({
    statementBinding,
    async acquire() {
      return {
        statementBinding,
        async query<Row>() { return { kind: "rows", rows: [{ value: 1 }] as readonly Row[] }; },
        async *stream<Row>() { yield* [] as readonly Row[]; },
        async call() { return { output: {}, resultSets: [] }; },
        release() { releases += 1; throw releaseFailure; },
      };
    },
  }, {
    observers: [
      { onEvent(event) { events.push(event); } },
      { onEvent(event) { if (event.type === "query:error") throw new Error("observer failed"); } },
    ],
  });

  await assert.rejects(() => db.batch(rowQueries(3)), (error) => error instanceof AggregateError && error.errors.includes(releaseFailure));
  assert.equal(releases, 1);
  const ready = events.filter((event): event is Extract<ExecutionEvent, { type: "query:ready" }> => event.type === "query:ready");
  const terminals = terminalEvents(events);
  assert.equal(ready.length, 3);
  assert.equal(terminals.length, 3);
  assert.equal(terminals.every((event) => event.type === "query:error"), true);
});
