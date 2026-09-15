import assert from "node:assert/strict";
import { test } from "vitest";
import { createStatementBindingDescription } from "@sqlbraid/core";
import type {
  ConnectionProvider,
  DriverRoutineResult,
  ExecutionEvent,
  QueryExecutor,
  RenderedStatement,
  StatementBindingAdapter,
  StandardSchemaV1,
} from "@sqlbraid/core";
import { DatabaseCardinalityError, createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: "runtime-observer-test",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "runtime-observer-test",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
})

function executor(): QueryExecutor {
  return {
    statementBinding,
    async query<Row>() { return { kind: "rows", rows: [{ id: 1 }] as unknown as readonly Row[] }; },
    async *stream<Row>(): AsyncGenerator<Row> { throw new Error("BRAID_STREAM_UNSUPPORTED"); },
    async call(): Promise<DriverRoutineResult> { throw new Error("BRAID_CALL_UNSUPPORTED"); },
  };
}

function schema(validate: StandardSchemaV1.Props<unknown, unknown>["validate"]): StandardSchemaV1<unknown, unknown> {
  return { "~standard": { version: 1, vendor: "observer-regression", validate } };
}

test("observers await registration order and cannot replace SQL or bind slots", async () => {
  const order: string[] = [];
  const secret = "conspicuous-private-bind";
  const query = sql.rows`SELECT ${secret}`;
  let received: readonly unknown[] = [];
  const db = createDatabase({
    statementBinding,
    async query<Row>(rendered: RenderedStatement) {
      order.push("driver");
      received = rendered.parameters.map((parameter) => parameter.value);
      assert.deepEqual(rendered.segments, query.render().segments);
      return { kind: "rows", rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> { throw new Error("BRAID_STREAM_UNSUPPORTED"); },
    async call(): Promise<DriverRoutineResult> { throw new Error("BRAID_CALL_UNSUPPORTED"); },
  }, { observers: [
    { async onEvent(event) {
      await Promise.resolve();
      order.push(`A:${event.type}`);
      if (event.type === "query:ready") {
        assert.deepEqual(event.values, [secret]);
        assert.deepEqual(event.execution, {
          adapterId: "runtime-observer-test",
          dialectId: "postgres",
          transport: "text-positional",
          reuse: { requested: "auto", effective: "simple", owner: "sqlbraid" },
        });
        assert.equal(Object.isFrozen(event.execution), true);
        assert.equal(Object.isFrozen(event.execution.reuse), true);
        assert.equal(event.sql, "SELECT $1");
        assert.equal(event.literalizedSql({ values: "inline" }).text, "SELECT 'conspicuous-private-bind'");
        assert.equal(Reflect.set(event.values, "0", "replacement"), false);
        assert.equal(Reflect.set(event, "sql", "DELETE FROM users"), false);
      }
    } },
    { onEvent(event) { order.push(`B:${event.type}`); } },
  ] });
  await db.execute(query);
  assert.deepEqual(received, [secret]);
  assert.deepEqual(order, ["A:query:ready", "B:query:ready", "driver", "A:query:result", "B:query:result", "A:query:mapped", "B:query:mapped"]);
});

test("audit failure prevents acquisition and SQL execution", async () => {
  const failure = new Error("audit unavailable");
  let acquisitions = 0;
  const events: ExecutionEvent[] = [];
  const provider: ConnectionProvider = { statementBinding, async acquire() { acquisitions += 1; return { ...executor(), release() {} }; } };
  const db = createPooledDatabase(provider, { observers: [{ onEvent(event) {
    events.push(event);
    if (event.type === "query:ready") throw failure;
  } }] });
  await assert.rejects(db.execute(sql`SELECT ${"secret"}`), (error) => error === failure);
  assert.equal(acquisitions, 0);
  const error = events.find((event) => event.type === "query:error");
  assert.ok(error?.type === "query:error");
  assert.equal(error.stage, "observer-before");
  assert.equal(error.executionStarted, false);
});

test("binding materialization fails before acquisition and reports the materialize stage", async () => {
  const failure = new Error("placeholder generation failed");
  let acquisitions = 0;
  const failingBinding = Object.freeze<StatementBindingAdapter>({
    id: "materialize-failure",
    describe() { throw failure; },
  })
  const events: ExecutionEvent[] = [];
  const db = createPooledDatabase({
    statementBinding: failingBinding,
    async acquire() {
      acquisitions += 1;
      throw new Error("must not acquire");
    },
  }, { observers: [{ onEvent(event) { events.push(event); } }] });

  await assert.rejects(db.execute(sql`SELECT ${1}`), (error) => error === failure);
  assert.equal(acquisitions, 0);
  const error = events.find((event) => event.type === "query:error");
  assert.ok(error?.type === "query:error");
  assert.equal(error.stage, "materialize");
  assert.equal(error.executionStarted, false);
  assert.equal(error.executionCompleted, false);
});

test("observer errors identify each pipeline stage and preserve thrown mapper errors", async () => {
  const stages = ["render", "acquire", "driver", "result-kind", "query-map", "execution-map", "observer-after", "release"] as const;
  for (const stage of stages) {
    const failure = new Error(stage);
    const events: ExecutionEvent[] = [];
    const db = createPooledDatabase({ statementBinding, async acquire() {
      if (stage === "acquire") throw failure;
      return {
        statementBinding,
        async query<Row>() {
          if (stage === "driver") throw failure;
          if (stage === "result-kind") return { kind: "command" as const, rows: [] as const, command: {} };
          return { kind: "rows" as const, rows: [{}] as unknown as readonly Row[] };
        },
        async *stream<Row>(): AsyncGenerator<Row> { throw new Error("BRAID_STREAM_UNSUPPORTED"); },
        async call(): Promise<DriverRoutineResult> { throw new Error("BRAID_CALL_UNSUPPORTED"); },
        release() { if (stage === "release") throw failure; },
      };
    } }, { observers: [{ onEvent(event) {
      events.push(event);
      if (stage === "observer-after" && event.type === "query:result") throw failure;
    } }] });
    const query = sql.rows(schema((value) => {
      if (stage === "query-map") throw failure;
      return { value };
    }))`SELECT 1`;
    const runnable = stage === "render" ? { ...query, render() { throw failure; } } : query;
    await assert.rejects(db.all(runnable, { schema: schema((value) => {
      if (stage === "execution-map") throw failure;
      return { value };
    }) }), (error) => stage === "result-kind" ? error instanceof Error && "code" in error && error.code === "BRAID_RESULT_KIND" : error === failure);
    const errors = events.filter((event) => event.type === "query:error");
    assert.equal(errors.length, 1, stage);
    assert.equal(errors[0].stage, stage);
    assert.equal(errors[0].executionStarted, !["render", "acquire"].includes(stage));
  }
});

test("observers distinguish result-kind mismatches from cardinality failures", async () => {
  const resultKindEvents: ExecutionEvent[] = [];
  const resultKindDb = createDatabase({
    statementBinding,
    async query() {
      return { kind: "command" as const, rows: [] as const, command: { affectedRows: 1 } };
    },
    async *stream<Row>(): AsyncGenerator<Row> { throw new Error("BRAID_STREAM_UNSUPPORTED"); },
    async call(): Promise<DriverRoutineResult> { throw new Error("BRAID_CALL_UNSUPPORTED"); },
  }, { observers: [{ onEvent(event) { resultKindEvents.push(event); } }] });
  await assert.rejects(resultKindDb.execute(sql.rows`UPDATE users SET active = 1`), (error) => (
    error instanceof Error
    && "code" in error
    && error.code === "BRAID_RESULT_KIND"
  ));
  const resultKindError = resultKindEvents.find((event) => event.type === "query:error");
  assert.ok(resultKindError?.type === "query:error");
  assert.equal(resultKindError.stage, "result-kind");
  assert.equal(resultKindError.executionStarted, true);
  assert.equal(resultKindError.executionCompleted, true);
  assert.equal("duration" in resultKindError, false);
  assert.equal(typeof resultKindError.durationMs, "number");
  assert.equal(resultKindEvents.some((event) => event.type === "query:result"), false);

  for (const [method, rows] of [["one", []], ["maybeOne", [{ id: 1 }, { id: 2 }]]] as const) {
    const events: ExecutionEvent[] = [];
    const db = createDatabase({
      statementBinding,
      async query<Row>() {
        return { kind: "rows" as const, rows: rows as readonly Row[] };
      },
      async *stream<Row>(): AsyncGenerator<Row> { throw new Error("BRAID_STREAM_UNSUPPORTED"); },
      async call(): Promise<DriverRoutineResult> { throw new Error("BRAID_CALL_UNSUPPORTED"); },
    }, { observers: [{ onEvent(event) { events.push(event); } }] });
    await assert.rejects(
      () => method === "one" ? db.one(sql.rows`SELECT id`) : db.maybeOne(sql.rows`SELECT id`),
      (error) => error instanceof DatabaseCardinalityError
        && error.expected === method
        && error.actual === rows.length,
    );
    const result = events.find((event) => event.type === "query:result");
    assert.ok(result?.type === "query:result");
    assert.equal(result.actualKind, "rows");
    const cardinalityError = events.find((event) => event.type === "query:error");
    assert.ok(cardinalityError?.type === "query:error");
    assert.equal(cardinalityError.stage, "cardinality");
    assert.equal(cardinalityError.executionStarted, true);
    assert.equal(cardinalityError.executionCompleted, true);
    assert.equal("duration" in cardinalityError, false);
    assert.equal(typeof cardinalityError.durationMs, "number");
  }
});

test("error observers preserve original failures including undefined rejection values", async () => {
  for (const original of [new Error("driver failed"), undefined]) {
    const reporting = new Error("error audit failed");
    let released = 0;
    const db = createPooledDatabase({ statementBinding, async acquire() {
      return {
        statementBinding,
        async query() { throw original; },
        async *stream<Row>(): AsyncGenerator<Row> { throw new Error("BRAID_STREAM_UNSUPPORTED"); },
        async call(): Promise<DriverRoutineResult> { throw new Error("BRAID_CALL_UNSUPPORTED"); },
        release() { released += 1; },
      };
    } }, { observers: [{ onEvent(event) { if (event.type === "query:error") throw reporting; } }] });
    await assert.rejects(db.execute(sql`SELECT 1`), (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === reporting);
    assert.equal(released, 1);
  }
});

test("prepared names and batch correlation survive result and mapping events", async () => {
  const events: ExecutionEvent[] = [];
  const db = createDatabase(executor(), { observers: [{ onEvent(event) { events.push(event); } }] });
  const query = sql.rows`SELECT 1`;
  await db.prepare("named-shape", () => query, { input: "none" }).execute();
  for (const event of events) {
    if (event.type === "query:ready" || event.type === "query:result" || event.type === "query:mapped") {
      assert.ok("preparedName" in event);
      assert.equal(event.preparedName, "named-shape");
      if (event.type !== "query:ready") {
        assert.equal("duration" in event, false);
        assert.equal(typeof event.durationMs, "number");
      }
    }
  }
  events.length = 0;
  await db.batch([query, query]);
  const ready = events.filter((event) => event.type === "query:ready");
  assert.equal(ready.length, 2);
  assert.notEqual(ready[0].operationId, ready[1].operationId);
  assert.equal(typeof ready[0].batchId, "string");
  assert.equal(ready[0].batchId, ready[1].batchId);
});

test("all public observer timing events use durationMs without a duration alias", async () => {
  const events: ExecutionEvent[] = [];
  const db = createDatabase({
    ...executor(),
    async begin() {},
    async commit() {},
    async rollback() {},
    async *stream<Row>(): AsyncGenerator<Row> {
      yield { id: 1 } as Row;
    },
  }, { observers: [{ onEvent(event) { events.push(event); } }] });

  await db.execute(sql.rows`SELECT 1`);
  await db.tx(async () => {});
  for await (const row of db.stream(sql.rows`SELECT 1`)) void row;

  for (const event of events) {
    if (event.type === "query:result"
      || event.type === "query:mapped"
      || event.type === "query:error"
      || event.type === "stream:end"
      || event.type === "transaction") {
      assert.equal(Object.hasOwn(event, "durationMs"), true);
      assert.equal("duration" in event, false);
      if (event.durationMs !== undefined) assert.equal(typeof event.durationMs, "number");
    }
  }
});

test("routine observers identify calls without guessing command kind from empty rows", async () => {
  const events: ExecutionEvent[] = [];
  const db = createDatabase({
    ...executor(),
    async call(): Promise<DriverRoutineResult> {
      return { output: {}, resultSets: [{ rows: [], source: { kind: "emitted", index: 0 } }] };
    },
  }, {
    observers: [{ onEvent(event) { events.push(event); } }],
  });
  await db.call(sql.call`CALL routine()`);
  const result = events.find((event) => event.type === "query:result");
  assert.ok(result?.type === "query:result");
  assert.equal(result.actualKind, "call");
});

test("generated kind mismatch errors never stringify private binds", async () => {
  const secret = "private-bind-never-render";
  const db = createDatabase(executor());
  await assert.rejects(db.execute(sql.command`UPDATE users SET secret = ${secret}`), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(secret), false);
    return "code" in error && error.code === "BRAID_RESULT_KIND";
  });
});

test("transaction and stream failures retain non-Error rejection values", async () => {
  const db = createDatabase({
    ...executor(),
    async begin() {},
    async commit() {},
    async rollback() {},
    async *stream<Row>(): AsyncGenerator<Row> { throw undefined; },
  });
  const transaction = await db.tx(async () => { throw undefined; }).then(
    () => ({ rejected: false }),
    (reason: unknown) => ({ rejected: true, reason }),
  );
  assert.deepEqual(transaction, { rejected: true, reason: undefined });
  const stream = await (async () => {
    for await (const row of db.stream(sql.rows`SELECT 1`)) void row;
  })().then(
    () => ({ rejected: false }),
    (reason: unknown) => ({ rejected: true, reason }),
  );
  assert.deepEqual(stream, { rejected: true, reason: undefined });
});

test("early stream return propagates lease cleanup and end observer failures", async () => {
  for (const failingStage of ["release", "observer"] as const) {
    const failure = new Error(failingStage);
    const db = createPooledDatabase({ statementBinding, async acquire() {
      return { ...executor(), async *stream<Row>() { yield 1 as Row; }, release() { if (failingStage === "release") throw failure; } };
    } }, { observers: [{ onEvent(event) { if (event.type === "stream:end" && failingStage === "observer") throw failure; } }] });
    await assert.rejects(async () => {
      for await (const row of db.stream(sql.rows`SELECT 1`)) { void row; break; }
    }, (error) => error === failure);
  }
});
