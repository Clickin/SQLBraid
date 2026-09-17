import { defineResultProperty } from "@sqlbraid/core/driver";
import { sql } from "@sqlbraid/sqlite";
import type { RowQuery } from "@sqlbraid/core";
import { createSqliteWasmDatabase, type SqliteWasmDatabaseLike, type SqliteWasmStatementLike } from "@sqlbraid/sqlite/wasm";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationFixture, CertificationTarget, ExpectedCapabilityContract, ResourceSnapshot, TransactionOptionKey, UnsupportedProbe } from "../types.js";

interface Sqlite3Like {
  readonly version: { readonly libVersion: string };
  readonly capi: {
    readonly SQLITE_INTEGER: number;
    sqlite3_column_type(statement: number, column: number): number;
    sqlite3_column_int64(statement: number, column: number): bigint;
  };
  readonly oo1: { readonly DB: new (filename: string) => SqliteWasmDatabaseLike & { close(): void } };
}

interface NativeStats {
  prepares: number;
  active: number;
  finalizeCalls: number;
  releaseCalls: number;
  finalizeByStatement: number[];
}

interface NativeFaults {
  readonly initFailure: unknown;
  readonly firstNextFailure: unknown;
  readonly midStreamFailure: unknown;
  readonly cleanupFailure: unknown;
}

function expectedObject(key: string, value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  defineResultProperty(result, key, value);
  return result;
}

function targetCapabilities(): ExpectedCapabilityContract {
  return {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["bigint", "string"] },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "session.pinned": { status: "guaranteed" },
    transaction: { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
    "transaction.isolation.read-uncommitted": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
    "transaction.isolation.read-committed": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
    "transaction.isolation.repeatable-read": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
    "transaction.isolation.serializable": { status: "guaranteed" },
    "statement.prepare": { status: "guaranteed" },
    "statement.stream": { status: "guaranteed" },
    "statement.cancel": { status: "unsupported", unsupportedCode: "BRAID_CANCEL_UNSUPPORTED" },
    "statement.bulk": { status: "guaranteed" },
    "routine.call": { status: "unsupported", unsupportedCode: "BRAID_CALL_UNSUPPORTED" },
    "routine.out": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
    "routine.inout": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
    "routine.result-sets": { status: "unsupported", unsupportedCode: "BRAID_CALL_RESULT_SETS" },
    "routine.out-cursor": { status: "unsupported", unsupportedCode: "BRAID_CALL_CURSOR_UNSUPPORTED" },
    "routine.return-value": { status: "unsupported", unsupportedCode: "BRAID_CALL_UNSUPPORTED" },
  };
}

const expectedTransactionOptions: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> = {
  "isolation:read-uncommitted": "unsupported",
  "isolation:read-committed": "unsupported",
  "isolation:repeatable-read": "unsupported",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "unsupported",
  "readOnly:false": "unsupported",
  "combination:read-uncommitted+readOnly": "unsupported",
  "combination:read-uncommitted+readWrite": "unsupported",
  "combination:read-committed+readOnly": "unsupported",
  "combination:read-committed+readWrite": "unsupported",
  "combination:repeatable-read+readOnly": "unsupported",
  "combination:repeatable-read+readWrite": "unsupported",
  "combination:serializable+readOnly": "unsupported",
  "combination:serializable+readWrite": "unsupported",
};

function wrapNative(native: SqliteWasmDatabaseLike, stats: NativeStats, faults: NativeFaults): SqliteWasmDatabaseLike & { close(): void } {
  const database = native as SqliteWasmDatabaseLike & { close(): void };
  return {
    prepare(sqlText: string) {
      stats.prepares += 1;
      const statement = database.prepare(sqlText);
      if (sqlText.includes("__cert_init_failure__")) {
        statement.finalize();
        throw faults.initFailure;
      }
      stats.active += 1;
      let finalized = false;
      stats.finalizeByStatement.push(0);
      const statementIndex = stats.finalizeByStatement.length - 1;
      let stepCalls = 0;
      const exposed: SqliteWasmStatementLike = {
        get columnCount() { return statement.columnCount; },
        get pointer() { return statement.pointer; },
        bind(...values) { statement.bind(...values); return exposed; },
        step() {
          stepCalls += 1;
          if (sqlText.includes("__cert_first_next_failure__") && stepCalls === 1) throw faults.firstNextFailure;
          if (sqlText.includes("__cert_mid_stream_failure__") && stepCalls === 2) throw faults.midStreamFailure;
          return statement.step();
        },
        stepReset() { statement.stepReset?.(); return exposed; },
        reset(alsoClearBinds) { statement.reset(alsoClearBinds); return exposed; },
        get(index) { return statement.get(index); },
        getColumnName(index) { return statement.getColumnName(index); },
        finalize() {
          if (finalized) throw new Error("SQLite WASM statement finalized twice.");
          finalized = true;
          stats.finalizeByStatement[statementIndex] = 1;
          stats.finalizeCalls += 1;
          try {
            statement.finalize();
          } finally {
            stats.releaseCalls += 1;
            stats.active -= 1;
          }
          if (sqlText.includes("__cert_cleanup_failure__")) throw faults.cleanupFailure;
        },
      };
      return exposed;
    },
    exec: database.exec.bind(database),
    changes: database.changes?.bind(database),
    close: database.close.bind(database),
  };
}

