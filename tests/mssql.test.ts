import assert from "node:assert/strict";
import { test } from "vitest";
import type { RenderedBulk } from "@sqlbraid/core";
import { mssqlParameter, sql, typePolicy } from "@sqlbraid/mssql";
import { UnsupportedFeatureError } from "@sqlbraid/core";
import {
  createTediousExecutor,
  createTediousPoolDatabase,
  createTediousPoolProvider,
  tediousStatementBinding,
  type TediousConnectionLike,
  type TediousRequestLike,
} from "@sqlbraid/mssql/tedious";

function mockConnection(run: (request: TediousRequestLike) => void): TediousConnectionLike {
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

function emit(request: TediousRequestLike, event: string, ...args: unknown[]): void {
  (request as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(event, ...args);
}

function completeRequest(request: TediousRequestLike, error?: unknown, rowCount?: number): void {
  (request as unknown as { callback(error?: unknown, rowCount?: number): void }).callback(error, rowCount);
}

test("MSSQL dialect renders deterministic parameters and bracket identifiers", () => {
  const query = sql`SELECT ${1}, ${"Ada"}`;
  const rendered = query.render();
  assert.deepEqual(rendered.segments, ["SELECT ", ", ", ""]);
  assert.deepEqual(rendered.parameters, [
    { value: 1, interpolation: 0 },
    { value: "Ada", interpolation: 1 },
  ]);
  assert.equal(
    tediousStatementBinding.describe(rendered, { dialectId: "mssql", requestedReuse: "auto" }).parameterizedSql,
    "SELECT @p1, @p2",
  );
  assert.equal(sql`SELECT ${sql.ident("a]b")}`.render().segments[0], "SELECT [a]]b]");
  assert.equal(typePolicy.id, "mssql-default");
});

test("MSSQL parameter factories preserve explicit metadata", () => {
  assert.deepEqual(mssqlParameter.nvarchar(200), { databaseType: "nvarchar", length: 200 });
  assert.deepEqual(mssqlParameter.nvarchar("max"), { databaseType: "nvarchar", length: "max" });
  assert.deepEqual(mssqlParameter.decimal(19, 4), { databaseType: "decimal", precision: 19, scale: 4 });
  assert.deepEqual(mssqlParameter.numeric(19, 4), { databaseType: "numeric", precision: 19, scale: 4 });
  assert.deepEqual(mssqlParameter.money(), { databaseType: "money" });
  assert.deepEqual(mssqlParameter.smallmoney(), { databaseType: "smallmoney" });
  assert.throws(() => mssqlParameter.nvarchar(4001), /lengths/u);
  assert.throws(() => mssqlParameter.decimal(10, 11), /scale/u);
});

test("MSSQL bind hints align with rendered values", () => {
  const query = sql`SELECT ${sql.bind(null, mssqlParameter.nvarchar(20))}`;
  const rendered = query.render();
  assert.equal(
    tediousStatementBinding.describe(rendered, { dialectId: "mssql", requestedReuse: "auto" }).parameterizedSql,
    "SELECT @p1",
  );
  assert.deepEqual(
    rendered.parameters.map((parameter) => parameter.value),
    [null],
  );
  assert.deepEqual(
    rendered.parameters.map((parameter) => parameter.hint),
    [mssqlParameter.nvarchar(20)],
  );
});

test("MSSQL adapter honors int hints and rejects ignored type facets", async () => {
  const executor = createTediousExecutor(mockConnection((request) => emit(request, "requestCompleted")));
  await assert.doesNotReject(async () => executor.query(sql`SELECT ${sql.bind(1, mssqlParameter.int())}`.render()));
  await assert.rejects(
    async () => executor.query(sql`SELECT ${sql.bind(1, { databaseType: "int", length: 1 })}`.render()),
    /does not support length/u,
  );
  await assert.rejects(
    async () =>
      executor.query(sql`SELECT ${sql.bind("Ada", { databaseType: "varchar", length: 3, precision: 1 })}`.render()),
    /does not support precision/u,
  );
  await assert.rejects(
    async () =>
      executor.query(
        sql`SELECT ${sql.bind(1, { databaseType: "decimal", precision: 10, scale: 2, length: 4 })}`.render(),
      ),
    /does not support length/u,
  );
});

test("MSSQL typed materialization rejects out-of-range values before execution", async () => {
  let executions = 0;
  const executor = createTediousExecutor(
    mockConnection(() => {
      executions += 1;
    }),
  );
  await assert.rejects(
    async () => executor.query(sql`SELECT ${sql.bind(2_147_483_648, mssqlParameter.int())}`.render()),
    /invalid SQL Server int parameter/u,
  );
  assert.equal(executions, 0);
});

test("MSSQL native decimal helpers accept only bounded Number compatibility inputs", async () => {
  let executions = 0;
  const executor = createTediousExecutor(
    mockConnection((request) => {
      executions += 1;
      emit(request, "requestCompleted");
    }),
  );
  await assert.doesNotReject(async () =>
    executor.query(sql`SELECT ${sql.bind(12.34, mssqlParameter.decimal(19, 4))}`.render()),
  );
  assert.equal(executions, 1);
  await assert.rejects(
    async () => executor.query(sql`SELECT ${sql.bind("12.34" as never, mssqlParameter.decimal(19, 4))}`.render()),
    /compatibility inputs require a finite plain JavaScript number/u,
  );
  await assert.rejects(
    async () =>
      executor.query(sql`SELECT ${sql.bind(1_234_567_890_123_456 as never, mssqlParameter.money())}`.render()),
    /limited to 15 significant decimal digits/u,
  );
  await assert.rejects(
    async () => executor.query(sql`SELECT ${sql.bind(12.34567, mssqlParameter.smallmoney())}`.render()),
    /four fractional|exceeds decimal/u,
  );
  assert.equal(executions, 1);
});

test("MSSQL prepared bulk rejects an unsafe aggregate affected-row count", async () => {
  const connection: TediousConnectionLike = {
    execSql() {
      throw new Error("bulk must use prepare/execute/unprepare");
    },
    prepare(request) {
      Object.assign(request, { preparing: true });
      completeRequest(request);
    },
    execute(request) {
      completeRequest(request, undefined, Number.MAX_SAFE_INTEGER);
    },
    unprepare(request) {
      completeRequest(request);
    },
    beginTransaction() {},
    commitTransaction() {},
    rollbackTransaction() {},
    saveTransaction() {},
  };
  const statement = sql.command`UPDATE account SET amount = ${1}`.render();
  const bulk: RenderedBulk = { statement, parameterSets: [[1], [2]] };
  const executor = createTediousExecutor(connection);
  const binding = executor.statementBinding.describeBulk!(bulk, { dialectId: "mssql", requestedReuse: "auto" });
  await assert.rejects(async () => executor.bulk!(bulk, binding), { code: "BRAID_RESULT_EXACTNESS" });
});

test("MSSQL direct adapters reject pool connections while pool leases release once", async () => {
  let releases = 0;
  const connection = {
    execSql() {},
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
    release() {
      releases += 1;
    },
  };
  assert.throws(() => createTediousExecutor(connection), /not a pool/u);
  const lease = await createTediousPoolProvider({ acquire: async () => connection }).acquire();
  await lease.release();
  const discarded = await createTediousPoolProvider({ acquire: async () => connection }).acquire();
  await assert.rejects(
    async () => discarded.release({ discard: true }),
    (error: unknown) => (error as { readonly code?: string }).code === "BRAID_RESOURCE_CLEANUP",
  );
  assert.equal(releases, 1);
});

test("MSSQL pooled readOnly options preflight before acquire and leave the pool usable", async () => {
  let acquires = 0;
  let begins = 0;
  const connection: TediousConnectionLike & { release(): void } = {
    execSql(request) {
      emit(request, "columnMetadata", [{ colName: "value", type: "Int" }]);
      emit(request, "row", [{ value: 1 }]);
      emit(request, "doneInProc", 1);
      emit(request, "requestCompleted");
    },
    beginTransaction(callback: (error?: unknown) => void) {
      begins += 1;
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
    release() {},
  };
  const db = createTediousPoolDatabase({
    acquire: async () => {
      acquires += 1;
      return connection;
    },
  });
  for (const readOnly of [false, true]) {
    await assert.rejects(
      () => db.tx({ readOnly }, async () => undefined),
      (error: unknown) =>
        error instanceof UnsupportedFeatureError &&
        error.code === "BRAID_TX_OPTION_UNSUPPORTED" &&
        error.feature === "transaction.read-only",
    );
  }
  assert.equal(acquires, 0);
  assert.equal(begins, 0);
  await db.tx({ isolation: "serializable" }, async (tx) => {
    assert.deepEqual(await tx.one(sql.rows`SELECT 1 AS value`), { value: "1" });
  });
  assert.equal(acquires, 1);
  assert.equal(begins, 1);
  assert.deepEqual(await db.one(sql.rows`SELECT 1 AS value`), { value: "1" });
});

test("MSSQL calls accept OUTPUT text in literals and comments", async () => {
  const executor = createTediousExecutor(
    mockConnection((request) => {
      emit(request, "columnMetadata", [{ colName: "value", type: "Int" }]);
      emit(request, "row", [{ value: 1 }]);
      emit(request, "doneInProc", 1);
      emit(request, "requestCompleted");
    }),
  );
  assert.ok(executor.call);
  const result = await executor.call(sql.call`SELECT 'OUTPUT' AS value /* OUTPUT */`.render());
  assert.deepEqual(
    result.resultSets.map((set) => set.rows),
    [[{ value: "1" }]],
  );
});

test("MSSQL query rejects actual output return values instead of discarding them", async () => {
  const executor = createTediousExecutor(
    mockConnection((request) => {
      emit(request, "returnValue", "answer", 42);
      emit(request, "requestCompleted");
    }),
  );
  await assert.rejects(async () => executor.query(sql`SELECT 1`.render()), /BRAID_CALL_OUT_UNSUPPORTED/u);
});

test("MSSQL result labels remain own properties on ordinary rows", async () => {
  const executor = createTediousExecutor(
    mockConnection((request) => {
      emit(request, "columnMetadata", [
        { colName: "__proto__", type: "NVarChar" },
        { colName: "constructor", type: "NVarChar" },
        { colName: "prototype", type: "NVarChar" },
        { colName: "toString", type: "NVarChar" },
        { colName: "hasOwnProperty", type: "NVarChar" },
      ]);
      emit(request, "row", [
        { value: "proto" },
        { value: "constructor" },
        { value: "prototype" },
        { value: "toString" },
        { value: "hasOwnProperty" },
      ]);
      emit(request, "doneInProc", 1);
      emit(request, "requestCompleted");
    }),
  );
  const row = (await executor.query(sql`SELECT 1`.render())).rows[0] as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  for (const key of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
    assert.equal(Object.hasOwn(row, key), true);
    assert.equal(row[key], key === "__proto__" ? "proto" : key);
  }
});

test("MSSQL prepared protocol failures use the canonical prepare error", async () => {
  const statement = sql.command`INSERT INTO account (id) VALUES (${1})`.render();
  const bulk: RenderedBulk = { statement, parameterSets: [[1]] };
  const cases: readonly [string, TediousConnectionLike][] = [
    [
      "prepare",
      {
        execSql() {},
        execute() {},
        unprepare() {},
        beginTransaction() {},
        commitTransaction() {},
        rollbackTransaction() {},
        saveTransaction() {},
      },
    ],
    [
      "execute",
      {
        execSql() {},
        prepare() {},
        unprepare() {},
        beginTransaction() {},
        commitTransaction() {},
        rollbackTransaction() {},
        saveTransaction() {},
      },
    ],
    [
      "unprepare",
      {
        execSql() {},
        prepare() {},
        execute() {},
        beginTransaction() {},
        commitTransaction() {},
        rollbackTransaction() {},
        saveTransaction() {},
      },
    ],
  ];
  for (const [, connection] of cases) {
    const executor = createTediousExecutor(connection);
    const binding = executor.statementBinding.describeBulk!(bulk, { dialectId: "mssql", requestedReuse: "auto" });
    await assert.rejects(
      async () => await executor.bulk!(bulk, binding),
      (error: unknown) =>
        error instanceof UnsupportedFeatureError &&
        error.feature === "statement.prepare" &&
        error.code === "BRAID_PREPARE_UNSUPPORTED",
    );
  }
  const lateUnprepare = {
    execSql() {},
    prepare(request: TediousRequestLike) {
      delete (lateUnprepare as unknown as { unprepare?: unknown }).unprepare;
      completeRequest(request);
    },
    execute(request: TediousRequestLike) {
      completeRequest(request, undefined, 1);
    },
    unprepare() {},
    beginTransaction() {},
    commitTransaction() {},
    rollbackTransaction() {},
    saveTransaction() {},
  } as TediousConnectionLike;
  const executor = createTediousExecutor(lateUnprepare);
  const binding = executor.statementBinding.describeBulk!(bulk, { dialectId: "mssql", requestedReuse: "auto" });
  await assert.rejects(
    async () => await executor.bulk!(bulk, binding),
    (error: unknown) => {
      const cause = error instanceof AggregateError ? error.errors[0] : (error as { readonly cause?: unknown }).cause;
      return (
        (error as { readonly code?: string }).code === "BRAID_RESOURCE_CLEANUP" &&
        cause instanceof UnsupportedFeatureError &&
        cause.feature === "statement.prepare" &&
        cause.code === "BRAID_PREPARE_UNSUPPORTED"
      );
    },
  );
});

test("MSSQL pre-aborted executions preserve a null AbortSignal reason", async () => {
  let executed = false;
  const executor = createTediousExecutor(
    mockConnection(() => {
      executed = true;
    }),
  );
  await assert.rejects(
    async () => executor.query(sql`SELECT 1`.render(), undefined, { signal: AbortSignal.abort(null) }),
    (error: unknown) => error === null,
  );
  assert.equal(executed, false);
});

test("MSSQL stream callback failures preserve public adapter error classes and codes", async () => {
  const cases: readonly {
    readonly emit: (request: TediousRequestLike) => void;
    readonly code: "BRAID_CALL_OUT_UNSUPPORTED" | "BRAID_STREAM_UNSUPPORTED" | "BRAID_RESULT_SETS_UNSUPPORTED";
  }[] = [
    {
      emit: (request) => emit(request, "returnValue", "answer", 42),
      code: "BRAID_CALL_OUT_UNSUPPORTED",
    },
    {
      emit: () => {},
      code: "BRAID_STREAM_UNSUPPORTED",
    },
    {
      emit: (request) => {
        emit(request, "columnMetadata", [{ colName: "value", type: "Int" }]);
        emit(request, "doneInProc", 1);
        emit(request, "doneInProc", 1);
      },
      code: "BRAID_RESULT_SETS_UNSUPPORTED",
    },
  ];
  for (const { emit: emitEvents, code } of cases) {
    const executor = createTediousExecutor(
      mockConnection((request) => {
        emitEvents(request);
        emit(request, "requestCompleted");
      }),
    );
    await assert.rejects(
      async () => {
        for await (const _row of executor.stream(sql.rows`SELECT 1`.render())) void _row;
      },
      (error: unknown) => error instanceof UnsupportedFeatureError && error.code === code,
    );
  }
});

test("MSSQL row decode failures reject and cancel the request", async () => {
  let cancelled = false;
  let activeRequest: TediousRequestLike | undefined;
  const executor = createTediousExecutor(
    mockConnection((request) => {
      activeRequest = request;
      (request as unknown as { cancel(): void }).cancel = () => {
        cancelled = true;
      };
      emit(request, "columnMetadata", [{ colName: "value", type: "Int" }]);
      emit(request, "row", [{ value: { value: 1 } }]);
    }),
    {
      typePolicy: {
        ...typePolicy,
        decode: () => {
          throw new Error("decode failed");
        },
      },
    },
  );
  let settled = false;
  const operation = executor.query(sql`SELECT 1`.render());
  const rejected = assert.rejects(Promise.resolve(operation), /decode failed/u).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(cancelled, true);
  assert.equal(settled, false, "The physical request must drain before the operation releases its connection.");
  assert.ok(activeRequest);
  emit(activeRequest, "requestCompleted");
  await rejected;
});

test("MSSQL validates transaction options before beginTransaction", async () => {
  let begins = 0;
  const executor = createTediousExecutor({
    ...mockConnection(() => {}),
    beginTransaction(callback: (error?: unknown) => void) {
      begins += 1;
      callback();
    },
  });
  await assert.rejects(
    async () => executor.begin!({ isolation: "invalid" as never }),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  await assert.rejects(
    async () => executor.begin!({ readOnly: "yes" as never }),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  await assert.rejects(
    async () => executor.begin!({ unsupported: true } as never),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  assert.equal(begins, 0);
});

test("MSSQL prepared cancellation waits for native prepare drain", async () => {
  let active: TediousRequestLike | undefined;
  let cancelled = false;
  let executed = false;
  let unprepared = false;
  const connection: TediousConnectionLike = {
    execSql() {},
    prepare(request) {
      active = request;
      const cancel = request.cancel;
      request.cancel = () => {
        cancelled = true;
        cancel?.call(request);
      };
    },
    execute() {
      executed = true;
    },
    unprepare() {
      unprepared = true;
    },
    beginTransaction() {},
    commitTransaction() {},
    rollbackTransaction() {},
    saveTransaction() {},
  };
  const executor = createTediousExecutor(connection);
  const bulk = {
    statement: sql.command`INSERT INTO account (id) VALUES (${1})`.render(),
    parameterSets: [[1]],
  } as unknown as RenderedBulk;
  const binding = executor.statementBinding.describeBulk!(bulk, { dialectId: "mssql", requestedReuse: "auto" });
  const controller = new AbortController();
  let settled = false;
  const pending = Promise.resolve(executor.bulk!(bulk, binding, { signal: controller.signal })).finally(() => {
    settled = true;
  });
  assert.ok(active);
  const reason = new Error("mssql prepare cancelled");
  controller.abort(reason);
  await Promise.resolve();
  assert.equal(cancelled, true);
  assert.equal(settled, false);
  completeRequest(active, reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(executed, false);
  assert.equal(unprepared, false);
});
