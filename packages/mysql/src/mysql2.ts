import type {
  CommandResult,
  ConnectionLease,
  ConnectionProvider,
  DatabaseOptions,
  DriverRoutineResult,
  QueryExecutor,
  QueryExecutionResult,
  RenderedStatement,
  TypePolicy,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
} from "@sqlbraid/core";
import { createRenderedStatement, createStatementBindingDescription } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { typePolicy as defaultTypePolicy } from "./type-policy.js";

export interface Mysql2FieldLike {
  readonly name?: string;
  readonly type?: string | number;
}
export type Mysql2FieldPayload = readonly Mysql2FieldLike[] | readonly (readonly Mysql2FieldLike[])[];

export interface Mysql2ResultHeader extends CommandResult {
  readonly affectedRows?: number;
  readonly insertId?: number | bigint | string;
  readonly warningStatus?: number;
}

type Mysql2TypedParameter = { readonly type: number; readonly value: unknown; readonly unsigned: boolean };
export type Mysql2Parameter = string | number | bigint | boolean | Date | null | Blob | Uint8Array | Mysql2TypedParameter | Mysql2Parameter[] | { [key: string]: Mysql2Parameter };

export interface Mysql2RawStreamLike extends AsyncIterable<unknown> {
  readonly readableEnded?: boolean;
  readonly destroyed?: boolean;
  destroy?(error?: Error): this;
  resume?(): this;
  on?(event: string, listener: (...args: readonly unknown[]) => void): this;
  once(event: string, listener: (...args: readonly unknown[]) => void): this;
}

export interface Mysql2RawCommandLike {
  stream(options?: { readonly highWaterMark?: number }): Mysql2RawStreamLike;
}

export interface Mysql2RawConnectionLike {
  execute(sql: string, values?: Mysql2Parameter[]): Mysql2RawCommandLike;
  destroy(): void;
}

export interface Mysql2ConnectionLike {
  execute(sql: string, values?: Mysql2Parameter[]): Promise<readonly [unknown, Mysql2FieldPayload | undefined]>;
  query?(sql: string): Promise<readonly [unknown, Mysql2FieldPayload | undefined]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  getConnection?: never;
}

export interface Mysql2PoolConnectionLike extends Mysql2ConnectionLike {
  release(): void | Promise<void>;
  destroy(): void;
}

export interface Mysql2PoolLike {
  getConnection(): Promise<Mysql2PoolConnectionLike>;
}

export interface Mysql2ExecutorOptions {
  readonly typePolicy?: TypePolicy;
  readonly streamHighWaterMark?: number;
}

export type Mysql2DatabaseOptions = DatabaseOptions & Mysql2ExecutorOptions;

const mysqlTypes: Readonly<Record<number, string>> = { 3: "INT", 8: "BIGINT", 246: "DECIMAL", 253: "VARCHAR", 245: "JSON" };

function assertMysql2Connection(connection: Mysql2ConnectionLike): void {
  const candidate = connection as unknown as { readonly getConnection?: unknown };
  if (
    !connection
    || typeof connection !== "object"
    || typeof connection.execute !== "function"
    || typeof connection.beginTransaction !== "function"
    || typeof connection.commit !== "function"
    || typeof connection.rollback !== "function"
    || typeof candidate.getConnection === "function"
  ) {
    throw new TypeError("SQLBraid MySQL direct adapter requires a physical mysql2 Promise Connection.");
  }
}

