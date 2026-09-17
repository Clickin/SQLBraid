import type {
  BulkBindingDescription,
  BulkExecutionResult,
  DatabaseOptions,
  DriverRoutineResult,
  DriverEnvironment,
  ExecutionOptions,
  QueryExecutor,
  QueryExecutionResult,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
  TransactionOptions,
} from "@sqlbraid/core";
import {
  AdapterError,
  createBulkBindingDescription,
  createRenderedStatement,
  createStatementBindingDescription,
  ResultExactnessError,
  normalizeExactInteger,
  safeDatabaseCount,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { assertSavepointName, createCleanupScope, defineResultProperty } from "@sqlbraid/core/driver";
import { createDatabase, DatabaseResultKindError } from "@sqlbraid/runtime";
import { typePolicy } from "./type-policy.js";

/** The subset of the official @sqlite.org/sqlite-wasm OO1 DB used by SQLBraid. */
export interface SqliteWasmStatementLike {
  readonly columnCount: number;
  readonly pointer?: number;
  bind(...values: readonly unknown[]): SqliteWasmStatementLike;
  step(): boolean;
  stepReset?(): SqliteWasmStatementLike;
  reset(alsoClearBinds?: boolean): SqliteWasmStatementLike;
  get(index: number): unknown;
  getColumnName(index: number): string;
  finalize(): unknown;
}

/** The subset of the official @sqlite.org/sqlite-wasm OO1 DB used by SQLBraid. */
export interface SqliteWasmDatabaseLike {
  prepare(sql: string): SqliteWasmStatementLike;
  exec(sql: string): unknown;
  changes?(total?: boolean, sixtyFour?: boolean): number | bigint;
}

export interface SqliteWasmExecutorOptions {
  /** Initialized module required for row reads; command-only usage may omit it. */
  readonly sqlite3?: {
    readonly capi: {
      readonly SQLITE_INTEGER: number;
      sqlite3_column_type(statement: number, column: number): number;
      sqlite3_column_int64(statement: number, column: number): bigint;
    };
  };
}

export interface SqliteWasmDatabaseOptions extends DatabaseOptions, SqliteWasmExecutorOptions {}

type SqliteWasmCapi = NonNullable<SqliteWasmExecutorOptions["sqlite3"]>["capi"];

function assertRoutineUnsupported(rendered: RenderedStatement): void {
  if (rendered.resultKind === "call" || rendered.routineProcedure !== undefined) {
    throw new UnsupportedFeatureError(
      "routine.call",
      "BRAID_CALL_UNSUPPORTED",
      "SQLite WASM adapter does not support routine calls.",
    );
  }
}

function assertRoutineParametersUnsupported(rendered: RenderedStatement): void {
  for (const parameter of rendered.parameters) {
    if (parameter.direction === "inout") {
      throw new UnsupportedFeatureError(
        "routine.inout",
        "BRAID_CALL_OUT_UNSUPPORTED",
        "SQLite WASM does not expose a routine INOUT parameter carrier.",
      );
    }
    if (parameter.direction === "out" || parameter.outputName !== undefined) {
      throw new UnsupportedFeatureError(
        "routine.out",
        "BRAID_CALL_OUT_UNSUPPORTED",
        "SQLite WASM does not expose a routine OUT parameter carrier.",
      );
    }
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "SQLite WASM adapter does not support explicit bind type hints.",
    );
  }
}

function assertWasmValue(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new AdapterError("BRAID_BIND_VALUE_UNSUPPORTED", "SQLite WASM binds require finite numbers.");
    return;
  }
  if (typeof value === "bigint") {
    if (BigInt.asIntN(64, value) !== value)
      throw new RangeError("BRAID_INTEGER_UNSAFE: SQLite WASM INTEGER binds must fit signed 64-bit range.");
    return;
  }
  if (
    (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) ||
    (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value))
  )
    return;
  throw new AdapterError(
    "BRAID_BIND_VALUE_UNSUPPORTED",
    "SQLite WASM binds support SQLite scalar values and binary buffers.",
  );
}

function assertWasmValues(values: readonly unknown[]): void {
  for (const value of values) assertWasmValue(value);
}

