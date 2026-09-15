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
  normalizeExactInteger,
  safeDatabaseCount,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { createDatabase, DatabaseResultKindError } from "@sqlbraid/runtime";
import { typePolicy } from "./type-policy.js";

export interface SqliteColumnLike {
  readonly name?: string | null;
  readonly column?: string | null;
  readonly database?: string | null;
  readonly table?: string | null;
  readonly type?: string | null;
}

export interface SqliteStatementLike {
  all(...values: readonly unknown[]): readonly unknown[];
  iterate?(...values: readonly unknown[]): IterableIterator<unknown>;
  run(...values: readonly unknown[]): { readonly changes?: number | bigint; readonly lastInsertRowid?: number | bigint };
  columns(): readonly SqliteColumnLike[];
  /** Required for row-producing statements; command-only adapters may omit it. */
  setReadBigInts?(enabled: boolean): void;
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec?(sql: string): void;
}

export interface SqliteDatabaseOptions extends DatabaseOptions {}

function plainRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  // setReadBigInts() distinguishes INTEGER storage from integral REAL storage.
  // Only native bigint values are normalized; numbers retain their SQLite
  // storage-class semantics for dynamic columns.
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    typeof entry === "bigint" ? normalizeExactInteger(entry) : entry,
  ]));
}

