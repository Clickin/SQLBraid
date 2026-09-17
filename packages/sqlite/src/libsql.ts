import type {
  BulkBindingDescription,
  BulkExecutionResult,
  CommandExecutionResult,
  Database,
  DatabaseOptions,
  DriverEnvironment,
  DriverRoutineResult,
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
import { assertSavepointName, createCleanupScope } from "@sqlbraid/core/driver";
import { createDatabase } from "@sqlbraid/runtime";
import { typePolicy } from "./type-policy.js";

/** Values accepted by the public @libsql/client execute API. */
export type LibsqlValue = null | string | number | bigint | boolean | Uint8Array | ArrayBuffer | Date;

export type LibsqlArgs = LibsqlValue[] | Record<string, LibsqlValue>;

/** The small input-statement surface used by the adapter. */
export interface LibsqlStatementLike {
  readonly sql: string;
  readonly args?: LibsqlArgs;
}

/** The row metadata and materialized values returned by libSQL clients. */
export interface LibsqlResultSetLike {
  readonly columns: readonly string[];
  readonly columnTypes?: readonly string[];
  readonly rows: readonly LibsqlRowLike[];
  readonly rowsAffected?: number | bigint | string;
  readonly lastInsertRowid?: number | bigint | string | null;
}

/** libSQL rows are array-like objects with both numeric and named properties. */
export interface LibsqlRowLike {
  readonly length?: number;
  readonly [index: number]: unknown;
  readonly [name: string]: unknown;
}

/** The structural subset shared by @libsql/client's browser, HTTP, WS, and local clients. */
export interface LibsqlTransactionLike {
  execute(statement: LibsqlStatementLike | string): Promise<LibsqlResultSetLike>;
  batch(statements: (LibsqlStatementLike | string)[]): Promise<readonly LibsqlResultSetLike[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close?(): void | Promise<void>;
}

/** The structural subset shared by @libsql/client's runtime-neutral clients. */
export interface LibsqlClientLike {
  readonly protocol?: string;
  execute(statement: LibsqlStatementLike | string): Promise<LibsqlResultSetLike>;
  batch(
    statements: (LibsqlStatementLike | string | [string, LibsqlArgs?])[],
    mode?: LibsqlTransactionMode,
  ): Promise<readonly LibsqlResultSetLike[]>;
  transaction(mode?: LibsqlTransactionMode): Promise<LibsqlTransactionLike>;
}

export type LibsqlTransactionMode = "write" | "read" | "deferred";

/**
 * @libsql/client must be configured with `intMode: "string"` before it is
 * handed to SQLBraid. The assertion is deliberately explicit: an opaque
 * client cannot prove which integer representation it was configured with.
 */
export interface LibsqlExecutorOptions {
  readonly intMode: "string";
}

export type LibsqlDatabaseOptions = DatabaseOptions & LibsqlExecutorOptions;

function assertClient(client: LibsqlClientLike): void {
  if (
    client === null ||
    typeof client !== "object" ||
    typeof client.execute !== "function" ||
    typeof client.batch !== "function" ||
    typeof client.transaction !== "function"
  ) {
    throw new TypeError("SQLBraid libSQL adapter requires a client with execute(), batch(), and transaction().");
  }
}

function assertExactStringMode(options: LibsqlExecutorOptions): void {
  if (options === null || typeof options !== "object" || options.intMode !== "string") {
    throw new TypeError(
      'BRAID_INTEGER_MODE_REQUIRED: libSQL adapter requires an explicit intMode: "string" assertion.',
    );
  }
}

function assertRoutineUnsupported(rendered: RenderedStatement): void {
  if (rendered.resultKind === "call" || rendered.routineProcedure !== undefined) {
    throw new UnsupportedFeatureError(
      "routine.call",
      "BRAID_CALL_UNSUPPORTED",
      "libSQL does not support routine calls.",
    );
  }
}

function assertRoutineParametersUnsupported(rendered: RenderedStatement): void {
  for (const parameter of rendered.parameters) {
    if (parameter.direction === "inout") {
      throw new UnsupportedFeatureError(
        "routine.inout",
        "BRAID_CALL_OUT_UNSUPPORTED",
        "libSQL does not expose a routine INOUT parameter carrier.",
      );
    }
    if (parameter.direction === "out" || parameter.outputName !== undefined) {
      throw new UnsupportedFeatureError(
        "routine.out",
        "BRAID_CALL_OUT_UNSUPPORTED",
        "libSQL does not expose a routine OUT parameter carrier.",
      );
    }
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "libSQL does not support explicit bind type hints.",
    );
  }
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value);
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer;
}

