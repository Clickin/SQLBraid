import type {
  BulkBindingDescription,
  BulkExecutionResult,
  DatabaseOptions,
  DriverEnvironment,
  DriverRoutineResult,
  ExecutionOptions,
  QueryExecutionResult,
  QueryExecutor,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
  TransactionOptions,
} from "@sqlbraid/core";
import { Buffer } from "node:buffer";
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

export interface BetterSqlite3ColumnLike {
  readonly name?: string | null;
  readonly column?: string | null;
  readonly database?: string | null;
  readonly table?: string | null;
  readonly type?: string | null;
}

export interface BetterSqlite3RunResultLike {
  readonly changes?: number | bigint;
  readonly lastInsertRowid?: number | bigint;
}

/**
 * The small public better-sqlite3 statement surface SQLBraid needs.
 *
 * `safeIntegers` is deliberately statement-local. SQLBraid never changes the
 * database's global integer mode.
 */
export interface BetterSqlite3StatementLike {
  /** better-sqlite3 exposes this as true for statements that return rows. */
  readonly reader?: boolean;
  all(...values: readonly unknown[]): readonly unknown[];
  iterate(...values: readonly unknown[]): IterableIterator<unknown>;
  run(...values: readonly unknown[]): BetterSqlite3RunResultLike;
  columns(): readonly BetterSqlite3ColumnLike[];
  safeIntegers(enabled?: boolean): unknown;
}

export interface BetterSqlite3DatabaseLike {
  prepare(sql: string): BetterSqlite3StatementLike;
  exec(sql: string): unknown;
}

export interface BetterSqlite3DatabaseOptions extends DatabaseOptions {}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return normalizeExactInteger(value);
  // better-sqlite3 uses Buffer for BLOB output. A Uint8Array copy keeps the
  // public result independent of Node's Buffer subclass.
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  return value;
}

function plainRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BRAID_RESULT_COLUMNS: better-sqlite3 must return object result rows.");
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]));
}

function resultColumns(statement: BetterSqlite3StatementLike): readonly BetterSqlite3ColumnLike[] {
  // better-sqlite3 throws when columns() is called for a non-reader.
  if (statement.reader === false) return [];
  const columns = statement.columns();
  const names = new Set<string>();
  for (const column of columns) {
    const name = column.name ?? column.column;
    if (name !== undefined && name !== null) {
      if (names.has(name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate SQLite result label ${name}.`);
      names.add(name);
    }
  }
  return columns;
}

function unsupportedCall(): never {
  throw new UnsupportedFeatureError("routine.call", "BRAID_CALL_UNSUPPORTED", "better-sqlite3 does not support routine calls.");
}

function assertRoutineUnsupported(rendered: RenderedStatement): void {
  if (rendered.resultKind === "call" || rendered.routineProcedure !== undefined) unsupportedCall();
}

function assertRoutineParametersUnsupported(rendered: RenderedStatement): void {
  for (const parameter of rendered.parameters) {
    if (parameter.direction === "inout") {
      throw new UnsupportedFeatureError(
        "routine.inout",
        "BRAID_CALL_OUT_UNSUPPORTED",
        "SQLite does not expose a routine INOUT parameter carrier.",
      );
    }
    if (parameter.direction === "out" || parameter.outputName !== undefined) {
      throw new UnsupportedFeatureError(
        "routine.out",
        "BRAID_CALL_OUT_UNSUPPORTED",
        "SQLite does not expose a routine OUT parameter carrier.",
      );
    }
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "better-sqlite3 does not support explicit bind type hints.",
    );
  }
}

function assertBetterSqlite3Value(value: unknown): void {
  if (value === null || typeof value === "number" || typeof value === "string") return;
  if (typeof value === "bigint") {
    if (BigInt.asIntN(64, value) !== value) {
      throw new RangeError("BRAID_INTEGER_UNSAFE: better-sqlite3 BigInt values must fit signed 64-bit range.");
    }
    return;
  }
  if (value instanceof Uint8Array) return;
  throw new AdapterError(
    "BRAID_BIND_VALUE_UNSUPPORTED",
    "better-sqlite3 binds support null, numbers, bigint, strings, and Buffer values.",
  );
}

function toBetterSqlite3Value(value: unknown): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

function assertBetterSqlite3Values(values: readonly unknown[]): void {
  for (const value of values) assertBetterSqlite3Value(value);
}

function assertExecutionOptions(options?: ExecutionOptions): void {
  const signal = options?.signal;
  if (signal === undefined) return;
  if (signal.aborted) throw signal.reason;
  throw new UnsupportedFeatureError(
    "statement.cancel",
    "BRAID_CANCEL_UNSUPPORTED",
    "better-sqlite3 does not expose a safe statement cancellation primitive.",
  );
}

function invalidTransactionOptions(message: string): never {
  const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: ${message}`) as TypeError & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
  throw error;
}

function unsupportedTransactionOption(option: string): never {
  throw new UnsupportedFeatureError(
    `transaction.${option === "readOnly" ? "read-only" : `isolation.${option}`}`,
    "BRAID_TX_OPTION_UNSUPPORTED",
    `SQLite does not support transaction option ${option}.`,
  );
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

export const betterSqlite3StatementBinding: StatementBindingAdapter = Object.freeze({
  id: "better-sqlite3",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertRoutineUnsupported(statement);
    assertRoutineParametersUnsupported(statement);
    assertParameterHintsUnsupported(statement);
    assertBetterSqlite3Values(statement.parameters.map((parameter) => parameter.value));
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "better-sqlite3",
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
    if (statement.resultKind !== "command") throw new Error("BRAID_BULK_SHAPE: better-sqlite3 bulk requires command queries.");
    if (statement.parameters.some((parameter) => (parameter.direction ?? "in") !== "in")) {
      throw new Error("BRAID_BULK_SHAPE: better-sqlite3 bulk does not support OUT or INOUT parameters.");
    }
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length) throw new Error("BRAID_BULK_SHAPE: better-sqlite3 bulk parameter cardinality changed.");
      assertBetterSqlite3Values(values);
    }
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "better-sqlite3",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "simple", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    return description;
  },
});

function bindingContext(statement: RenderedStatement): StatementBindingContext {
  return { dialectId: statement.dialectId, requestedReuse: "auto" };
}

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? betterSqlite3StatementBinding.describe(statement, bindingContext(statement));
  if (describedStatements.get(description) !== statement) {
    throw new TypeError("BRAID_BINDING_IDENTITY: better-sqlite3 description belongs to another statement or adapter.");
  }
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: better-sqlite3 binding description did not provide parameterized SQL.");
  }
  const values = statement.parameters.map((parameter) => parameter.value);
  assertBetterSqlite3Values(values);
  return { text: description.parameterizedSql, values: values.map(toBetterSqlite3Value) };
}

