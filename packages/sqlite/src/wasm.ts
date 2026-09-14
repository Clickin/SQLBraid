import type {
  BulkBindingDescription,
  BulkExecutionResult,
  DatabaseOptions,
  DriverRoutineResult,
  DriverEnvironment,
  QueryExecutor,
  QueryExecutionResult,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
} from "@sqlbraid/core";
import { createBulkBindingDescription, createRenderedStatement, createStatementBindingDescription } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import type { SqliteIntegerMode } from "./node-sqlite.js";

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
  readonly integerMode?: SqliteIntegerMode;
  /** Official initialized module; required for INTEGER-only bigint reads. */
  readonly sqlite3?: {
    readonly capi: {
      readonly SQLITE_INTEGER: number;
      sqlite3_column_type(statement: number, column: number): number;
      sqlite3_column_int64(statement: number, column: number): bigint;
    };
  };
}

export interface SqliteWasmDatabaseOptions extends DatabaseOptions, SqliteWasmExecutorOptions {}

function assertIntegerMode(integerMode: SqliteIntegerMode | undefined): SqliteIntegerMode {
  if (integerMode === undefined) return "number";
  if (integerMode !== "number" && integerMode !== "bigint") {
    throw new TypeError('SQLite integerMode must be "number" or "bigint".');
  }
  return integerMode;
}

function normalizeValue(value: unknown, integerMode: SqliteIntegerMode): unknown {
  if (integerMode === "number" && typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError("BRAID_INTEGER_UNSAFE: SQLite WASM returned an integer outside JavaScript's safe range.");
    return number;
  }
  return value;
}

function assertRoutineUnsupported(rendered: RenderedStatement): void {
  if (rendered.resultKind === "call" || rendered.routineProcedure !== undefined) {
    throw new Error("BRAID_CALL_UNSUPPORTED: SQLite WASM adapter does not support routine calls.");
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new Error("BRAID_BIND_HINT_UNSUPPORTED: SQLite WASM adapter does not support explicit bind type hints.");
  }
}

function assertWasmValue(value: unknown): void {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("BRAID_BIND_VALUE_UNSUPPORTED: SQLite WASM binds require finite numbers.");
    return;
  }
  if (typeof value === "bigint") {
    if (BigInt.asIntN(64, value) !== value) throw new RangeError("BRAID_INTEGER_UNSAFE: SQLite WASM INTEGER binds must fit signed 64-bit range.");
    return;
  }
  if ((typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) || (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value))) return;
  throw new TypeError("BRAID_BIND_VALUE_UNSUPPORTED: SQLite WASM binds support SQLite scalar values and binary buffers.");
}

function assertWasmValues(values: readonly unknown[]): void {
  for (const value of values) assertWasmValue(value);
}

function assertCommand(rendered: RenderedStatement): void {
  if (rendered.resultKind !== "command") throw new Error("BRAID_BULK_SHAPE: SQLite WASM bulk requires command queries.");
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

function row(statement: SqliteWasmStatementLike, names: readonly string[], integerMode: SqliteIntegerMode, capi: NonNullable<SqliteWasmExecutorOptions["sqlite3"]>["capi"] | undefined): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  const pointer = statement.pointer;
  if (capi && pointer === undefined) throw new TypeError("BRAID_INTEGER_MODE_UNSUPPORTED: bigint mode requires an official OO1 statement pointer.");
  for (const [index, name] of names.entries()) {
    value[name] = capi && capi.sqlite3_column_type(pointer!, index) === capi.SQLITE_INTEGER
      ? capi.sqlite3_column_int64(pointer!, index)
      : normalizeValue(statement.get(index), integerMode);
  }
  return value;
}