function resultColumns(statement: SqliteStatementLike): readonly SqliteColumnLike[] {
  const columns = statement.columns();
  const names = new Set<string>();
  for (const column of columns) {
    const name = column.name ?? column.column;
    if (name != null && names.has(name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate SQLite result label ${name}.`);
    if (name != null) names.add(name);
  }
  return columns;
}

function unsupportedCall(): never {
  throw new UnsupportedFeatureError("routine.call", "BRAID_CALL_UNSUPPORTED", "SQLite adapter does not support routine calls.");
}

function assertRoutineUnsupported(rendered: RenderedStatement): void {
  if (rendered.resultKind === "call" || rendered.routineProcedure !== undefined) unsupportedCall();
}

function assertRoutineParametersUnsupported(rendered: RenderedStatement): void {
  for (const parameter of rendered.parameters) {
    if (parameter.direction === "inout") {
      throw new UnsupportedFeatureError("routine.inout", "BRAID_CALL_OUT_UNSUPPORTED", "SQLite does not expose a routine INOUT parameter carrier.");
    }
    if (parameter.direction === "out" || parameter.outputName !== undefined) {
      throw new UnsupportedFeatureError("routine.out", "BRAID_CALL_OUT_UNSUPPORTED", "SQLite does not expose a routine OUT parameter carrier.");
    }
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "SQLite adapter does not support explicit bind type hints.",
    );
  }
}

function assertNodeSqliteValue(value: unknown): void {
  if (value === null || typeof value === "number" || typeof value === "string") return;
  if (typeof value === "bigint") {
    if (BigInt.asIntN(64, value) !== value) {
      throw new RangeError("BRAID_INTEGER_UNSAFE: node:sqlite BigInt values must fit signed 64-bit range.");
    }
    return;
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) return;
  throw new AdapterError("BRAID_BIND_VALUE_UNSUPPORTED", "node:sqlite binds support null, numbers, bigint, strings, and ArrayBufferView values.");
}

function assertNodeSqliteValues(values: readonly unknown[]): void {
  for (const value of values) assertNodeSqliteValue(value);
}

function assertExecutionOptions(options?: ExecutionOptions): void {
  const signal = options?.signal;
  if (signal === undefined) return;
  if (signal.aborted) throw signal.reason;
  throw new UnsupportedFeatureError(
    "statement.cancel",
    "BRAID_CANCEL_UNSUPPORTED",
    "node:sqlite does not expose a safe statement cancellation primitive.",
  );
}

function unsupportedTransactionOption(feature: string, option: string): never {
  throw new UnsupportedFeatureError(feature, "BRAID_TX_OPTION_UNSUPPORTED", `SQLite does not support transaction option ${option}.`);
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
    candidate.isolation !== undefined
    && candidate.isolation !== "read-uncommitted"
    && candidate.isolation !== "read-committed"
    && candidate.isolation !== "repeatable-read"
    && candidate.isolation !== "serializable"
  ) {
    invalidTransactionOptions("transaction isolation is not a supported standard literal.");
  }
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();

export const nodeSqliteStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "node-sqlite",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertRoutineUnsupported(statement);
    assertRoutineParametersUnsupported(statement);
    assertParameterHintsUnsupported(statement);
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "node-sqlite",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "simple", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    assertRoutineParametersUnsupported(statement);
    if (statement.resultKind !== "command") throw new Error("BRAID_BULK_SHAPE: node:sqlite bulk requires command queries.");
    if (statement.parameters.some((parameter) => (parameter.direction ?? "in") !== "in")) {
      throw new Error("BRAID_BULK_SHAPE: node:sqlite bulk does not support OUT or INOUT parameters.");
    }
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length) throw new Error("BRAID_BULK_SHAPE: node:sqlite bulk parameter cardinality changed.");
      assertNodeSqliteValues(values);
    }
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "node-sqlite",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "simple", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    return description;
  },
});

function bindingContext(statement: RenderedStatement): StatementBindingContext {
  return {
    dialectId: statement.dialectId,
    requestedReuse: "auto",
  };
}

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? nodeSqliteStatementBinding.describe(statement, bindingContext(statement));
  if (describedStatements.get(description) !== statement) throw new TypeError("BRAID_BINDING_IDENTITY: SQLite description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: SQLite binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
  };
}

function configureExactIntegerReads(statement: SqliteStatementLike): void {
  if (typeof statement.setReadBigInts !== "function") {
    throw new UnsupportedFeatureError(
      "result.exact-integer",
      "BRAID_INTEGER_MODE_UNSUPPORTED",
      "SQLite row reads require StatementSync.setReadBigInts(true).",
    );
  }
  statement.setReadBigInts(true);
}

function nodeSqliteEnvironment(transactionSupported: boolean): DriverEnvironment {
  return Object.freeze<DriverEnvironment>({
    database: { product: "sqlite" },
    driver: { id: "node-sqlite", profile: "sqlite-exact-string" },
    typePolicy: { id: typePolicy.id, hash: typePolicy.hash },
    capabilities: {
      "sql.native-transparency": { status: "guaranteed" },
      "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["bigint", "string"] },
      "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
      "session.pinned": { status: "guaranteed" },
      "transaction": { status: transactionSupported ? "guaranteed" : "unsupported" },
      "transaction.savepoint": { status: transactionSupported ? "guaranteed" : "unsupported" },
      "transaction.read-only": { status: "unsupported" },
      "transaction.isolation.read-uncommitted": { status: "unsupported" },
      "transaction.isolation.read-committed": { status: "unsupported" },
      "transaction.isolation.repeatable-read": { status: "unsupported" },
      "transaction.isolation.serializable": { status: transactionSupported ? "guaranteed" : "unsupported" },
      "statement.prepare": { status: "guaranteed" },
      "statement.cancel": { status: "unsupported" },
      "statement.stream": { status: "guaranteed" },
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

export function createNodeSqliteExecutor(database: SqliteDatabaseLike): QueryExecutor {
  const control = database.exec ? async (sql: string): Promise<void> => { database.exec?.(sql); } : undefined;
  return {
    ownershipKey: database,
    statementBinding: nodeSqliteStatementBinding,
    environment: nodeSqliteEnvironment(control !== undefined),
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): Promise<QueryExecutionResult<Row>> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      const columns = resultColumns(statement);
      if (columns.length > 0) {
        configureExactIntegerReads(statement);
        const rows = statement.all(...prepared.values).map(plainRow);
        return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
      }
      const result = statement.run(...prepared.values);
      const changes = result.changes === undefined ? undefined : safeDatabaseCount(result.changes);
      const insertId = result.lastInsertRowid === undefined ? undefined : normalizeExactInteger(result.lastInsertRowid);
      return {
        rows: [],
        rowCount: changes,
        kind: "command",
        command: {
          ...(changes === undefined ? {} : { affectedRows: changes }),
          ...(insertId === undefined ? {} : { insertId }),
        },
      };
    },
    async bulk(bulk: RenderedBulk, binding: BulkBindingDescription, options?: ExecutionOptions): Promise<BulkExecutionResult> {
      assertExecutionOptions(options);
      assertRoutineParametersUnsupported(bulk.statement);
      if (!binding || describedBulks.get(binding) !== bulk) {
        throw new TypeError("BRAID_BINDING_IDENTITY: node:sqlite bulk description belongs to another bulk or adapter.");
      }
      const prepared = binding.parameterizedSql;
      if (prepared === undefined) throw new Error("BRAID_BIND_TRANSPORT: SQLite bulk binding description did not provide parameterized SQL.");
      const native = database.prepare(prepared);
      if (resultColumns(native).length > 0) throw new Error("BRAID_BULK_SHAPE: node:sqlite bulk requires a non-row statement.");
      let affectedRows: number | undefined = 0;
      for (let index = 0; index < bulk.parameterSets.length; index += 1) {
        const result = native.run(...binding.valuesAt(index));
        if (result.changes === undefined) {
          affectedRows = undefined;
        } else if (affectedRows !== undefined) {
          affectedRows = safeDatabaseCount(affectedRows + safeDatabaseCount(result.changes));
        }
      }
      return {
        inputCount: bulk.parameterSets.length,
        ...(affectedRows === undefined ? {} : { affectedRows }),
        executionMode: "prepared-loop",
      };
    },
    async call(rendered: RenderedStatement, _binding?: StatementBindingDescription, options?: ExecutionOptions): Promise<DriverRoutineResult> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      unsupportedCall();
    },
    async *stream<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): AsyncGenerator<Row> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      if (!statement.iterate) {
        throw new UnsupportedFeatureError("statement.stream", "BRAID_STREAM_UNSUPPORTED", "SQLite statement does not expose iteration.");
      }
      if (resultColumns(statement).length === 0) {
        throw new DatabaseResultKindError("rows", "command");
      }
      configureExactIntegerReads(statement);
      const iterator = statement.iterate(...prepared.values);
      let failed = false;
      let readError: unknown;
      try {
        while (true) {
          const next = iterator.next();
          if (next.done) break;
          yield plainRow(next.value) as Row;
        }
      } catch (error) {
        failed = true;
        readError = error;
        throw error;
      } finally {
        try {
          iterator.return?.();
        } catch (cause) {
          const cleanup = Object.assign(new Error("SQLite iterator cleanup failed.", { cause }), {
            code: "BRAID_RESOURCE_CLEANUP",
          });
          if (failed) throw new AggregateError([readError, cleanup], "SQLite read and cleanup failed.", { cause: readError });
          throw cleanup;
        }
      }
    },
    begin: control ? (options?: TransactionOptions) => {
      validateTransactionOptions(options);
      if (options?.readOnly === true) unsupportedTransactionOption("transaction.read-only", "readOnly");
      if (options?.isolation !== undefined && options.isolation !== "serializable") {
        unsupportedTransactionOption(`transaction.isolation.${options.isolation}`, options.isolation);
      }
      return control("BEGIN");
    } : undefined,
    commit: control ? () => control("COMMIT") : undefined,
    rollback: control ? () => control("ROLLBACK") : undefined,
    savepoint: control ? (name) => control(`SAVEPOINT ${name}`) : undefined,
    rollbackTo: control ? (name) => control(`ROLLBACK TO SAVEPOINT ${name}`) : undefined,
    releaseSavepoint: control ? (name) => control(`RELEASE SAVEPOINT ${name}`) : undefined,
  };
}

export function createNodeSqliteDatabase(database: SqliteDatabaseLike, options: SqliteDatabaseOptions = {}) {
  return createDatabase(createNodeSqliteExecutor(database), options);
}