function assertExecutionOptions(options?: ExecutionOptions): void {
  const signal = options?.signal;
  if (signal === undefined) return;
  if (signal.aborted) throw signal.reason;
  throw new UnsupportedFeatureError(
    "statement.cancel",
    "BRAID_CANCEL_UNSUPPORTED",
    "SQLite WASM does not expose a safe statement cancellation primitive.",
  );
}

function unsupportedTransactionOption(feature: string, option: string): never {
  throw new UnsupportedFeatureError(
    feature,
    "BRAID_TX_OPTION_UNSUPPORTED",
    `SQLite WASM does not support transaction option ${option}.`,
  );
}

function invalidTransactionOptions(message: string): never {
  const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: ${message}`) as TypeError & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
  throw error;
}

function validateTransactionOptions(options?: TransactionOptions): void {
  if (options === undefined) return;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    invalidTransactionOptions("transaction options must be an object.");
  }
  const unexpected = Object.keys(options).find((key) => key !== "isolation" && key !== "readOnly");
  if (unexpected !== undefined) invalidTransactionOptions(`Unknown SQLite transaction option: ${unexpected}.`);
  const candidate = options as TransactionOptions & { readonly isolation?: unknown; readonly readOnly?: unknown };
  if (candidate.readOnly !== undefined && typeof candidate.readOnly !== "boolean") {
    invalidTransactionOptions("transaction readOnly must be boolean.");
  }
  if (
    candidate.isolation !== undefined &&
    candidate.isolation !== "read-uncommitted" &&
    candidate.isolation !== "read-committed" &&
    candidate.isolation !== "repeatable-read" &&
    candidate.isolation !== "serializable"
  ) {
    invalidTransactionOptions("transaction isolation is not a supported standard literal.");
  }
}

function assertCommand(rendered: RenderedStatement): void {
  if (rendered.resultKind !== "command")
    throw new Error("BRAID_BULK_SHAPE: SQLite WASM bulk requires command queries.");
  if (rendered.parameters.some((parameter) => (parameter.direction ?? "in") !== "in")) {
    throw new Error("BRAID_BULK_SHAPE: SQLite WASM bulk does not support OUT or INOUT parameters.");
  }
}

function bind(statement: SqliteWasmStatementLike, values: readonly unknown[]): void {
  if (values.length > 0) statement.bind(values);
}

function columnNames(statement: SqliteWasmStatementLike): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < statement.columnCount; index += 1) {
    const name = statement.getColumnName(index);
    if (seen.has(name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate SQLite result label ${name}.`);
    seen.add(name);
    names.push(name);
  }
  return names;
}

function assertExactIntegerReads(
  statement: SqliteWasmStatementLike,
  capi: SqliteWasmCapi | undefined,
): asserts capi is SqliteWasmCapi {
  if (
    capi === undefined ||
    capi === null ||
    capi.SQLITE_INTEGER !== 1 ||
    typeof capi.sqlite3_column_type !== "function" ||
    typeof capi.sqlite3_column_int64 !== "function"
  ) {
    throw new UnsupportedFeatureError(
      "result.exact-integer",
      "BRAID_INTEGER_MODE_UNSUPPORTED",
      "SQLite WASM row reads require an initialized sqlite3 CAPI.",
    );
  }
  if (statement.pointer === undefined) {
    throw new ResultExactnessError("SQLite WASM exact INTEGER reads require an official OO1 statement pointer.");
  }
}

function row(
  statement: SqliteWasmStatementLike,
  names: readonly string[],
  capi: SqliteWasmCapi,
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  const pointer = statement.pointer;
  if (pointer === undefined)
    throw new ResultExactnessError("SQLite WASM exact INTEGER reads require an official OO1 statement pointer.");
  for (const [index, name] of names.entries()) {
    defineResultProperty(
      value,
      name,
      capi.sqlite3_column_type(pointer, index) === capi.SQLITE_INTEGER
        ? normalizeExactInteger(capi.sqlite3_column_int64(pointer, index))
        : statement.get(index),
    );
  }
  return value;
}

