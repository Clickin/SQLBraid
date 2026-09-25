import assert from "node:assert/strict";
import { test } from "vitest";
import { UnsupportedFeatureError } from "@sqlbraid/core";
import type {
  Mysql2ConnectionLike,
  Mysql2FieldLike,
  Mysql2PoolConnectionLike,
  Mysql2RawCommandLike,
  Mysql2RawConnectionLike,
  Mysql2RawStreamLike,
} from "@sqlbraid/mysql/mysql2";
import { createMysql2Executor, createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import type {
  PgClientLike,
  PgCursorFactory,
  PgCursorLike,
  PgPoolClientLike,
  PgResultLike,
} from "@sqlbraid/postgres/pg";
import { createPgDatabase, createPgExecutor, createPgPoolDatabase, pgStatementBinding } from "@sqlbraid/postgres/pg";
import { postgresParameter, sql as pgSql } from "@sqlbraid/postgres";
import { sql as mysqlSql, typePolicy as mysqlTypePolicy } from "@sqlbraid/mysql";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { runStreamingConformance } from "./streaming-conformance.js";

class Cursor implements PgCursorLike {
  static rows: readonly unknown[] = [[1], [2]];
  static closes = 0;
  static config: unknown;
  constructor(_text: string, _values: readonly unknown[], config?: unknown) {
    Cursor.config = config;
  }
  read(_size: number, callback: (error: unknown, rows?: readonly unknown[], result?: PgResultLike) => void): void {
    callback(null, Cursor.rows, { rows: Cursor.rows, fields: [{ name: "id", dataTypeID: 20 }] });
    Cursor.rows = [];
  }
  close(callback: (error?: unknown) => void): void {
    Cursor.closes += 1;
    callback();
  }
}

const cursorFactory = Cursor as unknown as PgCursorFactory;

test("PostgreSQL OUT parameters are rejected outside calls before driver I/O", async () => {
  let queryCalls = 0;
  const client: PgClientLike = {
    async query() {
      queryCalls += 1;
      return { rows: [], fields: [] };
    },
    escapeIdentifier: (value) => `"${value}"`,
    escapeLiteral: (value) => `'${value}'`,
  };
  const executor = createPgExecutor(client);
  await assert.rejects(
    async () => executor.query(pgSql.rows`SELECT ${pgSql.out("value")}`.render()),
    (error: unknown) =>
      error instanceof UnsupportedFeatureError &&
      error.feature === "routine.out" &&
      error.code === "BRAID_CALL_OUT_UNSUPPORTED",
  );
  assert.equal(queryCalls, 0);
});

test("Pooled MySQL OUT and INOUT parameters are rejected before lease acquisition", async () => {
  let acquisitions = 0;
  const db = createMysql2PoolDatabase({
    getConnection: async () => {
      acquisitions += 1;
      throw new Error("MySQL pool acquisition must not run for unsupported routine parameters.");
    },
  });
  for (const parameter of [mysqlSql.out("value"), mysqlSql.inOut("value", 1)]) {
    // oxlint-disable-next-line no-await-in-loop -- Check OUT then INOUT against the same untouched pool before inspecting acquisitions.
    await assert.rejects(
      () => db.call(mysqlSql.call`CALL routine(${parameter})`),
      (error: unknown) =>
        error instanceof UnsupportedFeatureError &&
        error.feature === (parameter.direction === "out" ? "routine.out" : "routine.inout") &&
        error.code === "BRAID_CALL_OUT_UNSUPPORTED",
    );
  }
  assert.equal(acquisitions, 0);
});

test("PostgreSQL abort interrupts a pending read and waits for physical termination before discard", async () => {
  const reading = Promise.withResolvers<void>();
  const ending = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const releases: boolean[] = [];
  class PendingCursor implements PgCursorLike {
    read(): void {
      reading.resolve();
    }
    close(callback: (error?: unknown) => void): void {
      callback();
    }
  }
  const client = {
    query(value: unknown) {
      return value;
    },
    escapeIdentifier: (value: string) => `"${value}"`,
    escapeLiteral: (value: string) => `'${value}'`,
    end() {
      ending.resolve();
      return ended.promise;
    },
    release(discard = false) {
      releases.push(discard);
    },
  } as unknown as PgPoolClientLike;
  const db = createPgPoolDatabase(
    { connect: async () => client },
    {
      cursor: PendingCursor as unknown as PgCursorFactory,
    },
  );
  const controller = new AbortController();
  const reason = new Error("cancel pending PostgreSQL read");
  const iterator = db.stream(pgSql.rows`SELECT pg_sleep(60)`, { signal: controller.signal })[Symbol.asyncIterator]();
  const next = iterator.next();
  await reading.promise;
  controller.abort(reason);
  await ending.promise;
  assert.deepEqual(releases, []);
  ended.resolve();
  await assert.rejects(next, (error: unknown) => error instanceof Error && error.cause === reason);
  assert.deepEqual(releases, [true]);
});

test("PostgreSQL cursor metadata preserves exact int8 values and closes on exhaustion", async () => {
  Cursor.rows = [["9007199254740993"], ["9007199254740994"]];
  Cursor.closes = 0;
  const client = {
    query(value: unknown) {
      if (typeof value === "object") return value;
      return Promise.resolve({ rows: [], fields: [] });
    },
    escapeIdentifier: (value: string) => `"${value}"`,
    escapeLiteral: (value: string) => `'${value}'`,
  } as unknown as PgClientLike;
  const executor = createPgExecutor(client, { cursor: cursorFactory, streamBatchSize: 2 });
  const rows: unknown[] = [];
  for await (const row of executor.stream(pgSql.rows`SELECT 1 AS id`.render())) rows.push(row);
  assert.deepEqual(rows, [{ id: "9007199254740993" }, { id: "9007199254740994" }]);
  assert.equal((Cursor.config as { rowMode?: string }).rowMode, "array");
  assert.ok("types" in (Cursor.config as object));
  assert.equal(Cursor.closes, 1);
});

test("PostgreSQL materialized and prepared queries project positional rows using field metadata", async () => {
  const fields = [
    { name: "__proto__", dataTypeID: 20 },
    { name: "constructor", dataTypeID: 1700 },
    { name: "名", dataTypeID: 25 },
    { name: "payload", dataTypeID: 17 },
  ];
  const binary = new Uint8Array([1, 2, 3]);
  let rawRows: readonly unknown[] = [["9007199254740993", "12345678901234567890.125", null, binary]];
  const configs: Array<{ readonly text: string; readonly rowMode?: string; readonly name?: string }> = [];
  const client = {
    async query(config: unknown) {
      if (typeof config === "object" && config !== null && "text" in config) {
        configs.push(config as (typeof configs)[number]);
      }
      return { rows: rawRows, fields };
    },
    escapeIdentifier: (value: string) => `"${value}"`,
    escapeLiteral: (value: string) => `'${value}'`,
  } as unknown as PgClientLike;
  const db = createPgDatabase(client);
  const query = pgSql.rows`SELECT result`.render();
  const prepared = db.prepare("positional", () => pgSql.rows`SELECT result`, { input: "none" });
  const materialized = await createPgExecutor(client).query(query);
  const preparedRows = await prepared.all();
  for (const rows of [materialized.rows, preparedRows]) {
    assert.equal(rows.length, 1);
    const row = rows[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(row), ["__proto__", "constructor", "名", "payload"]);
    assert.equal(Object.getOwnPropertyDescriptor(row, "__proto__")?.value, "9007199254740993");
    assert.equal(row.constructor, "12345678901234567890.125");
    assert.equal(row["名"], null);
    assert.deepEqual(row.payload, binary);
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
  }
  assert.equal(configs.length, 2);
  assert.ok(configs.every((config) => config.rowMode === "array"));
  assert.ok(configs.every((config) => config.name === undefined || config.name === "positional"));

  rawRows = [];
  assert.deepEqual((await createPgExecutor(client).query(query)).rows, []);
});

test("PostgreSQL refcursor binding is rejected before root I/O", () => {
  const rendered = pgSql.call`CALL read_users(${pgSql.out("users", postgresParameter.refcursor())})`.render();
  assert.throws(
    () => pgStatementBinding.describe(rendered, { dialectId: "postgres", requestedReuse: "auto" }),
    (error: unknown) => error instanceof Error && error.message.includes("BRAID_CALL_CURSOR_TX_REQUIRED"),
  );
});

test("PostgreSQL logical output names cannot select a different physical carrier column", async () => {
  const client: PgClientLike = {
    async query() {
      return {
        rows: [["9007199254740993", "text output"]],
        fields: [
          { name: "first", dataTypeID: 20 },
          { name: "second", dataTypeID: 25 },
        ],
      };
    },
    escapeIdentifier: (value) => `"${value}"`,
    escapeLiteral: (value) => `'${value}'`,
  };
  const result = await createPgExecutor(client).call(
    pgSql.call`
    CALL outputs(${pgSql.out("second")}, ${pgSql.out("first")})
  `.render(),
  );
  assert.deepEqual(result.output, { second: "9007199254740993", first: "text output" });
});

test("MySQL materialized queries reject nested result sets, including empty sets and status headers", async () => {
  let payload: unknown = [[{ USER_ID: 1 }], [{ PAYMENT_ID: 10 }], { affectedRows: 0 }];
  const connection: Mysql2ConnectionLike = {
    execute: async () => [payload, [[{ name: "USER_ID", type: 3 }], [{ name: "PAYMENT_ID", type: 3 }]]],
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
  const executor = createMysql2Executor(connection);
  const query = mysqlSql.rows`SELECT driver_result`.render();
  await assert.rejects(async () => executor.query(query), /BRAID_RESULT_SETS_UNSUPPORTED/u);
  payload = [[], [], { affectedRows: 0 }];
  await assert.rejects(async () => executor.query(query), /BRAID_RESULT_SETS_UNSUPPORTED/u);
});

test("MySQL materialized queries preserve flat rows, empty SELECTs and command metadata", async () => {
  let payload: unknown = [{ USER_ID: 1 }, { USER_ID: 2 }];
  const connection: Mysql2ConnectionLike = {
    execute: async () => [payload, [{ name: "USER_ID", type: 3 }]],
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
  const executor = createMysql2Executor(connection);
  const query = mysqlSql`SELECT driver_result`.render();
  assert.deepEqual(await executor.query(query), {
    kind: "rows",
    rows: [{ USER_ID: "1" }, { USER_ID: "2" }],
    rowCount: 2,
  });
  payload = [];
  assert.deepEqual(await executor.query(query), { kind: "rows", rows: [], rowCount: 0 });
  payload = { affectedRows: 2, insertId: 10, warningStatus: 1 };
  assert.deepEqual(await executor.query(mysqlSql.command`UPDATE driver_result`.render()), {
    kind: "command",
    rows: [],
    rowCount: 2,
    command: { affectedRows: 2, insertId: "10", warningStatus: 1 },
  });
});

test("MySQL rows map rowsAsArray payloads and fail closed for lossy numeric typeCast results", async () => {
  let payload: unknown = [[1]];
  let fields: readonly Mysql2FieldLike[] = [{ name: "id", type: 3 }];
  const connection: Mysql2ConnectionLike = {
    execute: async () => [payload, fields],
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
  const executor = createMysql2Executor(connection);
  assert.deepEqual(await executor.query(mysqlSql.rows`SELECT id`.render()), {
    kind: "rows",
    rows: [{ id: "1" }],
    rowCount: 1,
  });
  payload = [{ id: 9_007_199_254_740_992 }];
  fields = [{ name: "id", type: 8 }];
  await assert.rejects(async () => executor.query(mysqlSql.rows`SELECT id`.render()), {
    code: "BRAID_RESULT_EXACTNESS",
  });
});

class RowsStream implements Mysql2RawStreamLike {
  readonly readableEnded = false;
  readonly destroyed = false;
  private readonly values: readonly unknown[] = [{ amount: "1.25" }, { amount: "2.5" }];
  private index = 0;
  once(event: string, listener: (...args: readonly unknown[]) => void): this {
    if (event === "fields") listener([{ name: "amount", type: 246 }]);
    return this;
  }
  resume(): this {
    return this;
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () =>
        this.index < this.values.length
          ? { done: false, value: this.values[this.index++] }
          : { done: true, value: undefined },
    };
  }
}

class FieldsBoundaryStream implements Mysql2RawStreamLike {
  readonly readableEnded = false;
  readonly destroyed = false;
  private fieldsListener: ((...args: readonly unknown[]) => void) | undefined;
  private step = 0;
  drained = false;

  constructor(
    private readonly secondFields: readonly Mysql2FieldLike[],
    private readonly secondRow?: unknown,
    private readonly terminalError?: unknown,
  ) {}

  on(event: string, listener: (...args: readonly unknown[]) => void): this {
    if (event === "fields") this.fieldsListener = listener;
    return this;
  }

  once(event: string, listener: (...args: readonly unknown[]) => void): this {
    return this.on(event, listener);
  }

  resume(): this {
    return this;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        const step = this.step++;
        if (step === 0) {
          this.fieldsListener?.([{ name: "value", type: "FIRST" }]);
          return { done: false, value: { value: "first" } };
        }
        if (step === 1) {
          this.fieldsListener?.(this.secondFields);
          if (this.terminalError !== undefined) throw this.terminalError;
          if (this.secondRow !== undefined) return { done: false, value: this.secondRow };
        }
        this.drained = true;
        return { done: true, value: undefined };
      },
    };
  }
}

test("MySQL streaming preserves exact DECIMAL text without materialization and rejects OUT before I/O", async () => {
  let executeCalls = 0;
  let requestedHighWaterMark: number | undefined;
  const raw: Mysql2RawConnectionLike = {
    execute: () =>
      ({
        stream: (options?: { readonly highWaterMark?: number }) => {
          requestedHighWaterMark = options?.highWaterMark;
          return new RowsStream();
        },
      }) as Mysql2RawCommandLike,
    destroy: () => undefined,
  };
  const connection = {
    connection: raw,
    execute: async () => {
      executeCalls += 1;
      return [[], []] as const;
    },
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  } as unknown as Mysql2ConnectionLike;
  const executor = createMysql2Executor(connection, { streamHighWaterMark: 3 });
  const rows: unknown[] = [];
  for await (const row of executor.stream(mysqlSql.rows`SELECT 1 AS id`.render())) rows.push(row);
  assert.deepEqual(rows, [{ amount: "1.25" }, { amount: "2.5" }]);
  assert.equal(requestedHighWaterMark, 3);
  const call = mysqlSql.call`CALL routine(${mysqlSql.out("answer")})`.render();
  await assert.rejects(async () => executor.call(call), /BRAID_CALL_OUT_UNSUPPORTED/);
  assert.equal(executeCalls, 0);
});

test("MySQL streaming preserves first metadata and rejects queued rows from a second result set", async () => {
  const source = new FieldsBoundaryStream([{ name: "value", type: "SECOND" }], { value: "second" });
  const raw: Mysql2RawConnectionLike = {
    execute: () => ({ stream: () => source }) as Mysql2RawCommandLike,
    destroy: () => undefined,
  };
  const connection = {
    connection: raw,
    execute: async () => [[], []] as const,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  } as unknown as Mysql2ConnectionLike;
  const executor = createMysql2Executor(connection, {
    typePolicy: {
      ...mysqlTypePolicy,
      decode: (databaseType, value) => `${databaseType}:${String(value)}`,
    },
  });
  const iterator = executor.stream(mysqlSql.rows`SELECT value FROM first_set`.render())[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: { value: "FIRST:first" } });
  await assert.rejects(() => iterator.next(), /BRAID_RESULT_SETS_UNSUPPORTED/u);
  assert.equal(source.drained, true);
});

