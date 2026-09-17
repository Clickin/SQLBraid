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
});

function executor(): QueryExecutor {
  return {
    statementBinding,
    async query<Row>() {
      return { kind: "rows", rows: [{ id: 1 }] as unknown as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call(): Promise<DriverRoutineResult> {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
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
  const db = createDatabase(
    {
      statementBinding,
      async query<Row>(rendered: RenderedStatement) {
        order.push("driver");
        received = rendered.parameters.map((parameter) => parameter.value);
        assert.deepEqual(rendered.segments, query.render().segments);
        return { kind: "rows", rows: [] as readonly Row[] };
      },
      async *stream<Row>(): AsyncGenerator<Row> {
        throw new Error("BRAID_STREAM_UNSUPPORTED");
      },
      async call(): Promise<DriverRoutineResult> {
        throw new Error("BRAID_CALL_UNSUPPORTED");
      },
    },
    {
      observers: [
        {
          async onEvent(event) {
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
          },
        },
        {
          onEvent(event) {
            order.push(`B:${event.type}`);
          },
        },
      ],
    },
  );
  await db.execute(query);
  assert.deepEqual(received, [secret]);
  assert.deepEqual(order, [
    "A:query:ready",
    "B:query:ready",
    "driver",
    "A:query:result",
    "B:query:result",
    "A:query:mapped",
    "B:query:mapped",
  ]);
});

test("audit failure prevents acquisition and SQL execution", async () => {
  const failure = new Error("audit unavailable");
  let acquisitions = 0;
  const events: ExecutionEvent[] = [];
  const provider: ConnectionProvider = {
    statementBinding,
    async acquire() {
      acquisitions += 1;
      return { ...executor(), release() {} };
    },
  };
  const db = createPooledDatabase(provider, {
    observers: [
      {
        onEvent(event) {
          events.push(event);
          if (event.type === "query:ready") throw failure;
        },
      },
    ],
  });
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
    describe() {
      throw failure;
    },
  });
  const events: ExecutionEvent[] = [];
  const db = createPooledDatabase(
    {
      statementBinding: failingBinding,
      async acquire() {
        acquisitions += 1;
        throw new Error("must not acquire");
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

  await assert.rejects(db.execute(sql`SELECT ${1}`), (error) => error === failure);
  assert.equal(acquisitions, 0);
  const error = events.find((event) => event.type === "query:error");
  assert.ok(error?.type === "query:error");
  assert.equal(error.stage, "materialize");
  assert.equal(error.executionStarted, false);
  assert.equal(error.executionCompleted, false);
});

test("observer errors identify each pipeline stage and preserve thrown mapper errors", async () => {
  const stages = [
    "render",
    "acquire",
    "driver",
    "result-kind",
    "query-map",
    "execution-map",
    "observer-after",
    "release",
  ] as const;
  for (const stage of stages) {
    const failure = new Error(stage);
    const events: ExecutionEvent[] = [];
    const db = createPooledDatabase(
      {
        statementBinding,
        async acquire() {
          if (stage === "acquire") throw failure;
          return {
            statementBinding,
            async query<Row>() {
              if (stage === "driver") throw failure;
              if (stage === "result-kind") return { kind: "command" as const, rows: [] as const, command: {} };
              return { kind: "rows" as const, rows: [{}] as unknown as readonly Row[] };
            },
            async *stream<Row>(): AsyncGenerator<Row> {
              throw new Error("BRAID_STREAM_UNSUPPORTED");
            },
            async call(): Promise<DriverRoutineResult> {
              throw new Error("BRAID_CALL_UNSUPPORTED");
            },
            release() {
              if (stage === "release") throw failure;
            },
          };
        },
      },
      {
        observers: [
          {
            onEvent(event) {
              events.push(event);
              if (stage === "observer-after" && event.type === "query:result") throw failure;
            },
          },
        ],
      },
    );
    const query = sql.rows(
      schema((value) => {
        if (stage === "query-map") throw failure;
        return { value };
      }),
    )`SELECT 1`;
    const runnable =
      stage === "render"
        ? {
            ...query,
            render() {
              throw failure;
            },
          }
        : query;
    await assert.rejects(
      db.all(runnable, {
        schema: schema((value) => {
          if (stage === "execution-map") throw failure;
          return { value };
        }),
      }),
      (error) =>
        stage === "result-kind"
          ? error instanceof Error && "code" in error && error.code === "BRAID_RESULT_KIND"
          : error === failure,
    );
    const errors = events.filter((event) => event.type === "query:error");
    assert.equal(errors.length, 1, stage);
    assert.equal(errors[0].stage, stage);
    assert.equal(errors[0].executionStarted, !["render", "acquire"].includes(stage));
  }
});

test("observers distinguish result-kind mismatches from cardinality failures", async () => {
  const resultKindEvents: ExecutionEvent[] = [];
  const resultKindDb = createDatabase(
    {
      statementBinding,
      async query() {
        return { kind: "command" as const, rows: [] as const, command: { affectedRows: 1 } };
      },
      async *stream<Row>(): AsyncGenerator<Row> {
        throw new Error("BRAID_STREAM_UNSUPPORTED");
      },
      async call(): Promise<DriverRoutineResult> {
        throw new Error("BRAID_CALL_UNSUPPORTED");
      },
    },
    {
      observers: [
        {
          onEvent(event) {
            resultKindEvents.push(event);
          },
        },
      ],
    },
  );
  await assert.rejects(
    resultKindDb.execute(sql.rows`UPDATE users SET active = 1`),
    (error) => error instanceof Error && "code" in error && error.code === "BRAID_RESULT_KIND",
  );
  const resultKindError = resultKindEvents.find((event) => event.type === "query:error");
  assert.ok(resultKindError?.type === "query:error");
  assert.equal(resultKindError.stage, "result-kind");
  assert.equal(resultKindError.executionStarted, true);
  assert.equal(resultKindError.executionCompleted, true);
  assert.equal("duration" in resultKindError, false);
  assert.equal(typeof resultKindError.durationMs, "number");
  assert.equal(
    resultKindEvents.some((event) => event.type === "query:result"),
    false,
  );

  for (const [method, rows] of [
    ["one", []],
    ["maybeOne", [{ id: 1 }, { id: 2 }]],
  ] as const) {
    const events: ExecutionEvent[] = [];
    const db = createDatabase(
      {
        statementBinding,
        async query<Row>() {
          return { kind: "rows" as const, rows: rows as readonly Row[] };
        },
        async *stream<Row>(): AsyncGenerator<Row> {
          throw new Error("BRAID_STREAM_UNSUPPORTED");
        },
        async call(): Promise<DriverRoutineResult> {
          throw new Error("BRAID_CALL_UNSUPPORTED");
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
    await assert.rejects(
      () => (method === "one" ? db.one(sql.rows`SELECT id`) : db.maybeOne(sql.rows`SELECT id`)),
      (error) => error instanceof DatabaseCardinalityError && error.expected === method && error.actual === rows.length,
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
    const db = createPooledDatabase(
      {
        statementBinding,
        async acquire() {
          return {
            statementBinding,
            async query() {
              throw original;
            },
            async *stream<Row>(): AsyncGenerator<Row> {
              throw new Error("BRAID_STREAM_UNSUPPORTED");
            },
            async call(): Promise<DriverRoutineResult> {
              throw new Error("BRAID_CALL_UNSUPPORTED");
            },
            release() {
              released += 1;
            },
          };
        },
      },
      {
        observers: [
          {
            onEvent(event) {
              if (event.type === "query:error") throw reporting;
            },
          },
        ],
      },
    );
    await assert.rejects(
      db.execute(sql`SELECT 1`),
      (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === reporting,
    );
    assert.equal(released, 1);
  }
});

test("prepared names and batch correlation survive result and mapping events", async () => {
  const events: ExecutionEvent[] = [];
  const db = createDatabase(executor(), {
    observers: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
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
  const db = createDatabase(
    {
      ...executor(),
      async begin() {},
      async commit() {},
      async rollback() {},
      async *stream<Row>(): AsyncGenerator<Row> {
        yield { id: 1 } as Row;
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

  await db.execute(sql.rows`SELECT 1`);
  await db.tx(async () => {});
  for await (const row of db.stream(sql.rows`SELECT 1`)) void row;

  for (const event of events) {
    if (
      event.type === "query:result" ||
      event.type === "query:mapped" ||
      event.type === "query:error" ||
      event.type === "stream:end" ||
      event.type === "transaction"
    ) {
      assert.equal(Object.hasOwn(event, "durationMs"), true);
      assert.equal("duration" in event, false);
      if (event.durationMs !== undefined) assert.equal(typeof event.durationMs, "number");
    }
  }
});

test("routine observers identify calls without guessing command kind from empty rows", async () => {
  const events: ExecutionEvent[] = [];
  const db = createDatabase(
    {
      ...executor(),
      async call(): Promise<DriverRoutineResult> {
        return { output: {}, resultSets: [{ rows: [], source: { kind: "emitted", index: 0 } }] };
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
  await db.call(sql.call`CALL routine()`);
  const result = events.find((event) => event.type === "query:result");
  assert.ok(result?.type === "query:result");
  assert.equal(result.actualKind, "call");
});

test("malformed routine results emit one terminal error and release once", async () => {
  const malformedValues = [
    { output: {}, resultSets: [null] },
    { output: {}, resultSets: null },
    { output: {}, resultSets: [{ rows: null, source: { kind: "emitted", index: 0 } }] },
    { output: null, resultSets: [] },
    { output: {}, resultSets: [{ rows: [], source: null }] },
  ] as const;
  for (const [index, malformed] of malformedValues.entries()) {
    const events: ExecutionEvent[] = [];
    let releases = 0;
    const db =
      index === 0
        ? createPooledDatabase(
            {
              statementBinding,
              async acquire() {
                return {
                  ...executor(),
                  async call() {
                    return malformed as never;
                  },
                  release() {
                    releases += 1;
                  },
                };
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
          )
        : createDatabase(
            {
              ...executor(),
              async call() {
                return malformed as never;
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
    let original: unknown;
    await assert.rejects(
      () => db.call(sql.call`CALL malformed_${index}()`),
      (error: unknown) => {
        original = error;
        return error instanceof TypeError;
      },
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["query:ready", "query:error"],
    );
    const error = events[1];
    assert.equal(error?.type, "query:error");
    if (error?.type === "query:error") {
      assert.equal(error.stage, "result-kind");
      assert.equal(error.executionStarted, true);
      assert.equal(error.executionCompleted, true);
      assert.equal(error.error, original);
    }
    assert.equal(releases, index === 0 ? 1 : 0);
  }
});

test("malformed routine result preserves the original error with observer failures", async () => {
  const events: ExecutionEvent[] = [];
  const db = createDatabase(
    {
      ...executor(),
      async call() {
        return { output: {}, resultSets: [null] } as never;
      },
    },
    {
      observers: [
        {
          onEvent(event) {
            events.push(event);
            if (event.type === "query:error") throw new Error("error observer failed");
          },
        },
      ],
    },
  );
  await assert.rejects(
    () => db.call(sql.call`CALL malformed_observer()`),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.cause instanceof TypeError &&
      error.errors.some((entry) => entry instanceof Error && entry.message === "error observer failed") &&
      events[1]?.type === "query:error" &&
      events[1].error === error.cause,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["query:ready", "query:error"],
  );
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
    async *stream<Row>(): AsyncGenerator<Row> {
      throw undefined;
    },
  });
  const transaction = await db
    .tx(async () => {
      throw undefined;
    })
    .then(
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
    const db = createPooledDatabase(
      {
        statementBinding,
        async acquire() {
          return {
            ...executor(),
            async *stream<Row>() {
              yield 1 as Row;
            },
            release() {
              if (failingStage === "release") throw failure;
            },
          };
        },
      },
      {
        observers: [
          {
            onEvent(event) {
              if (event.type === "stream:end" && failingStage === "observer") throw failure;
            },
          },
        ],
      },
    );
    await assert.rejects(
      async () => {
        for await (const row of db.stream(sql.rows`SELECT 1`)) {
          void row;
          break;
        }
      },
      (error) => error === failure,
    );
  }
});

test("stream start observers remain fail-fast before acquisition", async () => {
  for (const prepared of [false, true]) {
    const failure = new Error("stream audit unavailable");
    const events: ExecutionEvent[] = [];
    let acquisitions = 0;
    const db = createPooledDatabase(
      {
        statementBinding,
        async acquire() {
          acquisitions += 1;
          return { ...executor(), release() {} };
        },
      },
      {
        observers: [
          {
            onEvent(event) {
              if (event.type === "stream:start") throw failure;
            },
          },
          {
            onEvent(event) {
              events.push(event);
            },
          },
        ],
      },
    );
    const stream = prepared
      ? db.prepare("stream-audit", () => sql.rows`SELECT 1`, { input: "none" }).stream()
      : db.stream(sql.rows`SELECT 1`);
    await assert.rejects(
      async () => {
        for await (const row of stream) void row;
      },
      (error) => error === failure,
    );
    assert.equal(acquisitions, 0);
    assert.equal(
      events.some((event) => event.type === "stream:start"),
      false,
    );
    const error = events.find((event) => event.type === "query:error");
    assert.ok(error?.type === "query:error");
    assert.equal(error.stage, "observer-before");
    assert.equal(error.error, failure);
  }
});

test("stream end reaches every observer once and preserves ordered failures", async () => {
  for (const prepared of [false, true]) {
    for (const path of ["completed", "driver", "iterator", "release"] as const) {
      const original = new Error(path);
      const first = new Error("first terminal observer");
      const last = new Error("last terminal observer");
      const order: string[] = [];
      const terminal: ExecutionEvent[] = [];
      const active = new Set<string>();
      let released = 0;
      const db = createPooledDatabase(
        {
          statementBinding,
          async acquire() {
            return {
              ...executor(),
              stream<Row>(): AsyncIterable<Row> {
                let yielded = false;
                return {
                  [Symbol.asyncIterator]() {
                    return {
                      async next(): Promise<IteratorResult<Row>> {
                        if (path === "driver") throw original;
                        if (yielded) return { done: true, value: undefined };
                        yielded = true;
                        return { done: false, value: 1 as Row };
                      },
                      async return(): Promise<IteratorResult<Row>> {
                        if (path === "iterator") throw original;
                        return { done: true, value: undefined };
                      },
                    };
                  },
                };
              },
              release() {
                released += 1;
                if (path === "release") throw original;
              },
            };
          },
        },
        {
          observers: [
            {
              async onEvent(event) {
                if (event.type !== "stream:end") return;
                order.push("first");
                await Promise.resolve();
                throw first;
              },
            },
            {
              onEvent(event) {
                if (event.type !== "stream:end") return;
                order.push("recording");
                terminal.push(event);
              },
            },
            {
              onEvent(event) {
                if (event.type === "stream:start") active.add(event.operationId);
                if (event.type !== "stream:end") return;
                order.push("stateful");
                assert.equal(active.delete(event.operationId), true);
              },
            },
            {
              onEvent(event) {
                if (event.type !== "stream:end") return;
                order.push("last");
                throw last;
              },
            },
          ],
        },
      );
      const stream = prepared
        ? db.prepare("terminal-fanout", () => sql.rows`SELECT 1`, { input: "none" }).stream()
        : db.stream(sql.rows`SELECT 1`);
      await assert.rejects(
        async () => {
          for await (const row of stream) void row;
        },
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, path === "completed" ? [first, last] : [original, first, last]);
          assert.equal(error.cause, path === "completed" ? first : original);
          return true;
        },
      );
      assert.deepEqual(order, ["first", "recording", "stateful", "last"]);
      assert.equal(active.size, 0);
      assert.equal(released, 1);
      assert.equal(terminal.length, 1);
      const end = terminal[0];
      assert.ok(end?.type === "stream:end");
      assert.equal(Object.isFrozen(end), true);
      assert.equal(end.status, path === "completed" ? "completed" : "error");
      assert.equal(end.error, path === "completed" ? undefined : original);
    }
  }
});

test("prepared streams defer the factory and preparation until consumption", async () => {
  let factoryCalls = 0;
  let streamCalls = 0;
  const events: ExecutionEvent[] = [];
  const db = createDatabase(
    {
      ...executor(),
      async *stream<Row>() {
        streamCalls += 1;
        yield 1 as Row;
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
  const prepared = db.prepare(
    "lazy-stream",
    () => {
      factoryCalls += 1;
      return sql.rows`SELECT 1`;
    },
    { input: "none" },
  );

  const stream = prepared.stream();
  assert.equal(factoryCalls, 0);
  assert.equal(streamCalls, 0);
  assert.deepEqual(events, []);

  const iterator = stream[Symbol.asyncIterator]();
  assert.equal(factoryCalls, 0);
  assert.deepEqual(await iterator.next(), { value: 1, done: false });
  assert.equal(factoryCalls, 1);
  assert.equal(streamCalls, 1);
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.equal(factoryCalls, 1);
  assert.equal(events.filter((event: ExecutionEvent) => event.type === "query:ready").length, 1);
  assert.equal(events.filter((event: ExecutionEvent) => event.type === "stream:start").length, 1);
  assert.equal(events.filter((event: ExecutionEvent) => event.type === "stream:end").length, 1);

  const factoryError = new Error("prepared stream factory failed");
  const failingQuery = sql.rows`SELECT 1`;
  const failing = db.prepare(
    "lazy-failure",
    (): typeof failingQuery => {
      throw factoryError;
    },
    { input: "none" },
  );
  const failureStream = failing.stream();
  await assert.rejects(
    async () => {
      for await (const row of failureStream) void row;
    },
    (error) => error === factoryError,
  );
});

test("prepared stream terminal paths release once and preserve consumer failures", async () => {
  let released = 0;
  const pooled = createPooledDatabase({
    statementBinding,
    async acquire() {
      return {
        ...executor(),
        async *stream<Row>() {
          yield 1 as Row;
          yield 2 as Row;
        },
        release() {
          released += 1;
        },
      };
    },
  });
  const prepared = pooled.prepare("break-stream", () => sql.rows`SELECT 1`, { input: "none" });
  for await (const row of prepared.stream()) {
    assert.equal(row, 1);
    break;
  }
  assert.equal(released, 1);

  const mappingError = new Error("prepared stream mapper failed");
  const mappingDb = createDatabase({
    ...executor(),
    async *stream<Row>() {
      yield 1 as Row;
    },
  });
  const mapped = mappingDb.prepare(
    "mapped-stream",
    () =>
      sql.rows(
        schema(() => {
          throw mappingError;
        }),
      )`SELECT 1`,
    { input: "none" },
  );
  await assert.rejects(
    async () => {
      for await (const row of mapped.stream()) void row;
    },
    (error) => error === mappingError,
  );

  const abortReason = new Error("prepared stream aborted before acquisition");
  const controller = new AbortController();
  controller.abort(abortReason);
  let acquired = 0;
  const abortDb = createPooledDatabase({
    statementBinding,
    async acquire() {
      acquired += 1;
      return { ...executor(), release() {} };
    },
  });
  const abortPrepared = abortDb.prepare("abort-stream", () => sql.rows`SELECT 1`, { input: "none" });
  await assert.rejects(
    async () => {
      for await (const row of abortPrepared.stream({ signal: controller.signal })) void row;
    },
    (error) => error === abortReason,
  );
  assert.equal(acquired, 0);

  const driverError = new Error("prepared stream driver failed");
  const driverDb = createDatabase({
    ...executor(),
    async *stream<_Row>() {
      throw driverError;
    },
  });
  const driverPrepared = driverDb.prepare("driver-stream", () => sql.rows`SELECT 1`, { input: "none" });
  await assert.rejects(
    async () => {
      for await (const row of driverPrepared.stream()) void row;
    },
    (error) => error === driverError,
  );

  const cleanupError = new Error("prepared stream cleanup failed");
  const cleanupDb = createPooledDatabase({
    statementBinding,
    async acquire() {
      return {
        ...executor(),
        async *stream<Row>() {
          yield 1 as Row;
        },
        release() {
          throw cleanupError;
        },
      };
    },
  });
  const cleanupPrepared = cleanupDb.prepare("cleanup-stream", () => sql.rows`SELECT 1`, { input: "none" });
  await assert.rejects(
    async () => {
      for await (const row of cleanupPrepared.stream()) void row;
    },
    (error) => error === cleanupError,
  );
});

test("prepared stream aborts after a row and reports observer failures to the consumer", async () => {
  const events: ExecutionEvent[] = [];
  const observerError = new Error("prepared stream observer failed");
  const db = createDatabase(
    {
      ...executor(),
      async *stream<Row>() {
        yield 1 as Row;
        yield 2 as Row;
      },
    },
    {
      observers: [
        {
          onEvent(event) {
            events.push(event);
            if (event.type === "stream:start") throw observerError;
          },
        },
      ],
    },
  );
  const prepared = db.prepare("observer-stream", () => sql.rows`SELECT 1`, { input: "none" });
  await assert.rejects(
    async () => {
      for await (const row of prepared.stream()) void row;
    },
    (error) => error === observerError,
  );
  assert.equal(events.filter((event) => event.type === "stream:start").length, 1);
  assert.equal(events.filter((event) => event.type === "query:error").length, 1);

  const controller = new AbortController();
  const abortDb = createDatabase({
    ...executor(),
    environment: {
      database: { product: "prepared-stream-test" },
      driver: { id: "prepared-stream-test" },
      capabilities: {
        "statement.cancel": { status: "guaranteed" },
        "statement.stream": { status: "guaranteed" },
      },
    },
    async *stream<Row>() {
      yield 1 as Row;
      yield 2 as Row;
    },
  });
  const abortPrepared = abortDb.prepare("abort-after-row", () => sql.rows`SELECT 1`, { input: "none" });
  const output: unknown[] = [];
  const abortReason = new Error("prepared stream aborted after row");
  await assert.rejects(
    async () => {
      for await (const row of abortPrepared.stream({ signal: controller.signal })) {
        output.push(row);
        controller.abort(abortReason);
      }
    },
    (error) => error === abortReason,
  );
  assert.deepEqual(output, [1]);
});

test("prepared stream shape mismatch is delivered on consumption", async () => {
  let alternate = false;
  const events: ExecutionEvent[] = [];
  const db = createDatabase(
    {
      ...executor(),
      async *stream<Row>() {
        yield 1 as Row;
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
  const prepared = db.prepare(
    "shape-stream",
    () => {
      alternate = !alternate;
      return alternate ? sql.rows`SELECT 1` : sql.rows`SELECT 1, 2`;
    },
    { input: "none" },
  );
  for await (const row of prepared.stream()) void row;
  await assert.rejects(
    async () => {
      for await (const row of prepared.stream()) void row;
    },
    (error) => error instanceof Error && "code" in error && error.code === "BRAID_PREPARED_SHAPE",
  );
  assert.equal(events.filter((event) => event.type === "stream:start").length, 1);
  assert.equal(events.filter((event) => event.type === "query:error").length, 1);
});