function statementFinalizer(statement: SqliteWasmStatementLike): (failed: boolean, failure: unknown) => void {
  const cleanup = createCleanupScope();
  cleanup.add(() => {
    statement.finalize();
  });
  return (failed, failure): void => {
    if (failed) cleanup.run(failure);
    else cleanup.run();
  };
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();

export const sqliteWasmStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "sqlite-wasm",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertRoutineUnsupported(statement);
    assertRoutineParametersUnsupported(statement);
    assertParameterHintsUnsupported(statement);
    assertWasmValues(statement.parameters.map((parameter) => parameter.value));
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "sqlite-wasm",
      transport: "text-positional",
      placeholder: (index) => `?${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    assertRoutineParametersUnsupported(statement);
    assertCommand(statement);
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length)
        throw new Error("BRAID_BULK_SHAPE: SQLite WASM bulk parameter cardinality changed.");
      assertWasmValues(values);
    }
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "sqlite-wasm",
      transport: "text-positional",
      placeholder: (index) => `?${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    return description;
  },
});

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description =
    binding ??
    sqliteWasmStatementBinding.describe(statement, {
      dialectId: statement.dialectId,
      requestedReuse: "auto",
    });
  if (describedStatements.get(description) !== statement)
    throw new TypeError("BRAID_BINDING_IDENTITY: SQLite WASM description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined)
    throw new Error("BRAID_BIND_TRANSPORT: SQLite WASM binding description did not provide parameterized SQL.");
  return { text: description.parameterizedSql, values: statement.parameters.map((parameter) => parameter.value) };
}

function transactionControl(database: SqliteWasmDatabaseLike, sql: string): void {
  database.exec(sql);
}

function sqliteWasmEnvironment(rowReadsSupported: boolean): DriverEnvironment {
  return Object.freeze<DriverEnvironment>({
    database: { product: "sqlite" },
    driver: { id: "sqlite-wasm", profile: "sqlite-wasm-exact-string" },
    typePolicy: { id: typePolicy.id, hash: typePolicy.hash },
    capabilities: {
      "sql.native-transparency": { status: "guaranteed" },
      "numeric.exact-integer": rowReadsSupported
        ? { status: "guaranteed", canonical: "string", rawRepresentations: ["bigint", "string"] }
        : { status: "unsupported", conditionCode: "sqlite-wasm.initialized-capi" },
      "numeric.approximate-float": rowReadsSupported
        ? { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] }
        : { status: "unsupported", conditionCode: "sqlite-wasm.initialized-capi" },
      "session.pinned": { status: "guaranteed" },
      transaction: { status: "guaranteed" },
      "transaction.savepoint": { status: "guaranteed" },
      "transaction.read-only": { status: "unsupported" },
      "transaction.isolation.read-uncommitted": { status: "unsupported" },
      "transaction.isolation.read-committed": { status: "unsupported" },
      "transaction.isolation.repeatable-read": { status: "unsupported" },
      "transaction.isolation.serializable": { status: "guaranteed" },
      "statement.prepare": { status: "guaranteed" },
      "statement.cancel": { status: "unsupported" },
      "statement.stream": rowReadsSupported
        ? { status: "guaranteed" }
        : { status: "unsupported", conditionCode: "sqlite-wasm.initialized-capi" },
      "statement.bulk": { status: "guaranteed" },
      "routine.call": { status: "unsupported" },
      "routine.out": { status: "unsupported" },
      "routine.inout": { status: "unsupported" },
      "routine.return-value": { status: "unsupported" },
      "routine.result-sets": { status: "unsupported" },
      "routine.out-cursor": { status: "unsupported" },
    },
    probe: {
      statement: createRenderedStatement({
        segments: ["SELECT sqlite_version() AS version"],
        parameters: [],
        resultKind: "rows",
        dialectId: "sqlite",
      }),
      read: (rows) => {
        const row = rows[0];
        if (!row || typeof row !== "object" || Array.isArray(row)) return {};
        const version = (row as Record<string, unknown>).version;
        return typeof version === "string" ? { version } : {};
      },
    },
  });
}