function buildQueries(stats: NativeStats): CertificationFixture["queries"] {
  let preparedCalls = 0;
  const special: CertificationFixture["queries"]["special"] = {
    RES001: sql.rows`SELECT 'safe' AS "__proto__"`,
    RES002: sql.rows`SELECT 'safe' AS "constructor"`,
    RES003: sql.rows`SELECT 'safe' AS "prototype"`,
    RES004: sql.rows`SELECT 'safe' AS "toString"`,
    RES005: sql.rows`SELECT 'safe' AS "hasOwnProperty"`,
    RES006: sql.rows`SELECT 'hello' AS value`,
    RES007: sql.rows`SELECT '' AS value`,
    RES008: sql.rows`SELECT NULL AS value`,
    RES009: sql.rows`SELECT '안녕하세요' AS value`,
    RES010: sql.rows`SELECT ${new Uint8Array([0, 255, 16])} AS value`,
    RES011: sql.rows`SELECT 'left' AS duplicate, 'right' AS duplicate`,
  };
  const many = sql.rows`SELECT 'one' AS value UNION ALL SELECT 'two' AS value`;
  const stream = sql.rows`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 3) SELECT value FROM n ORDER BY value`;
  const command = sql.command`INSERT INTO cert_values (value) VALUES (${"command"})`;
  const identity = sql.rows`SELECT id FROM temp.cert_identity` as RowQuery<{ readonly id: string }>;
  const failure = sql.rows`SELECT * FROM cert_missing_table`;
  const preparedRows = (_input: unknown) => {
    preparedCalls += 1;
    return sql.rows`SELECT 'one' AS value UNION ALL SELECT 'two' AS value`;
  };
  const preparedCommand = (_input: unknown) => {
    preparedCalls += 1;
    return sql.command`INSERT INTO cert_values (value) VALUES (${"prepared"})`;
  };
  const call = sql.call`SELECT 1`;
  const out = sql.call`SELECT ${sql.out("answer")}`;
  const inout = sql.call`SELECT ${sql.inOut("answer", 1)}`;
  const transaction = {
    insert: sql.command`INSERT INTO cert_values (value) VALUES (${"transaction"})`,
    visible: sql.rows`SELECT value FROM cert_values WHERE value IN ('transaction', 'savepoint')`,
    savepointInsert: sql.command`INSERT INTO cert_values (value) VALUES (${"savepoint"})`,
    savepointVisible: sql.rows`SELECT value FROM cert_values WHERE value = 'savepoint'`,
  };
  return {
    zero: sql.rows`SELECT value FROM cert_values WHERE 0`,
    one: sql.rows`SELECT 'one' AS value`,
    many,
    command,
    identity,
    failure,
    stream,
    special,
    transaction,
    prepared: {
      command: preparedCommand,
      rows: preparedRows,
      input: "prepared-input",
      factoryCalls: () => preparedCalls,
      resources: () => stats.active,
    },
    routines: { call, out, inout, resultSets: call, cursor: call, returnValue: call },
    fidelity: {
      largeExactInteger: sql.rows`SELECT ${9223372036854775807n} AS value`,
      exactDecimal: sql.rows`SELECT ${"12345678901234567890.123456789"} AS value`,
      temporal: sql.rows`SELECT ${"2026-09-14T12:34:56.789Z"} AS value`,
      injection: sql.rows`SELECT ${"'); UPDATE cert_sentinel SET marker = 'mutated' WHERE id = 1; --"} AS value, (SELECT marker FROM cert_sentinel WHERE id = 1) AS sentinel`,
      expected: {
        largeExactInteger: { value: "9223372036854775807" },
        exactDecimal: { value: "12345678901234567890.123456789" },
        temporal: { value: "2026-09-14T12:34:56.789Z" },
        injection: { value: "'); UPDATE cert_sentinel SET marker = 'mutated' WHERE id = 1; --", sentinel: "untouched" },
      },
    },
    expected: {
      one: { value: "one" },
      many: [{ value: "one" }, { value: "two" }],
      special: {
        RES001: expectedObject("__proto__", "safe"),
        RES002: expectedObject("constructor", "safe"),
        RES003: expectedObject("prototype", "safe"),
        RES004: expectedObject("toString", "safe"),
        RES005: expectedObject("hasOwnProperty", "safe"),
        RES006: { value: "hello" },
        RES007: { value: "" },
        RES008: { value: null },
        RES009: { value: "안녕하세요" },
        RES010: { value: new Uint8Array([0, 255, 16]) },
        RES011: { value: "left" },
      },
      commandAffectedRows: 1,
      specialErrors: { RES011: { code: "BRAID_RESULT_COLUMNS" } },
    },
  };
}