test("MySQL streaming reports an empty second result set after iterator completion", async () => {
  const source = new FieldsBoundaryStream([]);
  const raw: Mysql2RawConnectionLike = {
    execute: () => ({ stream: () => source }) as Mysql2RawCommandLike,
    destroy: () => undefined,
  };
  const connection = {
    connection: raw,
    execute: async () => [[], []] as const,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  } as unknown as Mysql2ConnectionLike;
  const executor = createMysql2Executor(connection);
  const iterator = executor.stream(mysqlSql.rows`SELECT value FROM first_set`.render())[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: { value: "first" } });
  await assert.rejects(() => iterator.next(), /BRAID_RESULT_SETS_UNSUPPORTED/u);
  assert.equal(source.drained, true);
});

test("MySQL streaming preserves second-set errors with drain cleanup failures", async () => {
  const drainFailure = new Error("mysql stream drain failed after second result set");
  const source = new FieldsBoundaryStream([{ name: "value", type: "SECOND" }], undefined, drainFailure);
  const cleanup: string[] = [];
  const raw: Mysql2RawConnectionLike = {
    execute: () => ({ stream: () => source }) as Mysql2RawCommandLike,
    destroy: () => undefined,
  };
  const connection = {
    connection: raw,
    execute: async () => [[], []] as const,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => {
      cleanup.push("release");
    },
    destroy: () => {
      cleanup.push("destroy");
    },
  } as unknown as Mysql2PoolConnectionLike;
  const db = createMysql2PoolDatabase({ getConnection: async () => connection });
  const iterator = db.stream(mysqlSql.rows`SELECT value FROM first_set`)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: { value: "first" } });
  await assert.rejects(
    () => iterator.return!(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((entry) => entry instanceof Error && /BRAID_RESULT_SETS_UNSUPPORTED/u.test(entry.message)) &&
      error.errors.some((entry) => entry instanceof Error && entry.cause === drainFailure),
  );
  assert.deepEqual(cleanup, ["destroy"]);
});

