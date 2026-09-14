import type {
  BulkBindingDescription,
  CommandResult,
  ConnectionLease,
  ConnectionProvider,
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
  TypePolicy,
} from "@sqlbraid/core";
import {
  createBulkBindingDescription,
  createRenderedStatement,
  createStatementBindingDescription,
  ResultExactnessError,
} from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { typePolicy as defaultTypePolicy } from "./type-policy.js";

export interface MariaDbFieldLike {
  readonly name?: string | (() => string);
  readonly type?: string;
  readonly columnType?: number;
  readonly columnLength?: number;
  readonly scale?: number;
}

export interface MariaDbRowSet extends ReadonlyArray<unknown> {
  readonly meta?: readonly MariaDbFieldLike[];
}

export interface MariaDbCommandResult extends CommandResult {
  readonly warningStatus?: number;
}

export interface MariaDbStreamLike extends AsyncIterable<unknown> {
  close?(): void | Promise<void>;
  on?(event: string, listener: (...args: readonly unknown[]) => void): this;
  once?(event: string, listener: (...args: readonly unknown[]) => void): this;
}

export type MariaDbParameter = unknown;

export interface MariaDbConnectionLike {
  execute(sql: string, values?: readonly MariaDbParameter[]): Promise<unknown>;
  query?(sql: string, values?: readonly MariaDbParameter[]): Promise<unknown>;
  queryStream?(sql: string, values?: readonly MariaDbParameter[]): MariaDbStreamLike;
  batch?(sql: string, values: readonly (readonly MariaDbParameter[])[]): Promise<unknown>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  getConnection?: never;
  destroy?(): void;
  end?(): void | Promise<void>;
}

export interface MariaDbPoolConnectionLike extends MariaDbConnectionLike {
  release(): void | Promise<void>;
}

export interface MariaDbPoolLike {
  getConnection(): Promise<MariaDbPoolConnectionLike>;
}

export interface MariaDbExecutorOptions {
  readonly typePolicy?: TypePolicy;
}

export type MariaDbDatabaseOptions = DatabaseOptions & MariaDbExecutorOptions;

const fieldTypes: Readonly<Record<number, string>> = {
  0: "DECIMAL",
  1: "TINYINT",
  2: "SMALLINT",
  3: "INT",
  4: "FLOAT",
  5: "DOUBLE",
  7: "DATETIME",
  8: "BIGINT",
  9: "MEDIUMINT",
 10: "DATE",
 11: "TIME",
 12: "DATETIME",
 13: "YEAR",
 15: "VARCHAR",
 16: "BIT",
 245: "JSON",
 246: "DECIMAL",
 247: "ENUM",
 248: "SET",
 249: "TINYTEXT",
 250: "TEXT",
 251: "MEDIUMTEXT",
 252: "BLOB",
 253: "VARCHAR",
 254: "CHAR",
 255: "GEOMETRY",
};

function assertMariaDbConnection(connection: MariaDbConnectionLike): void {
  const candidate = connection as unknown as {
    readonly getConnection?: unknown;
  };
  if (
    !connection
    || typeof connection !== "object"
    || typeof connection.execute !== "function"
    || typeof connection.beginTransaction !== "function"
    || typeof connection.commit !== "function"
    || typeof connection.rollback !== "function"
    || typeof candidate.getConnection === "function"
  ) {
    throw new TypeError("SQLBraid MariaDB direct adapter requires a physical MariaDB Connector/Node.js Connection.");
  }
}

