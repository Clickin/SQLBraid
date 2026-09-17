import assert from "node:assert/strict";
import { test } from "vitest";
import { createStatementBindingDescription } from "@sqlbraid/core";
import type {
  ConnectionLease,
  ConnectionProvider,
  Database,
  DriverRoutineResult,
  ExecutionEvent,
  QueryExecutor,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingDescription,
  StandardSchemaV1,
} from "@sqlbraid/core";
import { sql } from "@sqlbraid/template";
import {
  createDatabase,
  createPooledDatabase,
  DatabaseResultValidationError,
  DatabaseScopeError,
} from "@sqlbraid/runtime";

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: "runtime-boundary-test",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "runtime-boundary-test",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});

function statementText(statement: RenderedStatement): string {
  return statement.segments.join("?");
}

function rowsExecutor(rows: readonly unknown[], calls: string[] = []): QueryExecutor {
  return {
    statementBinding,
    async query<Row>(rendered: RenderedStatement) {
      calls.push(statementText(rendered));
      return { kind: "rows" as const, rows: rows as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call(): Promise<DriverRoutineResult> {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
  };
}

function schema<Output>(
  validate: (_value: unknown) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<unknown, Output> {
  return { "~standard": { version: 1, vendor: "runtime-boundary-test", validate } };
}

test("materialized mappers run after the direct physical turn is released", async () => {
  let db!: Database;
  const mapper = schema(async (_value) => {
    const nested = await db.one(sql.rows<{ readonly id: number }>`SELECT nested`);
    return { value: { id: nested.id } };
  });
  db = createDatabase(rowsExecutor([{ id: 7 }]));
  const result = await db.execute(sql.rows(mapper)`SELECT outer`);
  assert.deepEqual(result.rows, [{ id: 7 }]);
}, 1000);

test("pooled roots lease independently and a batch holds one lease", async () => {
  const log: { acquired: string[]; released: { id: string; discard: boolean }[]; queries: string[] } = {
    acquired: [],
    released: [],
    queries: [],
  };
  const gate = Promise.withResolvers<void>();
  let running = 0;
  const provider: ConnectionProvider = {
    statementBinding,
    async acquire() {
      const id = `lease-${log.acquired.length}`;
      log.acquired.push(id);
      return {
        statementBinding,
        async query<Row>(rendered: RenderedStatement) {
          log.queries.push(`${id}:${statementText(rendered)}`);
          running += 1;
          if (running === 1) await gate.promise;
          running -= 1;
          return { kind: "rows" as const, rows: [] as readonly Row[] };
        },
        async *stream<Row>(): AsyncGenerator<Row> {
          throw new Error("BRAID_STREAM_UNSUPPORTED");
        },
        async call(): Promise<DriverRoutineResult> {
          throw new Error("BRAID_CALL_UNSUPPORTED");
        },
        release(options) {
          log.released.push({ id, discard: options?.discard === true });
        },
      };
    },
  };
  const db = createPooledDatabase(provider);
  const first = db.execute(sql`SELECT first`);
  const second = db.execute(sql`SELECT second`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(log.acquired.length, 2);
  gate.resolve();
  await Promise.all([first, second]);
  await db.batch([sql`SELECT batch_a`, sql`SELECT batch_b`]);
  assert.equal(log.acquired.length, 3);
  assert.equal(log.released.length, 3);
  assert.equal(log.queries.filter((query) => query.startsWith(log.acquired[2])).length, 2);
});

test("pooled transactions pin one lease, nest with savepoints, and reject root escape", async () => {
  const log: string[] = [];
  let releases = 0;
  const provider: ConnectionProvider = {
    statementBinding,
    async acquire() {
      const lease: ConnectionLease = {
        statementBinding,
        async query<Row>(rendered: RenderedStatement) {
          log.push(`query:${statementText(rendered)}`);
          return { kind: "rows" as const, rows: [] as readonly Row[] };
        },
        async *stream<Row>(): AsyncGenerator<Row> {
          throw new Error("BRAID_STREAM_UNSUPPORTED");
        },
        async call(): Promise<DriverRoutineResult> {
          throw new Error("BRAID_CALL_UNSUPPORTED");
        },
        async begin() {
          log.push("BEGIN");
        },
        async commit() {
          log.push("COMMIT");
        },
        async rollback() {
          log.push("ROLLBACK");
        },
        async savepoint(name) {
          log.push(`SAVEPOINT:${name}`);
        },
        async rollbackTo(name) {
          log.push(`ROLLBACK TO:${name}`);
        },
        async releaseSavepoint(name) {
          log.push(`RELEASE:${name}`);
        },
        release() {
          releases += 1;
        },
      };
      return lease;
    },
  };
  const db = createPooledDatabase(provider);
  await db.tx(async (tx) => {
    await tx.execute(sql`SELECT one`);
    await tx.tx(async (nested) => {
      await nested.execute(sql`SELECT two`);
    });
    await assert.rejects(
      () => db.execute(sql`SELECT escaped`),
      (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_TX_SCOPE",
    );
  });
  const savepoint = log.find((entry) => entry.startsWith("SAVEPOINT:"))!;
  assert.deepEqual(log.slice(0, 4), ["BEGIN", "query:SELECT one", savepoint, "query:SELECT two"]);
  assert.equal(log.at(-2), savepoint.replace("SAVEPOINT:", "RELEASE:"));
  assert.equal(log.at(-1), "COMMIT");
  assert.equal(releases, 1);
});

test("leaked transaction handles are closed and poisoned cleanup discards a lease", async () => {
  let leaked: Database | undefined;
  let releaseOptions: { readonly discard?: boolean } | undefined;
  let shouldFailCommit = false;
  const provider: ConnectionProvider = {
    statementBinding,
    async acquire() {
      return {
        statementBinding,
        async query<Row>() {
          return { kind: "rows" as const, rows: [] as readonly Row[] };
        },
        async *stream<Row>(): AsyncGenerator<Row> {
          throw new Error("BRAID_STREAM_UNSUPPORTED");
        },
        async call(): Promise<DriverRoutineResult> {
          throw new Error("BRAID_CALL_UNSUPPORTED");
        },
        async begin() {},
        async commit() {
          if (shouldFailCommit) throw new Error("commit failed");
        },
        async rollback() {},
        release(options) {
          releaseOptions = options;
        },
      };
    },
  };
  const db = createPooledDatabase(provider);
  await db.tx(async (tx) => {
    leaked = tx;
  });
  await assert.rejects(
    () => leaked!.execute(sql`SELECT leaked`),
    (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_TX_CLOSED",
  );
  shouldFailCommit = true;
  await assert.rejects(() => db.tx(async () => undefined), /commit failed/);
  assert.equal(releaseOptions?.discard, true);
});

test("stream leases release on completion, early return, mapping failure, and abort", async () => {
  const released: string[] = [];
  let index = 0;
  const provider: ConnectionProvider = {
    statementBinding,
    async acquire() {
      const id = `lease-${index++}`;
      return {
        statementBinding,
        async query<Row>() {
          return { kind: "rows" as const, rows: [] as readonly Row[] };
        },
        async *stream<Row>() {
          yield 1 as Row;
          yield 2 as Row;
        },
        async call(): Promise<DriverRoutineResult> {
          throw new Error("BRAID_CALL_UNSUPPORTED");
        },
        release() {
          released.push(id);
        },
      };
    },
  };
  const db = createPooledDatabase(provider);
  const all: number[] = [];
  for await (const row of db.stream(sql.rows<number>`SELECT stream`)) all.push(row);
  for await (const row of db.stream(sql.rows<number>`SELECT early`)) {
    void row;
    break;
  }
  const failing = schema<number>(() => ({ issues: [{ message: "bad row" }] }));
  await assert.rejects(async () => {
    for await (const row of db.stream(sql.rows(failing)`SELECT invalid`)) void row;
  }, DatabaseResultValidationError);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const acquiredBeforeAbort = index;
  await assert.rejects(async () => {
    for await (const row of db.stream(sql.rows<number>`SELECT abort`, { signal: controller.signal })) void row;
  }, /cancelled/);
  assert.deepEqual(all, [1, 2]);
  assert.equal(index, acquiredBeforeAbort, "a pre-aborted stream must not acquire a lease");
  assert.equal(released.length, index);
});

test("direct stream mapper re-entry fails with BRAID_STREAM_SCOPE instead of waiting", async () => {
  let db!: ReturnType<typeof createDatabase>;
  const mapper = schema(async (value) => {
    await db.execute(sql`SELECT nested`);
    return { value };
  });
  db = createDatabase({
    statementBinding,
    async query<Row>() {
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>() {
      yield 1 as Row;
    },
    async call(): Promise<DriverRoutineResult> {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
  });
  await assert.rejects(
    async () => {
      for await (const row of db.stream(sql.rows(mapper)`SELECT stream`)) void row;
    },
    (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_STREAM_SCOPE",
  );
});

test("all materialized row APIs and calls release exactly one root lease", async () => {
  let acquired = 0;
  let released = 0;
  const db = createPooledDatabase({
    statementBinding,
    async acquire() {
      acquired += 1;
      return {
        ...rowsExecutor([{ id: 1 }]),
        async call(): Promise<DriverRoutineResult> {
          return { output: {}, resultSets: [{ rows: [], source: { kind: "emitted", index: 0 } }] };
        },
        release() {
          released += 1;
        },
      };
    },
  });
  const query = sql.rows(
    schema((value) => {
      assert.equal(acquired, released, "mapping must not retain the lease");
      return { value };
    }),
  )`SELECT row`;
  await db.execute(query);
  await db.all(query);
  await db.one(query);
  await db.maybeOne(query);
  await db.call(sql.call`CALL routine()`);
  assert.equal(acquired, 5);
  assert.equal(released, 5);
});

test("pooled stream mapper reentry uses another lease while the cursor retains its own", async () => {
  let acquired = 0;
  let released = 0;
  const db = createPooledDatabase({
    statementBinding,
    async acquire() {
      acquired += 1;
      return {
        ...rowsExecutor([]),
        async *stream<Row>() {
          yield 1 as Row;
        },
        release() {
          released += 1;
        },
      };
    },
  });
  const mapper = schema(async (value) => {
    assert.equal(released, 0);
    await db.execute(sql`SELECT nested`);
    assert.equal(acquired, 2);
    assert.equal(released, 1);
    return { value };
  });
  const output = [];
  for await (const row of db.stream(sql.rows(mapper)`SELECT stream`)) output.push(row);
  assert.deepEqual(output, [1]);
  assert.equal(released, 2);
}, 1000);

test("pooled lease binding identity mismatch discards the lease before execution", async () => {
  const mismatchedBinding = Object.freeze<StatementBindingAdapter>({
    ...statementBinding,
    describe: statementBinding.describe,
  });
  let released: { readonly discard?: boolean } | undefined;
  let queries = 0;
  const events: ExecutionEvent[] = [];
  const db = createPooledDatabase(
    {
      statementBinding,
      async acquire() {
        return {
          statementBinding: mismatchedBinding,
          async query() {
            queries += 1;
            return { kind: "rows" as const, rows: [] as const };
          },
          async *stream<Row>(): AsyncGenerator<Row> {
            throw new Error("BRAID_STREAM_UNSUPPORTED");
          },
          async call(): Promise<DriverRoutineResult> {
            throw new Error("BRAID_CALL_UNSUPPORTED");
          },
          release(options) {
            released = options;
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
  );

  await assert.rejects(() => db.execute(sql`SELECT mismatch`), /BRAID_BINDING_IDENTITY/);
  assert.equal(queries, 0);
  assert.equal(released?.discard, true);
  const error = events.find((event) => event.type === "query:error");
  assert.equal(error?.type, "query:error");
  if (error?.type === "query:error") {
    assert.equal(error.stage, "materialize");
    assert.equal(error.executionStarted, false);
    assert.equal(error.executionCompleted, false);
  }
});

test("prepared invocation renders once and passes one binding description to execution", async () => {
  let renders = 0;
  let descriptions = 0;
  let receivedBinding: unknown;
  let describedBinding: unknown;
  let requestedReuse: string | undefined;
  const adapter = Object.freeze<StatementBindingAdapter>({
    id: "prepared-binding-test",
    describe(statement, context) {
      descriptions += 1;
      requestedReuse = context.requestedReuse;
      const description = createStatementBindingDescription(statement, context, {
        adapterId: "prepared-binding-test",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "sqlbraid" },
      });
      describedBinding = description;
      return description;
    },
  });
  const db = createDatabase({
    statementBinding: adapter,
    async query<Row>(_statement: RenderedStatement, binding?: StatementBindingDescription) {
      receivedBinding = binding;
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call(): Promise<DriverRoutineResult> {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
  });
  const prepared = db.prepare(
    "render-once",
    () => {
      const query = sql.rows`SELECT ${renders}`;
      return {
        ...query,
        render() {
          renders += 1;
          return query.render();
        },
      };
    },
    { input: "none" },
  );

  await prepared.execute();
  assert.equal(renders, 1);
  assert.equal(descriptions, 1);
  assert.equal(requestedReuse, "reuse");
  assert.equal(receivedBinding, describedBinding);
});

test("transaction stream consumer cannot run another pinned physical operation", async () => {
  const db = createDatabase({
    ...rowsExecutor([]),
    async begin() {},
    async commit() {},
    async rollback() {},
    async *stream<Row>() {
      yield 1 as Row;
    },
  });
  await db.tx(async (tx) => {
    for await (const row of tx.stream(sql.rows`SELECT stream`)) {
      void row;
      await assert.rejects(tx.execute(sql`SELECT overlap`), { code: "BRAID_STREAM_SCOPE" });
      break;
    }
    await tx.execute(sql`SELECT after_close`);
  });
}, 1000);