function rawConnection(connection: Mysql2ConnectionLike): Mysql2RawConnectionLike | undefined {
  const candidate = connection as unknown as { readonly connection?: unknown };
  const raw = candidate.connection;
  if (!raw || typeof raw !== "object" || typeof (raw as { readonly execute?: unknown }).execute !== "function" || typeof (raw as { readonly destroy?: unknown }).destroy !== "function") {
    return undefined;
  }
  return raw as Mysql2RawConnectionLike;
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

function plainRow(value: unknown, fields: readonly Mysql2FieldLike[], policy: TypePolicy): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const row: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.name === key);
    const databaseType = typeof field?.type === "number" ? mysqlTypes[field.type] : field?.type;
    Object.defineProperty(row, key, {
      value: databaseType ? policy.decode(databaseType, entry) : entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return row;
}

function assertUniqueFields(fields: readonly Mysql2FieldLike[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (!field.name) continue;
    if (names.has(field.name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate MySQL result label ${field.name}.`);
    names.add(field.name);
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new Error("BRAID_BIND_HINT_UNSUPPORTED: MySQL adapter does not support explicit bind type hints.");
  }
}

function assertNoRoutineOutputsForQuery(rendered: RenderedStatement): void {
  if (rendered.resultKind !== "call" && rendered.parameters.some((parameter) => parameter.direction !== undefined && parameter.direction !== "in")) {
    throw new Error("BRAID_CALL_OUT_UNSUPPORTED: OUT/INOUT parameters are only valid for routine calls.");
  }
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();

export const mysql2StatementBinding: StatementBindingAdapter = Object.freeze({
  id: "mysql2",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertParameterHintsUnsupported(statement);
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "mysql2",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "reuse", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "mysql",
  requestedReuse: "auto",
});

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? mysql2StatementBinding.describe(statement, {
    dialectId: statement.dialectId,
    requestedReuse: defaultBindingContext.requestedReuse,
  });
  if (describedStatements.get(description) !== statement) throw new TypeError("BRAID_BINDING_IDENTITY: MySQL description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: MySQL binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
  };
}

function assertRoutineOutputsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.direction !== undefined && parameter.direction !== "in")) {
    throw new Error("BRAID_CALL_OUT_UNSUPPORTED: mysql2 does not expose a proven public discriminator for prepared CALL OUT/INOUT carrier results.");
  }
}

function resultSetFields(
  fields: Mysql2FieldPayload | undefined,
  index: number,
): readonly Mysql2FieldLike[] {
  if (!Array.isArray(fields)) return [];
  const candidate = fields[index];
  return Array.isArray(candidate) ? candidate : fields as readonly Mysql2FieldLike[];
}

export function createMysql2Executor(connection: Mysql2ConnectionLike, options: Mysql2ExecutorOptions = {}): QueryExecutor {
  assertMysql2Connection(connection);
  const policy = options.typePolicy ?? defaultTypePolicy;
  const highWaterMark = options.streamHighWaterMark ?? 16;
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) throw new RangeError("MySQL streamHighWaterMark must be a positive safe integer.");
  const control = async (sql: string): Promise<void> => { await (connection.query ?? connection.execute).call(connection, sql); };
  return {
    ownershipKey: connection,
    statementBinding: mysql2StatementBinding,
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      assertNoRoutineOutputsForQuery(rendered);
      const prepared = materialize(rendered, binding);
      const [payload, rawFields] = await connection.execute(prepared.text, prepared.values as unknown as Mysql2Parameter[]);
      const fields = resultSetFields(rawFields, 0);
      assertUniqueFields(fields);
      if (Array.isArray(payload)) {
        const rows = payload.map((row) => plainRow(row, fields ?? [], policy));
        return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
      }
      if (!payload || typeof payload !== "object") return { rows: [], rowCount: 0, kind: "command", command: {} };
      const header: Mysql2ResultHeader = { ...payload };
      return { rows: [], rowCount: header.affectedRows, kind: "command", command: header };
    },
    async *stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncGenerator<Row> {
      assertParameterHintsUnsupported(rendered);
      assertNoRoutineOutputsForQuery(rendered);
      signal?.throwIfAborted();
      const raw = rawConnection(connection);
      if (!raw) throw new Error("BRAID_STREAM_UNSUPPORTED: mysql2 Promise Connection does not expose its raw connection.");
      const prepared = materialize(rendered, binding);
      const command = raw.execute(prepared.text, prepared.values as Mysql2Parameter[]);
      const source = command.stream({ highWaterMark });
      let fields: readonly Mysql2FieldLike[] = [];
      let fieldsChanged = false;
      (source.on ?? source.once).call(source, "fields", (value: unknown) => {
        fields = Array.isArray(value) ? value : [];
        fieldsChanged = true;
      });
      const iterator = source[Symbol.asyncIterator]();
      let exhausted = false;
      let aborted = false;
      let streamError: unknown;
      const abort = (): void => {
        aborted = true;
        raw.destroy();
        const reason: unknown = signal?.reason;
        source.destroy?.(reason instanceof Error ? reason : new Error("MySQL stream aborted.", { cause: reason }));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        while (true) {
          signal?.throwIfAborted();
          const next = await iterator.next();
          if (fieldsChanged) {
            assertUniqueFields(fields);
            if (fields.length === 0) throw new Error("BRAID_RESULT_KIND: MySQL stream requires a row-producing statement.");
            fieldsChanged = false;
          }
          if (next.done) {
            exhausted = true;
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
          if (!exhausted && !aborted) {
            try {
              while (!(await iterator.next()).done) {
                signal?.throwIfAborted();
              }
            } catch (error) {
              const cleanup = cleanupError("MySQL stream command did not drain to completion.", error);
              if (streamError !== undefined) throw cleanupAggregate([streamError, cleanup], "MySQL stream cleanup failed.", streamError);
              throw cleanup;
            }
          }
          if (aborted) {
            const cleanup = cleanupError("MySQL physical connection was destroyed after stream abort.", signal?.reason);
            if (streamError !== undefined) throw cleanupAggregate([streamError, cleanup], "MySQL stream abort cleanup failed.", streamError);
            throw cleanup;
          }
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      }
    },
    async call(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<DriverRoutineResult> {
      assertRoutineOutputsUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const [payload, rawFields] = await connection.execute(prepared.text, prepared.values as Mysql2Parameter[]);
      if (!Array.isArray(payload)) return { output: payload && typeof payload === "object" ? Object.fromEntries(Object.entries(payload)) : {}, resultSets: [] };
      const nested = payload.some((entry) => Array.isArray(entry));
      const sets = nested ? payload.filter((entry): entry is readonly unknown[] => Array.isArray(entry)) : [payload];
      const resultSets = sets.map((rows, index) => {
        const fields = resultSetFields(rawFields, index);
        assertUniqueFields(fields);
        return {
          rows: rows.map((row) => plainRow(row, fields, policy)),
          source: { kind: "emitted" as const, index },
        };
      });
      return { output: {}, resultSets };
    },
    begin: connection.beginTransaction.bind(connection),
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    savepoint: (name) => control(`SAVEPOINT ${name}`),
    rollbackTo: (name) => control(`ROLLBACK TO SAVEPOINT ${name}`),
    releaseSavepoint: (name) => control(`RELEASE SAVEPOINT ${name}`),
  };
}

export function createMysql2Database(connection: Mysql2ConnectionLike, options: Mysql2DatabaseOptions = {}) {
  const { typePolicy, streamHighWaterMark, ...databaseOptions } = options;
  return createDatabase(createMysql2Executor(connection, { typePolicy, streamHighWaterMark }), databaseOptions);
}

export function createMysql2PoolProvider(pool: Mysql2PoolLike, options: Mysql2ExecutorOptions = {}): ConnectionProvider {
  return {
    statementBinding: mysql2StatementBinding,
    async acquire(): Promise<ConnectionLease> {
      const connection = await pool.getConnection();
      const executor = createMysql2Executor(connection, options);
      let released = false;
      return {
        ...executor,
        async release(releaseOptions = {}): Promise<void> {
          if (released) return;
          released = true;
          if (releaseOptions.discard === true) connection.destroy();
          else await connection.release();
        },
      };
    },
  };
}

export function createMysql2PoolDatabase(pool: Mysql2PoolLike, options: Mysql2DatabaseOptions = {}) {
  const { typePolicy, streamHighWaterMark, ...databaseOptions } = options;
  return createPooledDatabase(createMysql2PoolProvider(pool, { typePolicy, streamHighWaterMark }), databaseOptions);
}