test("PostgreSQL adapter reports driver read failures", async () => {
  const failure = new Error("pg driver read failed");
  let closed = 0;
  class FailingCursor implements PgCursorLike {
    private reads = 0;
    read(_size: number, callback: (error: unknown, rows?: readonly unknown[]) => void): void {
      if (this.reads++ === 0) callback(null, [{ id: 1 }]);
      else callback(failure);
    }
    close(callback: (error?: unknown) => void): void {
      closed += 1;
      callback();
    }
  }
  const client = {
    query(value: unknown) {
      if (typeof value === "object") return value;
      return Promise.resolve({ rows: [], fields: [] });
    },
    escapeIdentifier: (value: string) => `"${value}"`,
    escapeLiteral: (value: string) => `'${value}'`,
  } as unknown as PgClientLike;
  const executor = createPgExecutor(client, {
    cursor: FailingCursor as unknown as PgCursorFactory,
    streamBatchSize: 1,
  });
  await assert.rejects(
    async () => {
      for await (const row of executor.stream(pgSql.rows`SELECT 1 AS id`.render())) void row;
    },
    (error: unknown) => error === failure,
  );
  assert.equal(closed, 1);
});

test("PostgreSQL adapter reports cleanup failures", async () => {
  const failure = new Error("pg cursor close failed");
  let closed = 0;
  class CleanupFailingCursor implements PgCursorLike {
    private exhausted = false;
    read(_size: number, callback: (error: unknown, rows?: readonly unknown[]) => void): void {
      if (this.exhausted) callback(null, []);
      else {
        this.exhausted = true;
        callback(null, [{ id: 1 }]);
      }
    }
    close(callback: (error?: unknown) => void): void {
      closed += 1;
      callback(failure);
    }
  }
  const client = {
    query(value: unknown) {
      if (typeof value === "object") return value;
      return Promise.resolve({ rows: [], fields: [] });
    },
    escapeIdentifier: (value: string) => `"${value}"`,
    escapeLiteral: (value: string) => `'${value}'`,
  } as unknown as PgClientLike;
  const executor = createPgExecutor(client, {
    cursor: CleanupFailingCursor as unknown as PgCursorFactory,
    streamBatchSize: 1,
  });
  await assert.rejects(
    async () => {
      for await (const row of executor.stream(pgSql.rows`SELECT 1 AS id`.render())) {
        void row;
        break;
      }
    },
    (error: unknown) =>
      error instanceof Error &&
      (error.cause === failure || (error instanceof AggregateError && error.errors.includes(failure))),
  );
  assert.equal(closed, 1);
});