function assertLibsqlValue(value: unknown): asserts value is LibsqlValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || value instanceof Date) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new AdapterError("BRAID_BIND_VALUE_UNSUPPORTED", "libSQL binds require finite numbers.");
    return;
  }
  if (typeof value === "bigint") {
    if (BigInt.asIntN(64, value) !== value) {
      throw new RangeError("BRAID_INTEGER_UNSAFE: libSQL BigInt values must fit signed 64-bit range.");
    }
    return;
  }
  if (isArrayBuffer(value) || value instanceof Uint8Array) return;
  throw new AdapterError(
    "BRAID_BIND_VALUE_UNSUPPORTED",
    "libSQL binds support null, strings, booleans, finite numbers, bigint, Date, and binary buffers.",
  );
}

function assertLibsqlValues(values: readonly unknown[]): asserts values is readonly LibsqlValue[] {
  for (const value of values) {
    if (value === undefined)
      throw new AdapterError("BRAID_BIND_VALUE_UNSUPPORTED", "undefined cannot be passed as a libSQL argument.");
    assertLibsqlValue(value);
  }
}

function assertExecutionOptions(options?: ExecutionOptions): void {
  const signal = options?.signal;
  if (signal === undefined) return;
  if (signal.aborted) throw signal.reason;
  throw new UnsupportedFeatureError(
    "statement.cancel",
    "BRAID_CANCEL_UNSUPPORTED",
    "libSQL does not expose a safe statement cancellation primitive.",
  );
}

function invalidTransactionOptions(message: string): never {
  const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: ${message}`) as TypeError & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
  throw error;
}

function unsupportedTransactionOption(option: string): never {
  throw new UnsupportedFeatureError(
    `transaction.isolation.${option}`,
    "BRAID_TX_OPTION_UNSUPPORTED",
    `libSQL does not map standard transaction isolation ${option} to a documented equivalent.`,
  );
}

function transactionModeFor(client: LibsqlClientLike, options?: TransactionOptions): LibsqlTransactionMode | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    invalidTransactionOptions("transaction options must be an object.");
  }
  const unexpected = Object.keys(options).find((key) => key !== "isolation" && key !== "readOnly");
  if (unexpected !== undefined) invalidTransactionOptions(`Unknown libSQL transaction option: ${unexpected}.`);
  const candidate = options as TransactionOptions & { readonly isolation?: unknown; readonly readOnly?: unknown };
  if (candidate.readOnly !== undefined && typeof candidate.readOnly !== "boolean") {
    invalidTransactionOptions("transaction readOnly must be boolean.");
  }
  if (candidate.isolation !== undefined) {
    if (
      candidate.isolation !== "read-uncommitted" &&
      candidate.isolation !== "read-committed" &&
      candidate.isolation !== "repeatable-read" &&
      candidate.isolation !== "serializable"
    ) {
      invalidTransactionOptions("transaction isolation is not a supported standard literal.");
    }
    unsupportedTransactionOption(candidate.isolation);
  }
  if ((client.protocol === undefined || client.protocol === "file") && candidate.readOnly === true) {
    throw new UnsupportedFeatureError(
      "transaction.read-only",
      "BRAID_TX_OPTION_UNSUPPORTED",
      "The local libSQL client does not enforce read-only transactions.",
    );
  }
  if (candidate.readOnly === undefined) return undefined;
  return candidate.readOnly ? "read" : "write";
}

function validateColumns(columns: readonly string[]): void {
  const names = new Set<string>();
  for (const name of columns) {
    if (typeof name !== "string") throw new TypeError("BRAID_RESULT_COLUMNS: libSQL result labels must be strings.");
    if (names.has(name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate libSQL result label ${name}.`);
    names.add(name);
  }
}