export function createSqliteWasmExecutor(
  database: SqliteWasmDatabaseLike,
  options: SqliteWasmExecutorOptions = {},
): QueryExecutor {
  const capi = options.sqlite3?.capi;
  // Select a supported exact count transport before any statement can mutate data.
  database.changes?.(false, true);
  return {
    ownershipKey: database,
    statementBinding: sqliteWasmStatementBinding,
    environment: sqliteWasmEnvironment(capi !== undefined),
    query<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): QueryExecutionResult<Row> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      const finishStatement = statementFinalizer(statement);
      let failed = false;
      let failure: unknown;
      try {
        bind(statement, prepared.values);
        const names = columnNames(statement);
        if (names.length > 0) {
          assertExactIntegerReads(statement, capi);
          const rows: Record<string, unknown>[] = [];
          while (statement.step()) rows.push(row(statement, names, capi));
          return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
        }
        statement.step();
        const changes = database.changes === undefined ? undefined : safeDatabaseCount(database.changes(false, true));
        return { rows: [], rowCount: changes, kind: "command", command: { affectedRows: changes } };
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      } finally {
        finishStatement(failed, failure);
      }
    },
    bulk(bulk: RenderedBulk, binding: BulkBindingDescription, options?: ExecutionOptions): BulkExecutionResult {
      assertExecutionOptions(options);
      assertRoutineParametersUnsupported(bulk.statement);
      if (!binding || describedBulks.get(binding) !== bulk)
        throw new TypeError("BRAID_BINDING_IDENTITY: SQLite WASM bulk description belongs to another bulk or adapter.");
      const statement = createRenderedStatement(bulk.statement);
      assertCommand(statement);
      const text = binding.parameterizedSql;
      if (text === undefined)
        throw new Error("BRAID_BIND_TRANSPORT: SQLite WASM binding description did not provide parameterized SQL.");
      const native = database.prepare(text);
      const finishStatement = statementFinalizer(native);
      let failed = false;
      let failure: unknown;
      let affectedRows = 0;
      try {
        if (native.columnCount > 0) throw new Error("BRAID_BULK_SHAPE: SQLite WASM bulk requires a non-row statement.");
        for (let index = 0; index < bulk.parameterSets.length; index += 1) {
          bind(native, binding.valuesAt(index));
          if (native.stepReset !== undefined) native.stepReset();
          else {
            native.step();
            native.reset();
          }
          if (database.changes !== undefined) {
            affectedRows = safeDatabaseCount(affectedRows + safeDatabaseCount(database.changes(false, true)));
          }
        }
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      } finally {
        finishStatement(failed, failure);
      }
      return { inputCount: bulk.parameterSets.length, affectedRows, executionMode: "prepared-loop" };
    },
    call(
      rendered: RenderedStatement,
      _binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): DriverRoutineResult {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      throw new UnsupportedFeatureError(
        "routine.call",
        "BRAID_CALL_UNSUPPORTED",
        "SQLite WASM adapter does not support routine calls.",
      );
    },
    async *stream<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): AsyncGenerator<Row> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      const finishStatement = statementFinalizer(statement);
      let failed = false;
      let failure: unknown;
      try {
        bind(statement, prepared.values);
        const names = columnNames(statement);
        if (names.length === 0) throw new DatabaseResultKindError("rows", "command");
        assertExactIntegerReads(statement, capi);
        while (true) {
          if (!statement.step()) break;
          yield row(statement, names, capi) as Row;
        }
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      } finally {
        finishStatement(failed, failure);
      }
    },
    begin: (options?: TransactionOptions) => {
      validateTransactionOptions(options);
      if (options?.readOnly === true) unsupportedTransactionOption("transaction.read-only", "readOnly");
      if (options?.isolation !== undefined && options.isolation !== "serializable") {
        unsupportedTransactionOption(`transaction.isolation.${options.isolation}`, options.isolation);
      }
      return transactionControl(database, "BEGIN");
    },
    commit: () => transactionControl(database, "COMMIT"),
    rollback: () => transactionControl(database, "ROLLBACK"),
    savepoint: (name) => transactionControl(database, `SAVEPOINT ${assertSavepointName(name)}`),
    rollbackTo: (name) => transactionControl(database, `ROLLBACK TO SAVEPOINT ${assertSavepointName(name)}`),
    releaseSavepoint: (name) => transactionControl(database, `RELEASE SAVEPOINT ${assertSavepointName(name)}`),
  };
}

export function createSqliteWasmDatabase(database: SqliteWasmDatabaseLike, options: SqliteWasmDatabaseOptions = {}) {
  const { sqlite3, ...databaseOptions } = options;
  return createDatabase(createSqliteWasmExecutor(database, { sqlite3 }), databaseOptions);
}