test("PostgreSQL pooled streaming closes the cursor before releasing its lease", async () => {
  const events: string[] = [];
  class OrderingCursor implements PgCursorLike {
    read(_size: number, callback: (error: unknown, rows?: readonly unknown[]) => void): void {
      callback(null, [{ id: 1 }]);
    }
    close(callback: (error?: unknown) => void): void {
      events.push("close");
      callback();
    }
  }
  const client = {
    query(value: unknown) {
      if (typeof value === "object") return value;
      return Promise.resolve({ rows: [], fields: [] });
    },
    escapeIdentifier: (value: string) => `"${value}"`,
    escapeLiteral: (value: string) => `'${value}'`,
    release() {
      events.push("release");
    },
  } as unknown as PgClientLike & { release(): void };
  const db = createPgPoolDatabase(
    { connect: async () => client },
    { cursor: OrderingCursor as unknown as PgCursorFactory, streamBatchSize: 1 },
  );
  for await (const row of db.stream(pgSql.rows`SELECT 1 AS id`)) {
    void row;
    break;
  }
  assert.deepEqual(events, ["close", "release"]);
});

test("PostgreSQL stream keeps binds value-only", async () => {
  let submitted: unknown;
  class OneRowCursor implements PgCursorLike {
    constructor(
      readonly text: string,
      readonly values: readonly unknown[],
    ) {}
    read(_size: number, callback: (error: unknown, rows?: readonly unknown[]) => void): void {
      callback(null, []);
    }
    close(callback: (error?: unknown) => void): void {
      callback();
    }
  }
  const client = {
    query(value: unknown) {
      if (typeof value === "object") {
        submitted = value;
        return value;
      }
      return Promise.resolve({ rows: [], fields: [] });
    },
    escapeIdentifier: (value: string) => `"${value}"`,
    escapeLiteral: (value: string) => `'${value}'`,
  } as unknown as PgClientLike;
  const db = createPgExecutor(client, { cursor: OneRowCursor as unknown as PgCursorFactory });
  const secret = "x'); DROP TABLE braid_pv15_bind; --";
  for await (const row of db.stream(pgSql.rows`SELECT ${secret}::text AS value`.render())) void row;
  assert.equal((submitted as { readonly text: string }).text, "SELECT $1::text AS value");
  assert.deepEqual((submitted as { readonly values: readonly unknown[] }).values, [secret]);
});