function binary(value: unknown): unknown {
  if (isArrayBuffer(value)) return new Uint8Array(value);
  if (isArrayBufferView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

function normalizeValue(value: unknown): unknown {
  const normalized = binary(value);
  if (normalized === null) return null;
  if (typeof normalized === "bigint") return normalizeExactInteger(normalized);
  return normalized;
}

function valueAt(row: LibsqlRowLike, index: number, name: string): unknown {
  if (row === null || typeof row !== "object")
    throw new TypeError("BRAID_RESULT_ROW: libSQL returned a non-object row.");
  if (index in row) return row[index];
  return row[name];
}

function normalizeRow(row: LibsqlRowLike, columns: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((name, index) => [name, normalizeValue(valueAt(row, index, name))]));
}

function resultRows<Row>(result: LibsqlResultSetLike): readonly Row[] {
  if (!Array.isArray(result.columns))
    throw new TypeError("BRAID_RESULT_COLUMNS: libSQL result metadata must include columns.");
  validateColumns(result.columns);
  if (!Array.isArray(result.rows)) throw new TypeError("BRAID_RESULT_ROWS: libSQL result metadata must include rows.");
  if (result.columns.length === 0) {
    if (result.rows.length !== 0) throw new Error("BRAID_RESULT_KIND: libSQL returned rows without column metadata.");
    return [];
  }
  return result.rows.map((row) => normalizeRow(row, result.columns)) as readonly Row[];
}

function commandResult(result: LibsqlResultSetLike): CommandExecutionResult {
  if (!Array.isArray(result.columns))
    throw new TypeError("BRAID_RESULT_COLUMNS: libSQL result metadata must include columns.");
  validateColumns(result.columns);
  if (result.columns.length > 0) {
    throw new Error("BRAID_RESULT_KIND: libSQL returned a row-producing result for a command.");
  }
  if (!Array.isArray(result.rows) || result.rows.length !== 0) {
    throw new Error("BRAID_RESULT_KIND: libSQL returned rows without column metadata.");
  }
  const affectedRows =
    result.rowsAffected === undefined || result.rowsAffected === null
      ? undefined
      : safeDatabaseCount(result.rowsAffected);
  const insertId =
    result.lastInsertRowid === undefined || result.lastInsertRowid === null
      ? undefined
      : normalizeExactInteger(result.lastInsertRowid);
  return {
    rows: [],
    ...(affectedRows === undefined ? {} : { rowCount: affectedRows }),
    kind: "command",
    command: {
      ...(affectedRows === undefined ? {} : { affectedRows }),
      ...(insertId === undefined ? {} : { insertId }),
    },
  };
}

function materializeResult<Row>(result: LibsqlResultSetLike): QueryExecutionResult<Row> {
  if (!Array.isArray(result.columns))
    throw new TypeError("BRAID_RESULT_COLUMNS: libSQL result metadata must include columns.");
  validateColumns(result.columns);
  if (result.columns.length === 0) return commandResult(result) as QueryExecutionResult<Row>;
  return { rows: resultRows<Row>(result), rowCount: result.rows.length, kind: "rows" };
}

function statementInput(text: string, values: readonly LibsqlValue[]): LibsqlStatementLike {
  return values.length === 0 ? { sql: text } : { sql: text, args: values as LibsqlValue[] };
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();

export const libsqlStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "libsql",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertRoutineUnsupported(statement);
    assertRoutineParametersUnsupported(statement);
    assertParameterHintsUnsupported(statement);
    assertLibsqlValues(statement.parameters.map((parameter) => parameter.value));
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "libsql",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "simple", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    assertRoutineUnsupported(statement);
    assertRoutineParametersUnsupported(statement);
    if (statement.resultKind !== "command") throw new Error("BRAID_BULK_SHAPE: libSQL bulk requires command queries.");
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length)
        throw new Error("BRAID_BULK_SHAPE: libSQL bulk parameter cardinality changed.");
      assertLibsqlValues(values);
    }
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "libsql",
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
): { readonly text: string; readonly values: readonly LibsqlValue[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? libsqlStatementBinding.describe(statement, bindingContext(statement));
  if (describedStatements.get(description) !== statement)
    throw new TypeError("BRAID_BINDING_IDENTITY: libSQL description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined)
    throw new Error("BRAID_BIND_TRANSPORT: libSQL binding description did not provide parameterized SQL.");
  const values = statement.parameters.map((parameter) => parameter.value);
  assertLibsqlValues(values);
  return { text: description.parameterizedSql, values };
}

function materializeBulk(
  bulk: RenderedBulk,
  binding: BulkBindingDescription,
): { readonly text: string; readonly valuesAt: (index: number) => readonly LibsqlValue[] } {
  if (!binding || describedBulks.get(binding) !== bulk) {
    throw new TypeError("BRAID_BINDING_IDENTITY: libSQL bulk description belongs to another bulk or adapter.");
  }
  if (binding.parameterizedSql === undefined)
    throw new Error("BRAID_BIND_TRANSPORT: libSQL bulk binding description did not provide parameterized SQL.");
  return { text: binding.parameterizedSql, valuesAt: (index) => binding.valuesAt(index) as readonly LibsqlValue[] };
}

const libsqlEnvironment = Object.freeze<DriverEnvironment>({
  database: { product: "sqlite" },
  driver: { id: "libsql", profile: "libsql-exact-string" },
  typePolicy: { id: typePolicy.id, hash: typePolicy.hash },
  capabilities: {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "numeric.bind-exact": {
      status: "guaranteed",
      canonical: "string",
      rawRepresentations: ["string", "number", "bigint"],
    },
    "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["ArrayBuffer", "Uint8Array"] },
    "session.pinned": { status: "unsupported", conditionCode: "libsql.client-no-session-pinning" },
    transaction: { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": { status: "guaranteed" },
    "transaction.isolation.read-uncommitted": { status: "unsupported" },
    "transaction.isolation.read-committed": { status: "unsupported" },
    "transaction.isolation.repeatable-read": { status: "unsupported" },
    "transaction.isolation.serializable": { status: "unsupported" },
    "statement.prepare": { status: "guaranteed" },
    "statement.cancel": { status: "unsupported" },
    "statement.stream": { status: "unsupported" },
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

function environmentFor(client: LibsqlClientLike): DriverEnvironment {
  if (client.protocol !== undefined && client.protocol !== "file") return libsqlEnvironment;
  return Object.freeze({
    ...libsqlEnvironment,
    capabilities: Object.freeze({
      ...libsqlEnvironment.capabilities,
      "transaction.read-only": {
        status: "unsupported" as const,
        conditionCode: "libsql.file-read-only-not-enforced",
      },
    }),
  });
}

function activeTransaction(active: LibsqlTransactionLike | undefined): LibsqlTransactionLike {
  if (active === undefined) throw new TypeError("BRAID_TRANSACTION_STATE: no active libSQL transaction.");
  return active;
}

async function closeTransaction(transaction: LibsqlTransactionLike, original?: unknown): Promise<void> {
  if (typeof transaction.close !== "function") return;
  try {
    await transaction.close();
  } catch (cause) {
    if (original !== undefined)
      throw new AggregateError([original, cause], "libSQL transaction and cleanup failed.", { cause: original });
    throw cause;
  }
}

function transactionStatement(
  name: string,
  command: "SAVEPOINT" | "ROLLBACK TO SAVEPOINT" | "RELEASE SAVEPOINT",
): string {
  return `${command} ${assertSavepointName(name)}`;
}

export function createLibsqlExecutor(client: LibsqlClientLike, options: LibsqlExecutorOptions): QueryExecutor {
  assertClient(client);
  assertExactStringMode(options);
  let transaction: LibsqlTransactionLike | undefined;

  const executor = {
    ownershipKey: client,
    statementBinding: libsqlStatementBinding,
    environment: environmentFor(client),
    validateTransactionOptions: (options?: TransactionOptions): void => {
      transactionModeFor(client, options);
    },
    async query<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const result = await (transaction ?? client).execute(statementInput(prepared.text, prepared.values));
      return materializeResult<Row>(result);
    },
    async bulk(
      bulk: RenderedBulk,
      binding: BulkBindingDescription,
      options?: ExecutionOptions,
    ): Promise<BulkExecutionResult> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(bulk.statement);
      assertRoutineParametersUnsupported(bulk.statement);
      const prepared = materializeBulk(bulk, binding);
      const statements: LibsqlStatementLike[] = [];
      for (let index = 0; index < bulk.parameterSets.length; index += 1) {
        const values = prepared.valuesAt(index);
        assertLibsqlValues(values);
        statements.push(statementInput(prepared.text, values));
      }
      const results = await (transaction ?? client).batch(statements);
      if (results.length !== statements.length)
        throw new Error("BRAID_BULK_RESULT_COUNT: libSQL batch returned an unexpected result count.");
      let affectedRows = 0;
      let hasAffectedRows = false;
      for (const result of results) {
        const command = commandResult(result);
        if (command.command.affectedRows !== undefined) {
          hasAffectedRows = true;
          affectedRows = safeDatabaseCount(affectedRows + command.command.affectedRows);
        }
      }
      return {
        inputCount: statements.length,
        ...(hasAffectedRows ? { affectedRows } : {}),
        executionMode: "remote-batch",
      };
    },
    async call(
      rendered: RenderedStatement,
      _binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): Promise<DriverRoutineResult> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      throw new UnsupportedFeatureError(
        "routine.call",
        "BRAID_CALL_UNSUPPORTED",
        "libSQL does not support routine calls.",
      );
    },
    async *stream<Row>(
      rendered: RenderedStatement,
      _binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): AsyncGenerator<Row> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      throw new UnsupportedFeatureError(
        "statement.stream",
        "BRAID_STREAM_UNSUPPORTED",
        "libSQL does not expose an incremental row cursor API.",
      );
    },
    begin: async (options?: TransactionOptions): Promise<void> => {
      if (transaction !== undefined)
        throw new TypeError("BRAID_TRANSACTION_STATE: a libSQL transaction is already active.");
      const mode = transactionModeFor(client, options);
      const next = mode === undefined ? await client.transaction() : await client.transaction(mode);
      if (
        !next ||
        typeof next.execute !== "function" ||
        typeof next.batch !== "function" ||
        typeof next.commit !== "function" ||
        typeof next.rollback !== "function"
      ) {
        const primary = new TypeError("BRAID_TRANSACTION_STATE: libSQL client returned an invalid transaction handle.");
        if (next && typeof next === "object" && typeof (next as { readonly close?: unknown }).close === "function") {
          const cleanup = createCleanupScope();
          cleanup.add(() => (next as { close(): void | PromiseLike<void> }).close());
          await cleanup.run(primary);
        }
        throw primary;
      }
      transaction = next;
    },
    commit: async (): Promise<void> => {
      const current = activeTransaction(transaction);
      transaction = undefined;
      let failed = false;
      let failure: unknown;
      try {
        await current.commit();
      } catch (error) {
        failed = true;
        failure = error;
      }
      await closeTransaction(current, failure);
      if (failed) throw failure;
    },
    rollback: async (): Promise<void> => {
      const current = activeTransaction(transaction);
      transaction = undefined;
      let failed = false;
      let failure: unknown;
      try {
        await current.rollback();
      } catch (error) {
        failed = true;
        failure = error;
      }
      await closeTransaction(current, failure);
      if (failed) throw failure;
    },
    savepoint: async (name: string): Promise<void> => {
      await activeTransaction(transaction).execute(transactionStatement(name, "SAVEPOINT"));
    },
    rollbackTo: async (name: string): Promise<void> => {
      await activeTransaction(transaction).execute(transactionStatement(name, "ROLLBACK TO SAVEPOINT"));
    },
    releaseSavepoint: async (name: string): Promise<void> => {
      await activeTransaction(transaction).execute(transactionStatement(name, "RELEASE SAVEPOINT"));
    },
  };
  return executor;
}

export function createLibsqlDatabase(client: LibsqlClientLike, options: LibsqlDatabaseOptions): Database {
  const { intMode, ...databaseOptions } = options;
  return createDatabase(createLibsqlExecutor(client, { intMode }), databaseOptions);
}