function configureExactIntegerReads(statement: BetterSqlite3StatementLike): void {
  if (typeof statement.safeIntegers !== "function") {
    throw new UnsupportedFeatureError(
      "result.exact-integer",
      "BRAID_INTEGER_MODE_UNSUPPORTED",
      "better-sqlite3 row reads require Statement.safeIntegers(true).",
    );
  }
  statement.safeIntegers(true);
}

function betterSqlite3Environment(): DriverEnvironment {
  return Object.freeze<DriverEnvironment>({
    database: { product: "sqlite" },
    driver: { id: "better-sqlite3", profile: "better-sqlite3-exact-string" },
    typePolicy: { id: typePolicy.id, hash: typePolicy.hash },
    capabilities: {
      "sql.native-transparency": { status: "guaranteed" },
      "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["bigint", "string"] },
      "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
      "session.pinned": { status: "guaranteed" },
      "transaction": { status: "guaranteed" },
      "transaction.savepoint": { status: "guaranteed" },
      "transaction.read-only": { status: "unsupported" },
      "transaction.isolation.read-uncommitted": { status: "unsupported" },
      "transaction.isolation.read-committed": { status: "unsupported" },
      "transaction.isolation.repeatable-read": { status: "unsupported" },
      "transaction.isolation.serializable": { status: "guaranteed" },
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

export function createBetterSqlite3Executor(database: BetterSqlite3DatabaseLike): QueryExecutor {
  const control = (sql: string): void => {
    database.exec(sql);
  };
  const executor = {
    ownershipKey: database,
    statementBinding: betterSqlite3StatementBinding,
    environment: betterSqlite3Environment(),
    query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): QueryExecutionResult<Row> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      const columns = resultColumns(statement);
      configureExactIntegerReads(statement);
      if (columns.length > 0) {
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
    bulk(bulk: RenderedBulk, binding: BulkBindingDescription, options?: ExecutionOptions): BulkExecutionResult {
      assertExecutionOptions(options);
      assertRoutineParametersUnsupported(bulk.statement);
      if (!binding || describedBulks.get(binding) !== bulk) {
        throw new TypeError("BRAID_BINDING_IDENTITY: better-sqlite3 bulk description belongs to another bulk or adapter.");
      }
      const prepared = binding.parameterizedSql;
      if (prepared === undefined) throw new Error("BRAID_BIND_TRANSPORT: better-sqlite3 bulk binding description did not provide parameterized SQL.");
      const native = database.prepare(prepared);
      if (resultColumns(native).length > 0) throw new Error("BRAID_BULK_SHAPE: better-sqlite3 bulk requires a non-row statement.");
      configureExactIntegerReads(native);
      let affectedRows: number | undefined = 0;
      for (let index = 0; index < bulk.parameterSets.length; index += 1) {
        const values = binding.valuesAt(index);
        assertBetterSqlite3Values(values);
        const result = native.run(...values.map(toBetterSqlite3Value));
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
    call(rendered: RenderedStatement, _binding?: StatementBindingDescription, options?: ExecutionOptions): DriverRoutineResult {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      unsupportedCall();
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
      const columns = resultColumns(statement);
      if (columns.length === 0) throw new DatabaseResultKindError("rows", "command");
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
          const cleanup = Object.assign(new Error("better-sqlite3 iterator cleanup failed.", { cause }), {
            code: "BRAID_RESOURCE_CLEANUP",
          });
          if (failed) throw new AggregateError([readError, cleanup], "SQLite read and cleanup failed.", { cause: readError });
          throw cleanup;
        }
      }
    },
    begin(options?: TransactionOptions): void {
      validateTransactionOptions(options);
      if (options?.readOnly === true) unsupportedTransactionOption("readOnly");
      if (options?.isolation !== undefined && options.isolation !== "serializable") {
        unsupportedTransactionOption(options.isolation);
      }
      control("BEGIN");
    },
    commit(): void {
      control("COMMIT");
    },
    rollback(): void {
      control("ROLLBACK");
    },
    savepoint(name: string): void {
      control(`SAVEPOINT ${name}`);
    },
    rollbackTo(name: string): void {
      control(`ROLLBACK TO SAVEPOINT ${name}`);
    },
    releaseSavepoint(name: string): void {
      control(`RELEASE SAVEPOINT ${name}`);
    },
  };
  return executor;
}

export function createBetterSqlite3Database(
  database: BetterSqlite3DatabaseLike,
  options: BetterSqlite3DatabaseOptions = {},
) {
  return createDatabase(createBetterSqlite3Executor(database), options);
}