test("MySQL adapter reports driver read failures", async () => {
  const failure = new Error("mysql driver read failed");
  class FailingStream implements Mysql2RawStreamLike {
    readonly readableEnded = true;
    readonly destroyed = false;
    once(_event: string, _listener: (...args: readonly unknown[]) => void): this {
      return this;
    }
    resume(): this {
      return this;
    }
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      throw failure;
    }
  }
  const raw: Mysql2RawConnectionLike = {
    execute: () => ({ stream: () => new FailingStream() }) as Mysql2RawCommandLike,
    destroy: () => undefined,
  };
  const connection = {
    connection: raw,
    execute: async () => [[], []] as const,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  } as unknown as Mysql2ConnectionLike;
  const executor = createMysql2Executor(connection);
  await assert.rejects(
    async () => {
      for await (const row of executor.stream(mysqlSql.rows`SELECT 1 AS id`.render())) void row;
    },
    (error: unknown) => error === failure,
  );
});

test("MySQL adapter reports stream drain failures after consumer break", async () => {
  const failure = new Error("mysql stream drain failed");
  class CleanupFailingStream implements Mysql2RawStreamLike {
    readonly readableEnded = false;
    readonly destroyed = false;
    once(_event: string, _listener: (...args: readonly unknown[]) => void): this {
      return this;
    }
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      yield { id: 1 };
      throw failure;
    }
  }
  const raw: Mysql2RawConnectionLike = {
    execute: () => ({ stream: () => new CleanupFailingStream() }) as Mysql2RawCommandLike,
    destroy: () => undefined,
  };
  const connection = {
    connection: raw,
    execute: async () => [[], []] as const,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  } as unknown as Mysql2ConnectionLike;
  const executor = createMysql2Executor(connection);
  await assert.rejects(
    async () => {
      for await (const row of executor.stream(mysqlSql.rows`SELECT 1 AS id`.render())) {
        void row;
        break;
      }
    },
    (error: unknown) => error instanceof Error && error.cause === failure,
  );
});