function optionsProbe(
  db: CertificationFixture["db"],
  options: Parameters<NonNullable<CertificationFixture["db"]["tx"]>>[0],
  expectedErrorFeature: string,
  expectedCode: `BRAID_${string}`,
  stats: NativeStats,
): UnsupportedProbe {
  return {
    feature: expectedErrorFeature,
    expectedCode,
    run: () => db.tx(options as never, async () => undefined),
    sideEffects: () => stats.prepares,
  };
}

export function createSqliteWasmTarget(sqlite3: Sqlite3Like, sourceSha: string): CertificationTarget {
  const expectedCapabilities = targetCapabilities();
  return {
    id: `sqlite-wasm-browser-${sqlite3.version.libVersion.replaceAll(".", "-")}`,
    sourceSha,
    expectedCapabilities,
    expectedTransactionOptions,
    createFixture: async (): Promise<CertificationFixture> => {
      const native = new sqlite3.oo1.DB(":memory:");
      const stats: NativeStats = { prepares: 0, active: 0, finalizeCalls: 0, releaseCalls: 0, finalizeByStatement: [] };
      const faults: NativeFaults = {
        initFailure: new Error("certification stream initialization failure"),
        firstNextFailure: new Error("certification stream first-next failure"),
        midStreamFailure: new Error("certification stream mid-stream failure"),
        cleanupFailure: new Error("certification cleanup failure"),
      };
      const observed = wrapNative(native, stats, faults);
      observed.exec("CREATE TABLE cert_values (value TEXT NOT NULL)");
      observed.exec("CREATE TABLE cert_sentinel (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)");
      observed.exec("INSERT INTO cert_sentinel (id, marker) VALUES (1, 'untouched')");
      observed.exec("CREATE TEMP TABLE cert_identity (id TEXT NOT NULL)");
      observed.exec("INSERT INTO temp.cert_identity (id) VALUES ('sqlite-wasm-browser')");
      const db = createSqliteWasmDatabase(observed, { sqlite3 });
      const queries = buildQueries(stats);
      const transactionCleanup = async (): Promise<void> => {
        const primary = new Error("cert-transaction-cleanup");
        let caught: unknown;
        try {
          await db.tx(async (tx) => {
            await tx.execute(queries.transaction!.insert);
            observed.exec("COMMIT");
            throw primary;
          });
        } catch (error) {
          caught = error;
        }
        if (!(caught instanceof AggregateError) || !caught.errors.includes(primary)) {
          throw new Error("SQLite WASM transaction cleanup did not aggregate the native rollback failure.", { cause: caught });
        }
      };
      const unsupported: NonNullable<CertificationFixture["unsupported"]> = {
        STR006: { feature: "statement.cancel", expectedCode: "BRAID_CANCEL_UNSUPPORTED", run: async () => { const controller = new AbortController(); for await (const row of db.stream(queries.stream!, { signal: controller.signal })) { void row; controller.abort(new Error("cancel")); } }, sideEffects: () => stats.prepares },
        STR010: { feature: "statement.cancel", expectedCode: "BRAID_CANCEL_UNSUPPORTED", run: async () => { const controller = new AbortController(); for await (const row of db.stream(queries.stream!, { signal: controller.signal })) { void row; controller.abort(new Error("cancel")); } }, sideEffects: () => stats.prepares },
        PRE011: { feature: "statement.cancel", expectedCode: "BRAID_CANCEL_UNSUPPORTED", run: async () => { const controller = new AbortController(); for await (const row of db.stream(queries.stream!, { signal: controller.signal })) { void row; controller.abort(new Error("cancel")); } }, sideEffects: () => stats.prepares },
        PRE008: { feature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => db.call(queries.routines!.call), sideEffects: () => stats.prepares },
        CALL001: { feature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => db.call(queries.routines!.call), sideEffects: () => stats.prepares },
        CALL002: { feature: "routine.out", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => db.call(queries.routines!.out!), sideEffects: () => stats.prepares },
        CALL003: { feature: "routine.inout", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => db.call(queries.routines!.inout!), sideEffects: () => stats.prepares },
        CALL004: { feature: "routine.result-sets", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => db.call(queries.routines!.resultSets!), sideEffects: () => stats.prepares },
        CALL005: { feature: "routine.out-cursor", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => db.call(queries.routines!.cursor!), sideEffects: () => stats.prepares },
        CALL006: { feature: "routine.return-value", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => db.call(queries.routines!.returnValue!), sideEffects: () => stats.prepares },
        CALL007: { feature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => db.call(queries.routines!.call), sideEffects: () => stats.prepares },
        TX020: optionsProbe(db, { isolation: "read-uncommitted" }, "transaction.isolation.read-uncommitted", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX021: optionsProbe(db, { readOnly: true }, "transaction.read-only", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX022: optionsProbe(db, { isolation: "read-committed", readOnly: true }, "transaction.isolation.read-committed", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX023: optionsProbe(db, { isolation: "read-committed" }, "transaction.isolation.read-committed", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX024: optionsProbe(db, { isolation: "repeatable-read" }, "transaction.isolation.repeatable-read", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX026: optionsProbe(db, { readOnly: false }, "transaction.read-only", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX027: optionsProbe(db, { isolation: "read-uncommitted", readOnly: true }, "transaction.isolation.read-uncommitted", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX028: optionsProbe(db, { isolation: "serializable", readOnly: true }, "transaction.read-only", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX029: optionsProbe(db, { isolation: "read-uncommitted", readOnly: false }, "transaction.isolation.read-uncommitted", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX030: optionsProbe(db, { isolation: "read-committed", readOnly: false }, "transaction.isolation.read-committed", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX031: optionsProbe(db, { isolation: "repeatable-read", readOnly: true }, "transaction.isolation.repeatable-read", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX032: optionsProbe(db, { isolation: "repeatable-read", readOnly: false }, "transaction.isolation.repeatable-read", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
        TX033: optionsProbe(db, { isolation: "serializable", readOnly: false }, "transaction.read-only", "BRAID_TX_OPTION_UNSUPPORTED", stats) as never,
      };
      const mappingFailure = new Error("cert-mapper-failure");
      const executionSchemaFailure = new Error("execution schema failed");
      const mappingSchema = {
        "~standard": {
          version: 1,
          vendor: "sqlbraid-wasm-certification",
          validate() {
            throw mappingFailure;
          },
        },
      } as const;
      const mappingQuery = sql.rows(mappingSchema)`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 3) SELECT value FROM n ORDER BY value`;
      const initFailureQuery = sql.rows`SELECT 1 AS value /* __cert_init_failure__ */`;
      const firstNextFailureQuery = sql.rows`SELECT 1 AS value /* __cert_first_next_failure__ */`;
      const midStreamFailureQuery = sql.rows`SELECT value FROM (SELECT 1 AS value UNION ALL SELECT 2 AS value) /* __cert_mid_stream_failure__ */`;
      const largeResultQuery = sql.rows`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 10000) SELECT value FROM n`;
      const streamFixture: StreamingConformanceFixture<unknown> & Record<string, unknown> = {
        db,
        query: queries.stream!,
        expected: [{ value: "1" }, { value: "2" }, { value: "3" }],
        mappingQuery,
        mappingFailure,
        executionSchemaFailure,
        initFailure: faults.initFailure,
        firstNextFailure: faults.firstNextFailure,
        midStreamFailure: faults.midStreamFailure,
        initFailureQuery,
        firstNextFailureQuery,
        midStreamFailureQuery,
        cleanupFailureQuery: sql.rows`SELECT 1 AS value /* __cert_cleanup_failure__ */`,
        cleanupFailure: faults.cleanupFailure,
        iteratorReturns: () => stats.finalizeCalls,
        released: () => stats.releaseCalls,
        initFailureCleanup: { iteratorReturns: 0, released: 0 },
        reuseAfterBreak: async () => {
          const row = await db.one(queries.identity);
          if (row.id !== "sqlite-wasm-browser") throw new Error("SQLite WASM stream reuse changed physical session identity.");
        },
        largeResultQuery,
        largeResultCount: 10000,
      };
      let bulkAcquires = 0;
      let bulkExecutes = 0;
      const bulkDb = {
        bulk: async (...args: Parameters<typeof db.bulk>) => {
          const [inputs] = args;
          if (inputs.length === 0) return db.bulk(...args);
          bulkAcquires += 1;
          try {
            return await db.bulk(...args);
          } finally {
            bulkExecutes += 1;
          }
        },
      };
      const bulk: BulkConformanceFixture<unknown> = {
        db: bulkDb as BulkConformanceFixture<unknown>["db"],
        inputs: [1, 2],
        factory: (input) => sql.command`INSERT INTO cert_values (value) VALUES (${String(input)})`,
        expected: { inputCount: 2, affectedRows: 2 },
        acquireCount: () => bulkAcquires,
        executeCount: () => bulkExecutes,
        middleFailure: async () => {
          observed.exec("DELETE FROM cert_values");
          let error: unknown;
          try {
            await db.bulk([1, null, 3], (input) => sql.command`INSERT INTO cert_values (value) VALUES (${input})`);
          } catch (caught) {
            error = caught;
          }
          if (error === undefined) throw new Error("SQLite WASM bulk middle-item failure was not observed.");
          if (!String((error as { readonly message?: unknown }).message).includes("NOT NULL constraint failed")) {
            throw new Error("SQLite WASM bulk middle-item failure was not the native NOT NULL constraint.", { cause: error });
          }
          const observedRows = await db.all(sql.rows<{ readonly value: string }>`SELECT value FROM cert_values ORDER BY rowid`);
          const prefixRows = [{ value: "1.0" }];
          const atomicRows: typeof prefixRows = [];
          const observedText = JSON.stringify(observedRows);
          if (observedText === JSON.stringify(prefixRows)) {
            return { error, observedRows, expectedRows: prefixRows, durability: "prefix" as const };
          }
          if (observedText === JSON.stringify(atomicRows)) {
            return { error, observedRows, expectedRows: atomicRows, durability: "atomic" as const };
          }
          throw new Error(`SQLite WASM bulk middle-item durability was not the expected prefix or atomic state: ${observedText}.`);
        },
      };
      const metrics = {
        snapshot: (): ResourceSnapshot => ({ borrowedLeases: 0, cleanupBalance: stats.active, openCursors: stats.active, openPrepared: 0 }),
        sideEffects: () => stats.prepares,
        mutationSentinel: async () => {
          const row = await db.one(sql.rows<{ readonly marker: string }>`SELECT marker FROM cert_sentinel WHERE id = 1`);
          return row.marker;
        },
        readOnlyWrite: async () => {
          observed.exec("DELETE FROM cert_values");
          await db.tx(async (tx) => { await tx.execute(queries.transaction!.insert); });
          const before = await db.all(queries.transaction!.visible);
          if (before.length !== 1) throw new Error(`SQLite WASM read-write transaction proof expected one row, got ${before.length}.`);
          let error: unknown;
          try {
            await db.tx({ readOnly: true }, async (tx) => { await tx.execute(queries.transaction!.savepointInsert); });
          } catch (caught) {
            error = caught;
          }
          if ((error as { readonly code?: unknown } | undefined)?.code !== "BRAID_TX_OPTION_UNSUPPORTED") {
            throw new Error("SQLite WASM read-only transaction did not reject with BRAID_TX_OPTION_UNSUPPORTED.", { cause: error });
          }
          const after = await db.all(queries.transaction!.visible);
          if (after.length !== 1) throw new Error(`SQLite WASM read-only rejection changed state: ${after.length} rows.`);
        },
        transactionCleanup,
        physicalSessionIds: () => ["sqlite-wasm-browser"],
      };
      return {
        db,
        queries,
        stream: streamFixture,
        bulk,
        metrics,
        reset: async () => {
          stats.finalizeCalls = 0;
          stats.releaseCalls = 0;
          stats.finalizeByStatement.length = 0;
          observed.exec("DELETE FROM cert_values");
          observed.exec("UPDATE cert_sentinel SET marker = 'untouched' WHERE id = 1");
        },
        unsupported,
        close: async () => { observed.close(); },
      };
    },
  };
}

export type { Sqlite3Like };
