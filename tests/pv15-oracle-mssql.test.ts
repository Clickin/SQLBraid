import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "vitest";
import { oracleParameter, sql as oracleSql } from "@sqlbraid/oracle";
import {
  createOracledbDatabase,
  createOracledbExecutor,
  createOracledbPoolDatabase,
  createOracledbStatementBinding,
  type OracleConnectionLike,
} from "@sqlbraid/oracle/oracledb";
import type { TypePolicy } from "@sqlbraid/core";
import { mssqlParameter, sql as mssqlSql } from "@sqlbraid/mssql";
import {
  createTediousDatabase,
  createTediousExecutor,
  createTediousPoolDatabase,
  createTediousStatementBinding,
  type TediousConnectionLike,
  type TediousRequestLike,
} from "@sqlbraid/mssql/tedious";
import { runStreamingConformance } from "./streaming-conformance.js";

function emit(request: TediousRequestLike, event: string, ...args: unknown[]): void {
  (request as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(event, ...args);
}

function oracleDriver() {
  return {
    BIND_IN: 1,
    BIND_OUT: 2,
    BIND_INOUT: 3,
    CURSOR: 4,
    OUT_FORMAT_OBJECT: 5,
    DB_TYPE_NUMBER: 6,
    DB_TYPE_VARCHAR: 7,
    DB_TYPE_BLOB: 8,
    DB_TYPE_CLOB: 9,
    DB_TYPE_NCLOB: 10,
  };
}

function oracleCursor(
  rows: readonly Record<string, unknown>[],
  close: () => Promise<void> = async () => {},
  onRead?: (size: number) => void,
) {
  let offset = 0;
  return {
    metaData: Object.keys(rows[0] ?? { value: undefined }).map((name) => ({ name, dbTypeName: "VARCHAR2" })),
    async getRows(size = 100) {
      onRead?.(size);
      const batch = rows.slice(offset, offset + size);
      offset += batch.length;
      return batch;
    },
    close,
  };
}

const oracleRows = [{ VALUE: "one" }, { VALUE: "two" }, { VALUE: "three" }] as const;

function oracleLob(data: string | Uint8Array, onDestroy?: () => void, destroyFailure?: Error) {
  const stream = new Readable({ read() {} });
  const destroy = stream.destroy.bind(stream);
  stream.destroy = ((error?: Error) => {
    onDestroy?.();
    return destroy(destroyFailure ?? error);
  }) as typeof stream.destroy;
  (stream as Readable & { getData(): Promise<string | Uint8Array> }).getData = async () => data;
  return stream as Readable & { getData(): Promise<string | Uint8Array> };
}

test("Oracle and Tedious value-only binds remain outside executable SQL text", () => {
  const payload = "O'Reilly /* $1 ? :1 @p1 */";
  const oracleRendered =
    oracleSql`SELECT ${oracleSql.bind(payload, oracleParameter.varchar2())} AS VALUE FROM dual`.render();
  const oracleDescription = createOracledbStatementBinding({ driver: oracleDriver() }).describe(oracleRendered, {
    dialectId: "oracle",
    requestedReuse: "auto",
  });
  const tediousRendered = mssqlSql`SELECT ${mssqlSql.bind(payload, mssqlParameter.nvarchar(80))} AS VALUE`.render();
  const tediousDescription = createTediousStatementBinding().describe(tediousRendered, {
    dialectId: "mssql",
    requestedReuse: "auto",
  });
  const oracleSqlText = "parameterizedSql" in oracleDescription ? oracleDescription.parameterizedSql : undefined;
  const tediousSqlText = "parameterizedSql" in tediousDescription ? tediousDescription.parameterizedSql : undefined;
  assert.equal(oracleSqlText, "SELECT :1 AS VALUE FROM dual");
  assert.equal(tediousSqlText, "SELECT @p1 AS VALUE");
  assert.equal(oracleSqlText?.includes(payload) ?? false, false);
  assert.equal(tediousSqlText?.includes(payload) ?? false, false);
});

function oracleStreamingConnection(
  options: {
    readonly rows?: readonly Record<string, unknown>[];
    readonly close?: () => Promise<void>;
    readonly onRead?: (size: number) => void;
  } = {},
): OracleConnectionLike {
  return {
    async execute() {
      return {
        resultSet: oracleCursor(options.rows ?? oracleRows, options.close, options.onRead),
      };
    },
    async break() {},
    async commit() {},
    async rollback() {},
  };
}

test("Oracle routine calls map scalar and heterogeneous cursor channels and close every cursor", async () => {
  let closed = 0;
  const users = oracleCursor([{ USER_ID: "u1" }], async () => {
    closed += 1;
  });
  const payments = oracleCursor([{ PAYMENT_ID: "p1" }], async () => {
    closed += 1;
  });
  const implicit = oracleCursor([{ SUMMARY: "ok" }], async () => {
    closed += 1;
  });
  const connection = {
    async execute(_text: string, _binds: readonly unknown[]) {
      return { outBinds: ["42", users, payments], implicitResults: [implicit] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, { driver: oracleDriver() });
  const query = oracleSql.call`BEGIN braid_routine(${oracleSql.out("answer", oracleParameter.number())}, ${oracleSql.out("users", oracleParameter.refCursor())}, ${oracleSql.out("payments", oracleParameter.refCursor())}); END;`;
  const result = await executor.call(query.render());
  assert.deepEqual(result.output, { answer: "42" });
  assert.deepEqual(
    result.resultSets.map((set) => set.rows),
    [[{ USER_ID: "u1" }], [{ PAYMENT_ID: "p1" }], [{ SUMMARY: "ok" }]],
  );
  assert.deepEqual(
    result.resultSets.map((set) => set.source),
    [
      { kind: "out-cursor", name: "users", parameterIndex: 1 },
      { kind: "out-cursor", name: "payments", parameterIndex: 2 },
      { kind: "implicit", index: 0 },
    ],
  );
  assert.equal(closed, 3);
});

test("Oracle routine cursor cleanup closes unread siblings after fetch failure", async () => {
  let firstClosed = 0;
  let secondClosed = 0;
  const first = {
    metaData: [{ name: "VALUE", dbTypeName: "VARCHAR2" }],
    async getRows() {
      throw new Error("fetch failed");
    },
    async close() {
      firstClosed += 1;
    },
  };
  const second = oracleCursor([{ VALUE: "never-read" }], async () => {
    secondClosed += 1;
  });
  const connection = {
    async execute() {
      return { outBinds: [first, second] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, { driver: oracleDriver() });
  const query = oracleSql.call`BEGIN braid_routine(${oracleSql.out("first", oracleParameter.refCursor())}, ${oracleSql.out("second", oracleParameter.refCursor())}); END;`;
  await assert.rejects(async () => executor.call(query.render()), /fetch failed/u);
  assert.equal(firstClosed, 1);
  assert.equal(secondClosed, 1);
});

test("Oracle routine materializes CLOB and BLOB outputs before destroying Lobs and applies TypePolicy", async () => {
  const events: string[] = [];
  const text = oracleLob("clob payload", () => {
    events.push("text-destroy");
  });
  const bytes = oracleLob(Uint8Array.from([1, 2, 3]), () => {
    events.push("bytes-destroy");
  });
  const decoded: Array<{ readonly type: string; readonly value: unknown }> = [];
  const policy: TypePolicy = {
    id: "oracle-test",
    hash: "oracle-test-v1",
    mappings: [],
    encode: (_type, value) => value,
    decode: (type, value) => {
      decoded.push({ type, value });
      return value;
    },
  };
  const connection = {
    async execute() {
      return { outBinds: [text, bytes] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, { driver: oracleDriver(), typePolicy: policy });
  const query = oracleSql.call`BEGIN braid_lob(${oracleSql.out("text", oracleParameter.clob())}, ${oracleSql.inOut("bytes", Uint8Array.from([9]), oracleParameter.blob())}); END;`;
  const result = await executor.call(query.render());
  assert.deepEqual(result.output, { text: "clob payload", bytes: Uint8Array.from([1, 2, 3]) });
  assert.deepEqual(
    decoded.map(({ type, value }) => [type, value]),
    [
      ["CLOB", "clob payload"],
      ["BLOB", Uint8Array.from([1, 2, 3])],
    ],
  );
  assert.deepEqual(events, ["text-destroy", "bytes-destroy"]);
  assert.equal(text.closed, true);
  assert.equal(bytes.closed, true);
});

test("Oracle routine preserves already-materialized CLOB strings and BLOB bytes", async () => {
  const connection = {
    async execute() {
      return { outBinds: ["ready", Uint8Array.from([4, 5])] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, { driver: oracleDriver() });
  const query = oracleSql.call`BEGIN braid_lob(${oracleSql.out("text", oracleParameter.clob())}, ${oracleSql.out("bytes", oracleParameter.blob())}); END;`;
  const result = await executor.call(query.render());
  assert.deepEqual(result.output, { text: "ready", bytes: Uint8Array.from([4, 5]) });
});

test("Oracle routine LOB read failure destroys unread sibling Lobs and preserves cleanup failures", async () => {
  const primary = new Error("clob read failed");
  const cleanup = new Error("blob destroy failed");
  const events: string[] = [];
  const text = oracleLob("never returned", () => {
    events.push("text-destroy");
  });
  text.getData = async () => {
    throw primary;
  };
  const bytes = oracleLob(
    Uint8Array.from([1]),
    () => {
      events.push("bytes-destroy");
    },
    cleanup,
  );
  const connection = {
    async execute() {
      return { outBinds: [text, bytes] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, { driver: oracleDriver() });
  const query = oracleSql.call`BEGIN braid_lob(${oracleSql.out("text", oracleParameter.clob())}, ${oracleSql.out("bytes", oracleParameter.blob())}); END;`;
  await assert.rejects(
    async () => executor.call(query.render()),
    (error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "BRAID_RESOURCE_CLEANUP") return false;
      const details = error as Error & { readonly cause?: unknown; readonly errors?: readonly unknown[] };
      return (
        details.cause === primary &&
        Array.isArray(details.errors) &&
        details.errors.includes(primary) &&
        details.errors.includes(cleanup)
      );
    },
  );
  assert.deepEqual(events, ["text-destroy", "bytes-destroy"]);
  assert.equal(text.closed, true);
  assert.equal(bytes.closed, true);
});

test("Oracle pooled routine discards a lease after Lob cleanup failure", async () => {
  const cleanup = new Error("blob destroy failed");
  const events: string[] = [];
  const bytes = oracleLob(
    Uint8Array.from([1]),
    () => {
      events.push("bytes-destroy");
    },
    cleanup,
  );
  const physical = {
    async execute() {
      events.push("execute");
      return { outBinds: [bytes] };
    },
    async commit() {},
    async rollback() {},
    async close(options?: { readonly drop?: boolean }) {
      events.push(options?.drop === true ? "discard" : "release");
    },
  };
  const db = createOracledbPoolDatabase(
    {
      async getConnection() {
        return physical;
      },
    },
    { driver: oracleDriver() },
  );
  const query = oracleSql.call`BEGIN braid_lob(${oracleSql.out("bytes", oracleParameter.blob())}); END;`;
  await assert.rejects(
    () => db.call(query),
    (error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "BRAID_RESOURCE_CLEANUP") return false;
      const details = error as Error & { readonly cause?: unknown };
      return details.cause === cleanup;
    },
  );
  assert.deepEqual(events, ["execute", "bytes-destroy", "discard"]);
});

test("Oracle stream uses configured fetch size and marks close failures", async () => {
  const sizes: number[] = [];
  const resultSet = {
    metaData: [{ name: "VALUE", dbTypeName: "NUMBER" }],
    async getRows(size: number) {
      sizes.push(size);
      return sizes.length === 1 ? [{ VALUE: "1" }] : [];
    },
    async close() {
      throw new Error("close failed");
    },
  };
  const connection = {
    async execute() {
      return { resultSet, metaData: resultSet.metaData };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, { driver: oracleDriver(), streamFetchSize: 7 });
  const stream = executor.stream(oracleSql`SELECT 1 FROM dual`.render());
  await assert.rejects(
    async () => {
      for await (const row of stream) {
        void row;
      }
    },
    (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_RESOURCE_CLEANUP",
  );
  assert.ok(sizes.every((size) => size === 7));
});

test("Oracle stream decodes with ResultSet metadata and rejects duplicate labels", async () => {
  const decoded: string[] = [];
  const policy: TypePolicy = {
    id: "oracle-stream-test",
    hash: "oracle-stream-test-v1",
    mappings: [],
    encode: (_type, value) => value,
    decode: (type, value) => {
      decoded.push(`${type}:${String(value)}`);
      return value;
    },
  };
  const resultSet = {
    metaData: [{ name: "VALUE", dbTypeName: "NUMBER" }],
    async getRows() {
      return [{ VALUE: "7" }];
    },
    close() {},
  };
  const connection = {
    async execute() {
      return { resultSet, metaData: [{ name: "WRONG", dbTypeName: "VARCHAR2" }] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, { driver: oracleDriver(), typePolicy: policy });
  const rows: unknown[] = [];
  for await (const row of executor.stream(oracleSql`SELECT 7 FROM dual`.render())) rows.push(row);
  assert.deepEqual(rows, [{ VALUE: "7" }]);
  assert.deepEqual(decoded, ["NUMBER:7"]);

  const duplicateResultSet = {
    metaData: [{ name: "VALUE" }, { name: "VALUE" }],
    async getRows() {
      return [];
    },
    close() {},
  };
  const duplicateExecutor = createOracledbExecutor(
    {
      async execute() {
        return { resultSet: duplicateResultSet };
      },
      async commit() {},
      async rollback() {},
    },
    { driver: oracleDriver() },
  );
  await assert.rejects(async () => {
    for await (const row of duplicateExecutor.stream(oracleSql`SELECT 7 FROM dual`.render())) {
      void row;
    }
  }, /duplicate Oracle result label VALUE/u);
});

test("Oracle stream closes the ResultSet after a driver read failure", async () => {
  const events: string[] = [];
  const driverFailure = new Error("driver read failed");
  const resultSet = {
    metaData: [{ name: "VALUE", dbTypeName: "VARCHAR2" }],
    async getRows() {
      events.push("read");
      throw driverFailure;
    },
    async close() {
      events.push("close");
    },
  };
  const connection = {
    async execute() {
      events.push("execute");
      return { resultSet };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, { driver: oracleDriver() });
  await assert.rejects(
    async () => {
      for await (const row of executor.stream(oracleSql`SELECT 1 FROM dual`.render())) {
        void row;
      }
    },
    (error: unknown) => error === driverFailure,
  );
  assert.deepEqual(events, ["execute", "read", "close"]);
});

test("Oracle pooled stream closes the ResultSet before releasing its lease", async () => {
  const events: string[] = [];
  let read = 0;
  const resultSet = {
    metaData: [{ name: "VALUE", dbTypeName: "VARCHAR2" }],
    async getRows() {
      events.push("read");
      read += 1;
      return read === 1 ? [{ VALUE: "one" }] : [];
    },
    async close() {
      events.push("close");
    },
  };
  const physical = {
    async execute() {
      events.push("execute");
      return { resultSet };
    },
    async commit() {},
    async rollback() {},
    async close() {
      events.push("release");
    },
  };
  const db = createOracledbPoolDatabase(
    {
      async getConnection() {
        return physical;
      },
    },
    { driver: oracleDriver() },
  );
  for await (const row of db.stream(oracleSql.rows`SELECT 1 FROM dual`)) {
    void row;
  }
  assert.deepEqual(events, ["execute", "read", "close", "release"]);
});

test("Oracle stream satisfies the shared streaming lifecycle contract", async () => {
  let run = 0;
  const mappingQuery = oracleSql.rows({
    "~standard": {
      version: 1,
      vendor: "sqlbraid-pv15",
      validate() {
        throw new Error("query mapper failed");
      },
    },
  })`SELECT value FROM braid_stream`;
  await runStreamingConformance(
    () => {
      run += 1;
      const cleanupFailure = new Error("oracle cleanup failed");
      const connection = oracleStreamingConnection({
        rows: oracleRows,
        close:
          run === 8
            ? async () => {
                throw cleanupFailure;
              }
            : undefined,
      });
      const db = createOracledbDatabase(connection, { driver: oracleDriver(), streamFetchSize: 2 });
      const query = oracleSql.rows<(typeof oracleRows)[number]>`SELECT value FROM braid_stream`;
      return {
        db,
        query,
        expected: oracleRows,
        mappingQuery,
        ...(run === 8 ? { cleanupFailureQuery: query, cleanupFailure } : {}),
      };
    },
    { abortError: new Error("oracle stream aborted") },
  );
});

function mssqlConnection(run: (request: TediousRequestLike) => void) {
  return {
    execSql: run,
    beginTransaction(callback: (error?: unknown) => void) {
      callback();
    },
    commitTransaction(callback: (error?: unknown) => void) {
      callback();
    },
    rollbackTransaction(callback: (error?: unknown) => void) {
      callback();
    },
    saveTransaction(callback: (error?: unknown) => void) {
      callback();
    },
  };
}

function mssqlStreamingConnection(
  options: {
    readonly rows?: readonly number[];
    readonly failAt?: number;
    readonly cancelFailure?: unknown;
    readonly onEmit?: () => void;
    readonly onComplete?: () => void;
    readonly onStart?: () => void;
    readonly onCancel?: () => void;
    readonly readFailure?: Error;
  } = {},
): TediousConnectionLike {
  const values = options.rows ?? [1, 2, 3];
  let cancelled = false;
  let completed = false;
  const connection: TediousConnectionLike = {
    execSql(request) {
      let paused = false;
      let index = 0;
      const controls = request as unknown as {
        pause?: () => unknown;
        resume?: () => unknown;
        cancel?: () => unknown;
      };
      const finish = (): void => {
        if (completed) return;
        completed = true;
        options.onComplete?.();
        emit(request, "requestCompleted");
      };
      controls.pause = () => {
        paused = true;
        return request;
      };
      controls.resume = () => {
        paused = false;
        return request;
      };
      controls.cancel = () => {
        cancelled = true;
        options.onCancel?.();
        setImmediate(finish);
        if (options.cancelFailure !== undefined) throw options.cancelFailure;
        return request;
      };
      const pump = (): void => {
        if (cancelled) return;
        if (paused) {
          setImmediate(pump);
          return;
        }
        if (index === 0) emit(request, "columnMetadata", [{ colName: "VALUE", type: "IntN", dataLength: 4 }]);
        if (options.failAt === index) {
          emit(request, "error", options.readFailure ?? new Error("tedious driver failed"));
          setImmediate(finish);
          return;
        }
        if (index < values.length) {
          options.onEmit?.();
          emit(request, "row", [{ value: values[index] }]);
          index += 1;
          setImmediate(pump);
          return;
        }
        emit(request, "done", values.length, false, 0);
        finish();
      };
      options.onStart?.();
      setImmediate(pump);
    },
    beginTransaction(callback) {
      callback();
    },
    commitTransaction(callback) {
      callback();
    },
    rollbackTransaction(callback) {
      callback();
    },
    saveTransaction(callback) {
      callback();
    },
  };
  return connection;
}

test("Tedious stream satisfies the shared streaming lifecycle contract", async () => {
  let run = 0;
  const mappingQuery = mssqlSql.rows({
    "~standard": {
      version: 1,
      vendor: "sqlbraid-pv15",
      validate() {
        throw new Error("query mapper failed");
      },
    },
  })`SELECT value FROM braid_stream`;
  await runStreamingConformance(
    () => {
      run += 1;
      const cleanupFailure = new Error("tedious cleanup failed");
      const connection = mssqlStreamingConnection({
        rows: [1, 2, 3],
        failAt: run === 8 ? 0 : undefined,
        cancelFailure: run === 8 ? cleanupFailure : undefined,
      });
      const db = createTediousDatabase(connection, { maxBufferedRows: 2 });
      const query = mssqlSql.rows<{ readonly VALUE: string }>`SELECT value FROM braid_stream`;
      return {
        db,
        query,
        expected: [{ VALUE: "1" }, { VALUE: "2" }, { VALUE: "3" }],
        mappingQuery,
        ...(run === 8 ? { cleanupFailureQuery: query, cleanupFailure } : {}),
      };
    },
    { abortError: new Error("tedious stream aborted") },
  );
});

test("Tedious stream bounds the queued rows and reports driver failures", async () => {
  let emitted = 0;
  let consumed = 0;
  let maximumPending = 0;
  const connection = mssqlStreamingConnection({
    rows: Array.from({ length: 12 }, (_, index) => index + 1),
    onEmit() {
      emitted += 1;
      maximumPending = Math.max(maximumPending, emitted - consumed);
    },
  });
  const executor = createTediousExecutor(connection, { maxBufferedRows: 2 });
  for await (const row of executor.stream(mssqlSql`SELECT value FROM braid_stream`.render())) {
    void row;
    consumed += 1;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(maximumPending <= 2);

  const failing = createTediousExecutor(mssqlStreamingConnection({ failAt: 0 }));
  await assert.rejects(async () => {
    for await (const row of failing.stream(mssqlSql`SELECT value FROM braid_stream`.render())) {
      void row;
    }
  }, /tedious driver failed/u);
});

test("Tedious pooled stream waits for request completion before releasing its lease", async () => {
  const events: string[] = [];
  const physical = {
    ...mssqlStreamingConnection({
      rows: [1],
      onComplete() {
        events.push("complete");
      },
    }),
    async release() {
      events.push("release");
    },
  };
  const db = createTediousPoolDatabase(
    {
      async acquire() {
        return physical;
      },
    },
    { maxBufferedRows: 2 },
  );
  for await (const row of db.stream(mssqlSql.rows`SELECT value FROM braid_stream`)) {
    void row;
  }
  assert.deepEqual(events, ["complete", "release"]);
});

for (const ownership of ["direct", "pooled"] as const)
  for (const mode of ["stream-return", "stream-read-failure", "cleanup-failure"] as const) {
    test(`[contract:tedious:resource.${mode}:boundary] [ownership:${ownership}] request completion precedes exactly one healthy release or discard`, async () => {
      const primary = new Error("native row read failed");
      const cleanup = new Error("native request cancel failed");
      const events: string[] = [];
      let acquired = 0;
      let cancelled = 0;
      const physical = {
        ...mssqlStreamingConnection({
          failAt: mode === "stream-return" ? undefined : 0,
          readFailure: primary,
          cancelFailure: mode === "cleanup-failure" ? cleanup : undefined,
          onStart() {
            events.push("created");
          },
          onCancel() {
            cancelled++;
          },
          onComplete() {
            events.push("completed");
          },
        }),
        async destroy() {
          events.push("discarded");
        },
      };
      const db =
        ownership === "direct"
          ? createTediousDatabase(physical)
          : createTediousPoolDatabase({
              async acquire() {
                acquired++;
                return Object.assign(physical, {
                  async release() {
                    events.push("released");
                  },
                });
              },
            });
      const consume = async () => {
        for await (const row of db.stream(mssqlSql.rows<{ VALUE: string }>`SELECT value FROM braid_stream`)) {
          assert.equal(row.VALUE, "1");
          break;
        }
      };
      if (mode === "stream-return") await consume();
      else
        await assert.rejects(consume(), (error) =>
          mode === "stream-read-failure"
            ? error === primary
            : error instanceof AggregateError &&
              error.cause === primary &&
              error.errors.includes(primary) &&
              error.errors.includes(cleanup),
        );
      assert.equal(acquired, ownership === "pooled" ? 1 : 0);
      assert.equal(cancelled, 1);
      assert.deepEqual(events, [
        "created",
        "completed",
        ...(ownership === "pooled" ? [mode === "cleanup-failure" ? "discarded" : "released"] : []),
      ]);
      if (mode === "cleanup-failure" && ownership === "direct") {
        await assert.rejects(db.execute(mssqlSql.command`UPDATE braid_stream SET value = 1`), {
          code: "BRAID_CONNECTION_POISONED",
        });
        assert.deepEqual(events, ["created", "completed"]);
      }
    });
  }

for (const ownership of ["direct", "pooled"] as const)
  for (const phase of ["before-handoff", "in-flight", "iteration"] as const) {
    test(`[contract:tedious:cancellation.${phase}:boundary] [ownership:${ownership}] native cancellation drains the request before exactly one lease release`, async () => {
      const controller = new AbortController();
      const reason = new Error("cancel native request");
      const started = Promise.withResolvers<void>();
      const events: string[] = [];
      let cancelled = 0;
      let yielded = 0;
      const physical = {
        ...mssqlStreamingConnection({
          onStart() {
            events.push("created");
            started.resolve();
            if (phase === "before-handoff") controller.abort(reason);
          },
          onCancel() {
            cancelled++;
          },
          onComplete() {
            events.push("completed");
          },
        }),
        async destroy() {
          events.push("discarded");
        },
      };
      const db =
        ownership === "direct"
          ? createTediousDatabase(physical)
          : createTediousPoolDatabase({
              async acquire() {
                return Object.assign(physical, {
                  async release() {
                    events.push("released");
                  },
                });
              },
            });
      const pending = (async () => {
        for await (const row of db.stream(mssqlSql.rows`SELECT value FROM braid_stream`, {
          signal: controller.signal,
        })) {
          void row;
          yielded++;
          controller.abort(reason);
        }
      })();
      const rejected = assert.rejects(pending, (error) => error === reason);
      await started.promise;
      if (phase === "in-flight") controller.abort(reason);
      await rejected;
      assert.equal(yielded, phase === "iteration" ? 1 : 0);
      assert.equal(cancelled, 1);
      assert.deepEqual(events, ["created", "completed", ...(ownership === "pooled" ? ["released"] : [])]);
    });
  }

test("Tedious native procedure calls preserve OUTPUT, RETURN status, and heterogeneous result sets", async () => {
  let procedureCalls = 0;
  const connection = {
    ...mssqlConnection(() => {}),
    callProcedure(request: TediousRequestLike) {
      procedureCalls += 1;
      emit(request, "returnValue", "outAnswer", 7, {});
      emit(request, "columnMetadata", [{ colName: "USER_ID", type: "IntN", dataLength: 4 }]);
      emit(request, "row", [{ value: 1 }]);
      emit(request, "doneProc", 1, false, 7);
      emit(request, "columnMetadata", [{ colName: "PAYMENT_ID", type: "IntN", dataLength: 4 }]);
      emit(request, "row", [{ value: 2 }]);
      emit(request, "doneProc", 1, false, 7);
      emit(request, "requestCompleted");
    },
  };
  const executor = createTediousExecutor(connection);
  const query = mssqlSql.call({
    procedure: { name: "dbo.braid_routine", parameterNames: ["outAnswer", "minimum"] },
  })`${mssqlSql.out("answer", mssqlParameter.int())}, ${1}`;
  const result = await executor.call(query.render());
  assert.equal(procedureCalls, 1);
  assert.deepEqual(result.output, { answer: "7" });
  assert.equal(result.returnValue, 7);
  assert.deepEqual(
    result.resultSets.map((set) => set.rows),
    [[{ USER_ID: "1" }], [{ PAYMENT_ID: "2" }]],
  );
  assert.deepEqual(
    result.resultSets.map((set) => set.source),
    [
      { kind: "emitted", index: 0 },
      { kind: "emitted", index: 1 },
    ],
  );
});

test("Tedious text calls never report the sp_executesql wrapper status", async () => {
  const connection = mssqlConnection((request) => {
    emit(request, "returnValue", "p1", 4, {});
    emit(request, "doneProc", 1, false, 99);
    emit(request, "requestCompleted");
  });
  const executor = createTediousExecutor(connection);
  const query = mssqlSql.call`EXEC dbo.braid_routine ${mssqlSql.out("answer", mssqlParameter.int())} OUTPUT`;
  const result = await executor.call(query.render());
  assert.deepEqual(result.output, { answer: "4" });
  assert.equal(Object.hasOwn(result, "returnValue"), false);
});

test("Tedious rejects direct CURSOR VARYING output parameters", async () => {
  let called = false;
  const connection = mssqlConnection(() => {
    called = true;
  });
  const executor = createTediousExecutor(connection);
  const query = mssqlSql.call`EXEC dbo.braid_cursor ${mssqlSql.out("cursor", { databaseType: "cursor" })} OUTPUT`;
  await assert.rejects(async () => executor.call(query.render()), /BRAID_CALL_CURSOR_UNSUPPORTED/u);
  assert.equal(called, false);
});