function cleanupError(cause: unknown): Error & { readonly code: string } {
  const error = new Error("SQLite WASM statement finalization failed.", { cause }) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function finishStatement(statement: SqliteWasmStatementLike, failure: unknown): void {
  try {
    statement.finalize();
  } catch (cause) {
    const cleanup = cleanupError(cause);
    if (failure !== undefined) throw new AggregateError([failure, cleanup], "SQLite WASM operation and cleanup failed.", { cause: failure });
    throw cleanup;
  }
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();

export const sqliteWasmStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "sqlite-wasm",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertRoutineUnsupported(statement);
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
    assertCommand(statement);
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length) throw new Error("BRAID_BULK_SHAPE: SQLite WASM bulk parameter cardinality changed.");
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

function materialize(statement: RenderedStatement, binding: StatementBindingDescription | undefined): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? sqliteWasmStatementBinding.describe(statement, {
    dialectId: statement.dialectId,
    requestedReuse: "auto",
  });
  if (describedStatements.get(description) !== statement) throw new TypeError("BRAID_BINDING_IDENTITY: SQLite WASM description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) throw new Error("BRAID_BIND_TRANSPORT: SQLite WASM binding description did not provide parameterized SQL.");
  return { text: description.parameterizedSql, values: statement.parameters.map((parameter) => parameter.value) };
}

function transactionControl(database: SqliteWasmDatabaseLike, sql: string): Promise<void> {
  database.exec(sql);
  return Promise.resolve();
}

function sqliteWasmEnvironment(integerMode: SqliteIntegerMode): DriverEnvironment {
  return Object.freeze<DriverEnvironment>({
    database: { product: "sqlite" },
    driver: { id: "sqlite-wasm", profile: integerMode === "bigint" ? "bigint" : "number" },
    capabilities: {
      "sql.native-transparency": { status: "guaranteed" },
      "numeric.exact-integer": integerMode === "bigint"
        ? { status: "guaranteed", canonical: "bigint", rawRepresentations: ["bigint"] }
        : { status: "guarded", canonical: "number", rawRepresentations: ["number"], conditionCode: "sqlite-wasm.bigint-mode" },
      "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
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

export function createSqliteWasmExecutor(database: SqliteWasmDatabaseLike, options: SqliteWasmExecutorOptions = {}): QueryExecutor {
  const integerMode = assertIntegerMode(options.integerMode);
  const capi = integerMode === "bigint" ? options.sqlite3?.capi : undefined;
  if (integerMode === "bigint" && !capi) throw new TypeError("BRAID_INTEGER_MODE_UNSUPPORTED: bigint mode requires the initialized sqlite3 module.");
  return {
    ownershipKey: database,
    statementBinding: sqliteWasmStatementBinding,
    environment: sqliteWasmEnvironment(integerMode),
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      assertRoutineUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      let failure: unknown;
      try {
        bind(statement, prepared.values);
        const names = columnNames(statement);
        if (names.length > 0) {
          const rows: Record<string, unknown>[] = [];
          while (statement.step()) rows.push(row(statement, names, integerMode, capi));
          return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
        }
        statement.step();
        const changes = database.changes === undefined ? undefined : Number(database.changes());
        return { rows: [], rowCount: changes, kind: "command", command: { affectedRows: changes } };
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        finishStatement(statement, failure);
      }
    },
    async bulk(bulk: RenderedBulk, binding: BulkBindingDescription): Promise<BulkExecutionResult> {
      if (!binding || describedBulks.get(binding) !== bulk) throw new TypeError("BRAID_BINDING_IDENTITY: SQLite WASM bulk description belongs to another bulk or adapter.");
      const statement = createRenderedStatement(bulk.statement);
      assertCommand(statement);
      const text = binding.parameterizedSql;
      if (text === undefined) throw new Error("BRAID_BIND_TRANSPORT: SQLite WASM bulk binding description did not provide parameterized SQL.");
      const native = database.prepare(text);
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
          if (database.changes !== undefined) affectedRows += Number(database.changes());
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        finishStatement(native, failure);
      }
      return { inputCount: bulk.parameterSets.length, affectedRows, executionMode: "prepared-loop" };
    },
    async call(_rendered: RenderedStatement, _binding?: StatementBindingDescription): Promise<DriverRoutineResult> {
      throw new Error("BRAID_CALL_UNSUPPORTED: SQLite WASM adapter does not support routine calls.");
    },
    async *stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncGenerator<Row> {
      assertRoutineUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      signal?.throwIfAborted();
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      let failure: unknown;
      try {
        bind(statement, prepared.values);
        const names = columnNames(statement);
        if (names.length === 0) throw new Error("BRAID_RESULT_KIND: SQLite WASM stream requires a row-producing statement.");
        while (true) {
          signal?.throwIfAborted();
          if (!statement.step()) break;
          yield row(statement, names, integerMode, capi) as Row;
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        finishStatement(statement, failure);
      }
    },
    begin: () => transactionControl(database, "BEGIN"),
    commit: () => transactionControl(database, "COMMIT"),
    rollback: () => transactionControl(database, "ROLLBACK"),
    savepoint: (name) => transactionControl(database, `SAVEPOINT ${name}`),
    rollbackTo: (name) => transactionControl(database, `ROLLBACK TO SAVEPOINT ${name}`),
    releaseSavepoint: (name) => transactionControl(database, `RELEASE SAVEPOINT ${name}`),
  };
}

export function createSqliteWasmDatabase(database: SqliteWasmDatabaseLike, options: SqliteWasmDatabaseOptions = {}) {
  const { integerMode, sqlite3, ...databaseOptions } = options;
  return createDatabase(createSqliteWasmExecutor(database, { integerMode, sqlite3 }), databaseOptions);
}
