import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createStatementBindingDescription,
  type ConnectionProvider,
  type Database,
  type DriverRoutineResult,
  type ExecutionOptions,
  type PreparedQuery,
  type QueryExecutor,
  type RenderedStatement,
  type RowQuery,
  type StatementBindingAdapter,
  type StatementBindingDescription,
  type TransactionOptions,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { createDatabase, createPooledDatabase, DatabaseScopeError } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: "rc-runtime",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "rc-runtime",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});

function environment() {
  return {
    database: { product: "rc-runtime" },
    driver: { id: "rc-runtime", version: "1", profile: "test" },
    capabilities: {
      "session.pinned": { status: "guaranteed" as const },
      "statement.cancel": { status: "guaranteed" as const },
      transaction: { status: "guaranteed" as const },
      "transaction.savepoint": { status: "guaranteed" as const },
      "transaction.read-only": { status: "guaranteed" as const },
      "transaction.isolation.read-uncommitted": { status: "guaranteed" as const },
      "transaction.isolation.read-committed": { status: "guaranteed" as const },
      "transaction.isolation.repeatable-read": { status: "guaranteed" as const },
      "transaction.isolation.serializable": { status: "guaranteed" as const },
    },
  };
}

function rowsExecutor(log: string[], env = environment()): QueryExecutor {
  return {
    statementBinding,
    environment: env,
    async query<Row>(statement: RenderedStatement, _binding?: StatementBindingDescription, _options?: ExecutionOptions) {
      log.push(statement.segments.join("?"));
      if (statement.resultKind === "command") return { kind: "command", rows: [], command: { affectedRows: 1 } };
      return { kind: "rows", rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {},
    async call(): Promise<DriverRoutineResult> {
      return { output: {}, resultSets: [{ rows: [], source: { kind: "emitted", index: 0 } }] };
    },
    async begin(options?: TransactionOptions) { log.push(`begin:${JSON.stringify(options ?? null)}`); },
    async commit() { log.push("commit"); },
    async rollback() { log.push("rollback"); },
    async savepoint(name) { log.push(`savepoint:${name}`); },
    async rollbackTo(name) { log.push(`rollback-to:${name}`); },
    async releaseSavepoint(name) { log.push(`release:${name}`); },
  };
}

test("session pins one pooled lease, reuses it for nesting and session transactions, then closes", async () => {
  const log: string[] = [];
  let acquires = 0;
  let releases = 0;
  let leaked: Database | undefined;
  let prepared: PreparedQuery<number, RowQuery<unknown>> | undefined;
  let inert: AsyncIterable<unknown> | undefined;
  const provider: ConnectionProvider = {
    statementBinding,
    environment: environment(),
    async acquire() {
      acquires += 1;
      const executor = rowsExecutor(log);
      return {
        ...executor,
        release() { releases += 1; },
      };
    },
  };
  const db = createPooledDatabase(provider);
  await db.session(async (session) => {
    leaked = session;
    prepared = session.prepare("session-prepared", (value: number) => sql.rows`SELECT ${value}`);
    inert = session.stream(sql.rows`SELECT inert`);
    await session.execute(sql`SELECT one`);
    await session.session(async (nested) => {
      await nested.execute(sql`SELECT two`);
    });
    await session.tx(async (tx) => {
      await tx.execute(sql`SELECT three`);
      await tx.session(async (sameTx) => {
        await sameTx.execute(sql`SELECT four`);
      });
    });
  });
  assert.equal(acquires, 1);
  assert.equal(releases, 1);
  assert.deepEqual(log.slice(0, 6), ["SELECT one", "SELECT two", "begin:null", "SELECT three", "SELECT four", "commit"]);
  await assert.rejects(() => leaked!.execute(sql`SELECT closed`), (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_SESSION_CLOSED");
  await assert.rejects(() => prepared!.execute(1), (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_SESSION_CLOSED");
  await assert.rejects(() => inert![Symbol.asyncIterator]().next(), (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_SESSION_CLOSED");
});

test("outer pooled root use is rejected from a session callback", async () => {
  const db = createPooledDatabase({
    statementBinding,
    environment: environment(),
    async acquire() { return { ...rowsExecutor([]), release() {} }; },
  });
  await assert.rejects(db.session(async () => db.execute(sql`SELECT escaped`)), (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_SESSION_SCOPE");
});

test("prepared input queries cover row, command, and call kinds without construction-time invocation", async () => {
  const log: string[] = [];
  let factoryCalls = 0;
  const db = createDatabase(rowsExecutor(log));
  assert.throws(
    () => db.prepare("invalid-mode", () => sql.rows`SELECT 0`, { input: "invalid" } as never),
    (error: unknown) => error instanceof TypeError && error.message.includes("Prepared input mode"),
  );
  const byId = db.prepare("by-id", (id: number) => {
    factoryCalls += 1;
    return sql.rows`SELECT ${id}`;
  });
  assert.equal(factoryCalls, 0);
  await byId.execute(1);
  await byId.execute(2);
  assert.equal(factoryCalls, 2);
  const command = db.prepare("command", (input: { readonly id: number }) => sql.command`UPDATE users SET id = ${input.id}`);
  await command.execute({ id: 3 });
  const call = db.prepare("call", () => sql.call`CALL routine()`, { input: "none" });
  await call.call();
  assert.equal(log.length, 3);
});

test("prepared invocation modes keep input/options distinct for every query kind", async () => {
  const log: string[] = [];
  const db = createDatabase({
    ...rowsExecutor(log),
    async query<Row>(statement: RenderedStatement) {
      log.push(statement.segments.join("?"));
      if (statement.resultKind === "command") {
        return { kind: "command" as const, rows: [], command: { affectedRows: 1 } };
      }
      return {
        kind: "rows" as const,
        rows: [{ value: statement.parameters[0]?.value }] as unknown as readonly Row[],
      };
    },
    async call(statement: RenderedStatement) {
      log.push(statement.segments.join("?"));
      return { output: {}, resultSets: [{ rows: [], source: { kind: "emitted" as const, index: 0 } }] };
    },
  });
  const inputValues: unknown[] = [];
  const schemaCalls: unknown[] = [];
  const executionSchema = {
    "~standard": {
      version: 1,
      vendor: "prepared-invocation-test",
      validate(value: unknown) {
        schemaCalls.push(value);
        return { value };
      },
    },
  } satisfies import("@sqlbraid/core").StandardSchemaV1<unknown, unknown>;

  const normal = db.prepare("normal-input", (input: { readonly signal: string; readonly schema: string }) => {
    inputValues.push(input);
    return sql.rows`SELECT ${input.signal}`;
  });
  const rest = db.prepare(
    "rest-input",
    (...[input]: [{ readonly value: number }]) => sql.rows`SELECT ${input.value}`,
    { input: "required" },
  );
  const defaulted = db.prepare(
    "default-input",
    (input = "default") => sql.rows`SELECT ${input}`,
    { input: "required" },
  );
  const wrappedFactory = ((input: { readonly value: string }) => sql.rows`SELECT ${input.value}`) as
    (...args: [{ readonly value: string }]) => ReturnType<typeof sql.rows>;
  const wrapped = db.prepare("wrapped-input", wrappedFactory, { input: "required" });
  const command = db.prepare(
    "command-input",
    (input: { readonly value: number }) => sql.command`UPDATE users SET id = ${input.value}`,
  );
  const call = db.prepare(
    "call-input",
    (...[input]: [{ readonly value: string }]) => sql.call`CALL routine(${input.value})`,
    { input: "required" },
  );
  const zero = db.prepare("zero-input", () => sql.rows`SELECT 0`, { input: "none" });

  await normal.all({ signal: "ordinary", schema: "ordinary-schema" }, { schema: executionSchema });
  await rest.all({ value: 1 }, { schema: executionSchema });
  await defaulted.all("provided", { schema: executionSchema });
  await wrapped.all({ value: "wrapped" }, { schema: executionSchema });
  await command.execute({ value: 2 });
  await call.call({ value: "called" });
  await zero.execute();

  assert.deepEqual(inputValues, [{ signal: "ordinary", schema: "ordinary-schema" }]);
  assert.deepEqual(schemaCalls, [
    { value: "ordinary" },
    { value: 1 },
    { value: "provided" },
    { value: "wrapped" },
  ]);
  assert.equal(log.length, 7);
});

test("prepared execution options preflight before I/O without guessing application input fields", async () => {
  let queries = 0;
  let acquires = 0;
  const provider: ConnectionProvider = {
    statementBinding,
    environment: environment(),
    async acquire() {
      acquires += 1;
      return {
        ...rowsExecutor([]),
        async query<Row>() {
          queries += 1;
          return { kind: "rows" as const, rows: [] as readonly Row[] };
        },
        release() {},
      };
    },
  };
  const db = createPooledDatabase(provider);
  const reason = new Error("prepared-aborted");
  const controller = new AbortController();
  controller.abort(reason);

  const command = db.prepare("aborted-command", (input: { readonly signal: string }) =>
    sql.command`UPDATE users SET name = ${input.signal}`,
  );
  const rows = db.prepare(
    "aborted-rows",
    (...[input]: [{ readonly signal: string }]) => sql.rows`SELECT ${input.signal}`,
    { input: "required" },
  );
  const call = db.prepare("aborted-call", (input: { readonly signal: string }) =>
    sql.call`CALL routine(${input.signal})`,
  );

  await assert.rejects(
    () => command.execute({ signal: "application" }, { signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  await assert.rejects(
    () => rows.all({ signal: "application" }, { signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  await assert.rejects(
    () => call.call({ signal: "application" }, { signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  assert.equal(acquires, 0);
  assert.equal(queries, 0);
});

test("empty batch is a no-op with cancellation preflight and no lease lifecycle", async () => {
  let acquires = 0;
  let releases = 0;
  const provider: ConnectionProvider = {
    statementBinding,
    environment: environment(),
    async acquire() {
      acquires += 1;
      return { ...rowsExecutor([]), release() { releases += 1; } };
    },
  };
  const db = createPooledDatabase(provider);
  const result = await db.batch([]);
  assert.deepEqual(result, []);
  assert.equal(acquires, 0);
  assert.equal(releases, 0);

  const reason = new Error("empty-batch-aborted");
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(
    () => db.batch([], { signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  assert.equal(acquires, 0);
  assert.equal(releases, 0);
});

test("non-empty batch surfaces a lease cleanup failure", async () => {
  const releaseFailure = new Error("batch release failed");
  let releases = 0;
  const db = createPooledDatabase({
    statementBinding,
    environment: environment(),
    async acquire() {
      return {
        ...rowsExecutor([]),
        release() {
          releases += 1;
          throw releaseFailure;
        },
      };
    },
  });
  await assert.rejects(
    () => db.batch([sql`SELECT 1`]),
    (error: unknown) => error === releaseFailure,
  );
  assert.equal(releases, 1);
});

test("transaction options are forwarded, nested options reject, and malformed options fail before I/O", async () => {
  const log: string[] = [];
  const db = createDatabase(rowsExecutor(log));
  await db.tx({ isolation: "serializable", readOnly: true }, async () => undefined);
  assert.equal(log[0], "begin:{\"isolation\":\"serializable\",\"readOnly\":true}");
  const nestedDb = createDatabase(rowsExecutor(log));
  await nestedDb.tx(async (tx) => {
    await assert.rejects(tx.tx({}, async () => undefined), (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_TX_OPTIONS_NESTED");
  });
  const malformed = createDatabase(rowsExecutor(log));
  await assert.rejects(() => malformed.tx({ isolation: "invalid" } as never, async () => undefined), (error: unknown) => {
    return error instanceof TypeError && "code" in error && error.code === "BRAID_TX_OPTIONS_INVALID";
  });
});

test("active cancellation preflights before acquisition while pre-aborted returns its exact reason", async () => {
  let acquires = 0;
  const provider: ConnectionProvider = {
    statementBinding,
    async acquire() {
      acquires += 1;
      return { ...rowsExecutor([]), release() {} };
    },
  };
  const db = createPooledDatabase(provider);
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  await assert.rejects(() => db.execute(sql`SELECT aborted`, { signal: controller.signal }), (error: unknown) => error === reason);
  assert.equal(acquires, 0);

  const active = new AbortController();
  await assert.rejects(() => db.execute(sql`SELECT unsupported`, { signal: active.signal }), (error: unknown) => {
    return error instanceof UnsupportedFeatureError && error.feature === "statement.cancel" && error.code === "BRAID_CANCEL_UNSUPPORTED";
  });
  assert.equal(acquires, 0);
});

test("session capability rejection happens before pool acquisition", async () => {
  let acquires = 0;
  const provider: ConnectionProvider = {
    statementBinding,
    environment: { ...environment(), capabilities: { ...environment().capabilities, "session.pinned": { status: "unsupported" as const } } },
    async acquire() { acquires += 1; return { ...rowsExecutor([]), release() {} }; },
  };
  const db = createPooledDatabase(provider);
  await assert.rejects(() => db.session(async () => undefined), (error: unknown) => {
    return error instanceof UnsupportedFeatureError && error.feature === "session.pinned" && error.code === "BRAID_SESSION_UNSUPPORTED";
  });
  assert.equal(acquires, 0);
});

test("session preserves callback throws of undefined and null", async () => {
  const db = createDatabase(rowsExecutor([]));
  let undefinedFailure: unknown = Symbol("unset");
  try {
    await db.session(async () => { throw undefined; });
  } catch (error) {
    undefinedFailure = error;
  }
  assert.equal(undefinedFailure, undefined);
  let nullFailure: unknown = Symbol("unset");
  try {
    await db.session(async () => { throw null; });
  } catch (error) {
    nullFailure = error;
  }
  assert.equal(nullFailure, null);
});

test("a pending stream is tracked before observers and cannot acquire after session closure", async () => {
  let queries = 0;
  let pending!: Promise<IteratorResult<unknown>>;
  const observerStarted = Promise.withResolvers<void>();
  const observerGate = Promise.withResolvers<void>();
  const db = createPooledDatabase({
    statementBinding,
    environment: environment(),
    async acquire() {
      return {
        ...rowsExecutor([]),
        async query<Row>() {
          queries += 1;
          return { kind: "rows" as const, rows: [] as readonly Row[] };
        },
        release() {},
      };
    },
  }, {
    observers: [{
      async onEvent(event) {
        if (event.type === "stream:start") {
          observerStarted.resolve();
          await observerGate.promise;
        }
      },
    }],
  });
  await assert.rejects(() => db.session(async (session) => {
    pending = session.stream(sql.rows`SELECT pending`)[Symbol.asyncIterator]().next();
    await observerStarted.promise;
    setImmediate(observerGate.resolve);
  }), (error: unknown) => {
    return (error instanceof DatabaseScopeError && error.code === "BRAID_STREAM_SCOPE")
      || (error instanceof AggregateError && error.errors.some((item) => item instanceof DatabaseScopeError && item.code === "BRAID_STREAM_SCOPE"));
  });
  await assert.rejects(pending, (error: unknown) => error instanceof DatabaseScopeError && error.code === "BRAID_SESSION_CLOSED");
  assert.equal(queries, 0);
});