function cleanupError(message: string, cause?: unknown): Error & { readonly code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function cleanupAggregate(errors: readonly unknown[], message: string, cause?: unknown): AggregateError & { readonly code: string } {
  const error = new AggregateError(errors, message, cause === undefined ? undefined : { cause }) as AggregateError & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function databaseType(field: MariaDbFieldLike | undefined): string | undefined {
  if (typeof field?.type === "string" && field.type.length > 0) {
    const type = field.type.toUpperCase();
    if (type === "LONGLONG") return "BIGINT";
    if (type === "NEWDECIMAL") return "DECIMAL";
    if (type === "VAR_STRING" || type === "STRING") return "VARCHAR";
    if (type === "LONG") return "INT";
    return type;
  }
  return field?.columnType === undefined ? undefined : fieldTypes[field.columnType];
}

function fieldsFor(value: unknown): readonly MariaDbFieldLike[] {
  if (!Array.isArray(value)) return [];
  const meta = (value as MariaDbRowSet).meta;
  return Array.isArray(meta) ? meta : [];
}

function assertUniqueFields(fields: readonly MariaDbFieldLike[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    const name = typeof field.name === "function" ? field.name() : field.name;
    if (name === undefined) continue;
    if (names.has(name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate MariaDB result label ${name}.`);
    names.add(name);
  }
}

function plainRow(value: unknown, fields: readonly MariaDbFieldLike[], policy: TypePolicy): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BRAID_RESULT_COLUMNS: MariaDB Connector must return object result rows.");
  }
  const row: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.find((candidate) => (typeof candidate.name === "function" ? candidate.name() : candidate.name) === key);
    const type = databaseType(field);
    assertMariaDbNumericValue(type, entry);
    Object.defineProperty(row, key, {
      value: type === undefined ? entry : policy.decode(type, entry),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return row;
}

function assertMariaDbNumericValue(databaseType: string | undefined, value: unknown): void {
  if (value === null || value === undefined || databaseType === undefined) return;
  const type = databaseType.toUpperCase();
  if (type === "DECIMAL" || type === "NEWDECIMAL") {
    if (typeof value !== "string") {
      throw new ResultExactnessError("MariaDB DECIMAL results must remain strings.");
    }
    return;
  }
  if (type === "BIGINT" || type === "LONGLONG") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new ResultExactnessError("MariaDB BIGINT result was an unsafe JavaScript number.");
    }
    if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
      throw new ResultExactnessError("MariaDB BIGINT result has an unsupported representation.");
    }
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new Error("BRAID_BIND_HINT_UNSUPPORTED: MariaDB Connector/Node.js does not expose SQLBraid parameter type descriptors.");
  }
}

function assertRoutineOutputsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.direction !== undefined && parameter.direction !== "in")) {
    throw new Error("BRAID_CALL_OUT_UNSUPPORTED: MariaDB Connector/Node.js does not expose a proven public OUT/INOUT carrier discriminator.");
  }
}

function isNestedResultPayload(value: unknown): value is readonly unknown[][] {
  return Array.isArray(value)
    && !Object.hasOwn(value, "meta")
    && value.some((entry) => Array.isArray(entry));
}

function resultRows(value: unknown, policy: TypePolicy): QueryExecutionResult<unknown> {
  if (isNestedResultPayload(value)) {
    throw new Error("BRAID_RESULT_SETS_UNSUPPORTED: MariaDB returned multiple result sets; use database.call().");
  }
  if (Array.isArray(value)) {
    const fields = fieldsFor(value);
    assertUniqueFields(fields);
    const rows = value.map((row) => plainRow(row, fields, policy));
    return { rows, rowCount: rows.length, kind: "rows" };
  }
  if (!value || typeof value !== "object") {
    return { rows: [], rowCount: 0, kind: "command", command: {} };
  }
  const command: MariaDbCommandResult = { ...value } as MariaDbCommandResult;
  return {
    rows: [],
    rowCount: command.affectedRows,
    kind: "command",
    command,
  };
}

function affectedRows(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    let total = 0;
    let found = false;
    for (const item of value) {
      const count = affectedRows(item);
      if (count !== undefined) {
        total += count;
        found = true;
      }
    }
    return found ? total : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const count = (value as { readonly affectedRows?: unknown }).affectedRows;
  return typeof count === "number" ? count : typeof count === "bigint" ? Number(count) : undefined;
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();
const bulkMatrices = new WeakMap<BulkBindingDescription, readonly (readonly unknown[])[]>();

export const mariaDbStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "mariadb",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertParameterHintsUnsupported(statement);
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "mariadb",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "reuse", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    assertParameterHintsUnsupported(statement);
    assertRoutineOutputsUnsupported(statement);
    const parameterSets = Object.freeze(bulk.parameterSets.map((values) => {
      if (!Array.isArray(values) || values.length !== statement.parameters.length) {
        throw new Error("BRAID_BULK_SHAPE: MariaDB bulk parameter sets must match the first rendered statement shape.");
      }
      return Object.freeze([...values]);
    }));
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "mariadb",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "reuse", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    bulkMatrices.set(description, parameterSets);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "mariadb",
  requestedReuse: "auto",
});

const mariaDbEnvironment = Object.freeze<DriverEnvironment>({
  database: { product: "mariadb" },
  driver: { id: "mariadb", profile: "connector-node-exact" },
  capabilities: {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": {
      status: "guarded",
      canonical: "bigint",
      rawRepresentations: ["bigint", "string", "number"],
      conditionCode: "mariadb.exact-numeric-profile",
    },
    "numeric.exact-decimal": {
      status: "guarded",
      canonical: "string",
      rawRepresentations: ["string"],
      conditionCode: "mariadb.exact-numeric-profile",
    },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
  },
  probe: {
    statement: createRenderedStatement({
      segments: ["SELECT VERSION() AS version"],
      parameters: [],
      resultKind: "rows",
      dialectId: "mariadb",
    }),
    read: (rows) => {
      const row = rows[0];
      if (!row || typeof row !== "object" || Array.isArray(row)) return {};
      const version = (row as Record<string, unknown>).version;
      return typeof version === "string" ? { version } : {};
    },
  },
});

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? mariaDbStatementBinding.describe(statement, {
    dialectId: statement.dialectId,
    requestedReuse: defaultBindingContext.requestedReuse,
  });
  if (describedStatements.get(description) !== statement) {
    throw new TypeError("BRAID_BINDING_IDENTITY: MariaDB description belongs to another statement or adapter.");
  }
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: MariaDB binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
  };
}

function materializeBulk(
  bulk: RenderedBulk,
  binding: BulkBindingDescription | undefined,
): { readonly text: string; readonly values: readonly (readonly unknown[])[]; readonly itemCount: number } {
  const statement = createRenderedStatement(bulk.statement);
  assertParameterHintsUnsupported(statement);
  assertRoutineOutputsUnsupported(statement);
  const description = binding ?? mariaDbStatementBinding.describeBulk!(bulk, {
    dialectId: statement.dialectId,
    requestedReuse: defaultBindingContext.requestedReuse,
  });
  if (describedBulks.get(description) !== bulk) {
    throw new TypeError("BRAID_BINDING_IDENTITY: MariaDB description belongs to another bulk statement or adapter.");
  }
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: MariaDB bulk binding description did not provide parameterized SQL.");
  }
  if (description.itemCount !== bulk.parameterSets.length) {
    throw new TypeError("BRAID_BULK_SHAPE: MariaDB bulk binding item count does not match the rendered parameter matrix.");
  }
  const matrix = bulkMatrices.get(description);
  if (matrix === undefined) throw new TypeError("BRAID_BINDING_IDENTITY: MariaDB bulk description has no encoded parameter matrix.");
  const values: readonly (readonly unknown[])[] = Array.from(
    { length: description.itemCount },
    (_, index) => matrix[index] ?? description.valuesAt(index),
  );
  return { text: description.parameterizedSql, values, itemCount: description.itemCount };
}

function streamClose(stream: MariaDbStreamLike): Promise<void> {
  try {
    return Promise.resolve(stream.close?.()).then(() => undefined);
  } catch (error) {
    return Promise.reject(error);
  }
}

function connectionControl(connection: MariaDbConnectionLike): (sql: string) => Promise<void> {
  const run = connection.query ?? connection.execute;
  return async (sql: string): Promise<void> => {
    await run.call(connection, sql);
  };
}

export function createMariaDbExecutor(connection: MariaDbConnectionLike, options: MariaDbExecutorOptions = {}): QueryExecutor {
  assertMariaDbConnection(connection);
  const policy = options.typePolicy ?? defaultTypePolicy;
  const control = connectionControl(connection);
  return {
    ownershipKey: connection,
    statementBinding: mariaDbStatementBinding,
    environment: policy === defaultTypePolicy ? mariaDbEnvironment : { ...mariaDbEnvironment, driver: { id: "mariadb", profile: "custom-type-policy" }, capabilities: {} },
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      assertRoutineOutputsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const result = await connection.execute(prepared.text, prepared.values);
      return resultRows(result, policy) as QueryExecutionResult<Row>;
    },
    async *stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncGenerator<Row> {
      assertParameterHintsUnsupported(rendered);
      assertRoutineOutputsUnsupported(rendered);
      signal?.throwIfAborted();
      if (typeof connection.queryStream !== "function") {
        throw new Error("BRAID_STREAM_UNSUPPORTED: MariaDB Connector/Node.js connection does not expose queryStream().");
      }
      const prepared = materialize(rendered, binding);
      const stream = connection.queryStream(prepared.text, prepared.values);
      if (typeof stream.close !== "function") {
        throw new Error("BRAID_STREAM_UNSUPPORTED: MariaDB Connector/Node.js queryStream does not expose close().");
      }
      let fields: readonly MariaDbFieldLike[] = [];
      let fieldsChanged = false;
      let fieldsSeen = 0;
      let pendingError: unknown;
      const onFields = (value: unknown): void => {
        fieldsSeen += 1;
        if (fieldsSeen === 1) {
          fields = Array.isArray(value) ? value as readonly MariaDbFieldLike[] : [];
          fieldsChanged = true;
        } else {
          pendingError ??= new Error("BRAID_RESULT_SETS_UNSUPPORTED: MariaDB stream returned multiple result sets; use database.call().");
        }
      };
      (stream.on ?? stream.once)?.call(stream, "fields", onFields);
      let iterator: AsyncIterator<unknown> | undefined;
      try {
        iterator = stream[Symbol.asyncIterator]();
      } catch (error) {
        throw error;
      }
      let exhausted = false;
      let streamError: unknown;
      let closing: Promise<void> | undefined;
      const abort = (): void => {
        closing ??= streamClose(stream);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        while (true) {
          signal?.throwIfAborted();
          const next = await iterator.next();
          exhausted = next.done === true;
          if (pendingError !== undefined) throw pendingError;
          if (fieldsChanged) {
            assertUniqueFields(fields);
            if (fields.length === 0) throw new Error("BRAID_RESULT_KIND: MariaDB stream requires a row-producing statement.");
            fieldsChanged = false;
          }
          if (next.done) {
            if (fieldsSeen === 0) throw new Error("BRAID_RESULT_KIND: MariaDB stream requires a row-producing statement.");
            break;
          }
          signal?.throwIfAborted();
          yield plainRow(next.value, fields, policy) as Row;
        }
      } catch (error) {
        streamError = error;
        throw error;
      } finally {
        try {
          if (!exhausted) closing ??= streamClose(stream);
          if (closing !== undefined) await closing;
          if (streamError === undefined && pendingError !== undefined) throw pendingError;
        } catch (error) {
          const cleanup = cleanupError("MariaDB stream cleanup failed.", error);
          if (streamError !== undefined) throw cleanupAggregate([streamError, cleanup], "MariaDB stream cleanup failed.", streamError);
          throw cleanup;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      }
    },
    async call(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<DriverRoutineResult> {
      assertRoutineOutputsUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const value = await connection.execute(prepared.text, prepared.values);
      if (!Array.isArray(value)) return { output: {}, resultSets: [] };
      const sets = isNestedResultPayload(value)
        ? value.filter((entry): entry is MariaDbRowSet => Array.isArray(entry))
        : [value as MariaDbRowSet];
      const resultSets = sets.map((rows, index) => {
        const fields = fieldsFor(rows);
        assertUniqueFields(fields);
        return {
          rows: rows.map((row) => plainRow(row, fields, policy)),
          source: { kind: "emitted" as const, index },
        };
      });
      return { output: {}, resultSets };
    },
    async bulk(bulk: RenderedBulk, binding?: BulkBindingDescription) {
      const prepared = materializeBulk(bulk, binding);
      if (typeof connection.batch !== "function") {
        throw new Error("BRAID_BULK_UNSUPPORTED: MariaDB Connector/Node.js connection does not expose batch().");
      }
      const result = await connection.batch(prepared.text, prepared.values);
      return {
        inputCount: prepared.itemCount,
        affectedRows: affectedRows(result),
        executionMode: "native-bulk" as const,
      };
    },
    begin: connection.beginTransaction.bind(connection),
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    savepoint: (name) => control(`SAVEPOINT ${name}`),
    rollbackTo: (name) => control(`ROLLBACK TO SAVEPOINT ${name}`),
    releaseSavepoint: (name) => control(`RELEASE SAVEPOINT ${name}`),
  };
}

export function createMariaDbDatabase(connection: MariaDbConnectionLike, options: MariaDbDatabaseOptions = {}) {
  const { typePolicy, ...databaseOptions } = options;
  return createDatabase(createMariaDbExecutor(connection, { typePolicy }), databaseOptions);
}

export function createMariaDbPoolProvider(pool: MariaDbPoolLike, options: MariaDbExecutorOptions = {}): ConnectionProvider {
  if (!pool || typeof pool !== "object" || typeof pool.getConnection !== "function") {
    throw new TypeError("SQLBraid MariaDB pool adapter requires a MariaDB Connector/Node.js Pool.");
  }
  return {
    statementBinding: mariaDbStatementBinding,
    environment: options.typePolicy === undefined || options.typePolicy === defaultTypePolicy ? mariaDbEnvironment : { ...mariaDbEnvironment, driver: { id: "mariadb", profile: "custom-type-policy" }, capabilities: {} },
    async acquire(): Promise<ConnectionLease> {
      const connection = await pool.getConnection();
      const executor = createMariaDbExecutor(connection, options);
      let released = false;
      return {
        ...executor,
        async release(releaseOptions = {}): Promise<void> {
          if (released) return;
          released = true;
          if (releaseOptions.discard === true) {
            if (typeof connection.destroy === "function") {
              connection.destroy();
              return;
            }
            if (typeof connection.end === "function") {
              await connection.end();
              return;
            }
          }
          await connection.release();
        },
      };
    },
  };
}

export function createMariaDbPoolDatabase(pool: MariaDbPoolLike, options: MariaDbDatabaseOptions = {}) {
  const { typePolicy, ...databaseOptions } = options;
  return createPooledDatabase(createMariaDbPoolProvider(pool, { typePolicy }), databaseOptions);
}