test("supported adapters reuse streaming conformance with query-bound row schemas", async () => {
  const rowSchema: StandardSchemaV1<unknown, { readonly id: number; readonly label: string }> = {
    "~standard": {
      version: 1,
      vendor: "pv15-conformance",
      validate(value) {
        if (
          !value ||
          typeof value !== "object" ||
          !("id" in value) ||
          !("label" in value) ||
          typeof value.id !== "number" ||
          typeof value.label !== "string"
        ) {
          return { issues: [{ message: "invalid conformance row" }] };
        }
        return { value: { id: value.id, label: value.label.toUpperCase() } };
      },
    },
  };
  const createMockDatabase = (kind: "postgres" | "mysql") => {
    const rows = [
      { id: 1, label: "one" },
      { id: 2, label: "two" },
    ] as const;
    const mapping = {
      "~standard": {
        version: 1 as const,
        vendor: "pv15-conformance-failure",
        validate() {
          return { issues: [{ message: "mapping failed" }] };
        },
      },
    } satisfies StandardSchemaV1<unknown, unknown>;
    let released = 0;
    let returned = 0;
    const db =
      kind === "postgres"
        ? createPgPoolDatabase(
            {
              async connect() {
                return {
                  query(value: unknown) {
                    if (typeof value === "object") return value;
                    return Promise.resolve({ rows, fields: [] });
                  },
                  escapeIdentifier: (value: string) => `"${value}"`,
                  escapeLiteral: (value: string) => `'${value}'`,
                  async end() {
                    returned += 1;
                  },
                  release() {
                    released += 1;
                  },
                } as unknown as PgPoolClientLike;
              },
            },
            {
              cursor: class implements PgCursorLike {
                private index = 0;
                read(_size: number, callback: (error: unknown, rows?: readonly unknown[]) => void): void {
                  callback(null, this.index++ === 0 ? rows : []);
                }
                close(callback: (error?: unknown) => void): void {
                  returned += 1;
                  callback();
                }
              } as unknown as PgCursorFactory,
              streamBatchSize: 2,
            },
          )
        : createMysql2PoolDatabase(
            {
              async getConnection() {
                const source: Mysql2RawStreamLike = {
                  readableEnded: true,
                  destroyed: false,
                  once(_event: string, _listener: (...args: readonly unknown[]) => void) {
                    return this;
                  },
                  resume() {
                    return this;
                  },
                  async *[Symbol.asyncIterator]() {
                    yield* rows;
                  },
                };
                return {
                  connection: {
                    execute: () => ({ stream: () => source }) as Mysql2RawCommandLike,
                    destroy: () => undefined,
                  },
                  execute: async () => [rows, []] as const,
                  beginTransaction: async () => undefined,
                  commit: async () => undefined,
                  rollback: async () => undefined,
                  release() {
                    released += 1;
                  },
                  destroy() {
                    released += 1;
                  },
                } as unknown as Mysql2PoolConnectionLike;
              },
            },
            { streamHighWaterMark: 2 },
          );
    const query =
      kind === "postgres"
        ? pgSql.rows(rowSchema)`SELECT id, label FROM braid_pv15_conformance`
        : mysqlSql.rows(rowSchema)`SELECT id, label FROM braid_pv15_conformance`;
    const mappingQuery =
      kind === "postgres"
        ? pgSql.rows(mapping)`SELECT id, label FROM braid_pv15_conformance`
        : mysqlSql.rows(mapping)`SELECT id, label FROM braid_pv15_conformance`;
    return {
      db,
      query,
      expected: [
        { id: 1, label: "ONE" },
        { id: 2, label: "TWO" },
      ],
      mappingQuery,
      released: () => released,
      ...(kind === "postgres" ? { iteratorReturns: () => returned } : {}),
    };
  };
  await runStreamingConformance(() => createMockDatabase("postgres"));
  await runStreamingConformance(() => createMockDatabase("mysql"));
});
