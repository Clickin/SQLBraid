import type {
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

export interface PgFieldLike {
  readonly name: string;
  readonly dataTypeID?: number;
  readonly dataType?: string;
}

export interface PgResultLike {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
  readonly fields?: readonly PgFieldLike[];
  readonly command?: string;
}

export interface PgClientLike {
  query(config: { readonly text: string; readonly values: readonly unknown[] }): Promise<PgResultLike>;
  query(text: string, values?: readonly unknown[]): Promise<PgResultLike>;
  /**
   * Physical node-postgres clients expose these helpers; pools do not.
   * They are the public discriminator that keeps pool usage on the lease API.
   */
  escapeIdentifier(value: string): string;
  escapeLiteral(value: string): string;
  /** Required when streaming with an AbortSignal; ends the physical connection. */
  end?(): Promise<void>;
}

export interface PgPoolClientLike extends PgClientLike {
  release(destroy?: boolean): void | Promise<void>;
}

export interface PgPoolLike {
  connect(): Promise<PgPoolClientLike>;
}

export interface PgCursorLike {
  read(rowCount: number, callback: (error: unknown, rows?: readonly unknown[], result?: PgResultLike) => void): void;
  close(callback: (error?: unknown) => void): void;
}

export interface PgCursorFactory {
  new (text: string, values: readonly unknown[]): PgCursorLike;
}

export interface PgExecutorOptions {
  readonly typePolicy?: TypePolicy;
  readonly streamBatchSize?: number;
  readonly cursor?: PgCursorFactory;
}

export type PgDatabaseOptions = DatabaseOptions & PgExecutorOptions;

const oidTypes: Readonly<Record<number, string>> = { 20: "int8", 21: "int2", 23: "int4", 16: "bool", 25: "text", 1700: "numeric" };

async function optionalCursorFactory(): Promise<PgCursorFactory> {
  try {
    const loaded = await import("pg-cursor") as unknown as { readonly default?: unknown };
    const factory = loaded.default;
    if (typeof factory !== "function") throw new TypeError("pg-cursor did not export a constructor.");
    return factory as PgCursorFactory;
  } catch (error) {
    throw new Error("BRAID_STREAM_UNSUPPORTED: PostgreSQL streaming requires the optional pg-cursor peer.", { cause: error });
  }
}

function cursorOperation<T>(
  signal: AbortSignal | undefined,
  run: (done: (error: unknown, result: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = signal ? (): void => reject(signal.reason) : undefined;
    const removeAbort = (): void => {
      if (abort) signal!.removeEventListener("abort", abort);
    };
    if (signal?.aborted) { reject(signal.reason); return; }
    if (abort) signal!.addEventListener("abort", abort, { once: true });
    try {
      run((error, result) => {
        removeAbort();
        if (error !== undefined && error !== null) reject(error);
        else resolve(result);
      });
    } catch (error) {
      removeAbort();
      reject(error);
    }
  });
}

function readCursor(cursor: PgCursorLike, rowCount: number, signal?: AbortSignal): Promise<PgResultLike> {
  return cursorOperation(signal, (done) => {
    cursor.read(rowCount, (error, rows, result) => done(error, result ?? { rows: rows ?? [] }));
  });
}

function cleanupFailure(message: string, cause?: unknown): Error & { readonly code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function cleanupAggregate(errors: readonly unknown[], message: string, cause?: unknown): AggregateError & { readonly code: string } {
  const error = new AggregateError(errors, message, cause === undefined ? undefined : { cause }) as AggregateError & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function assertPgClient(client: PgClientLike): void {
  if (!client || typeof client !== "object" || typeof client.escapeIdentifier !== "function" || typeof client.escapeLiteral !== "function") {
    throw new TypeError("SQLBraid PostgreSQL direct adapter requires a physical pg Client or PoolClient.");
  }
}

function plainRow(value: unknown, fields: readonly PgFieldLike[], policy: TypePolicy): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const row: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.name === key);
    const databaseType = field?.dataType ?? (field?.dataTypeID === undefined ? undefined : oidTypes[field.dataTypeID]);
    Object.defineProperty(row, key, {
      value: databaseType ? policy.decode(databaseType, entry) : entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return row;
}

function assertUniqueFields(fields: readonly PgFieldLike[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate PostgreSQL result label ${field.name}.`);
    names.add(field.name);
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) =>
    parameter.hint !== undefined
    && !(rendered.resultKind === "call" && isRefcursor(parameter))
  )) {
    throw new Error("BRAID_BIND_HINT_UNSUPPORTED: PostgreSQL adapter does not support explicit bind type hints.");
  }
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const bindingContexts = new WeakMap<StatementBindingDescription, StatementBindingContext>();

function isRefcursor(parameter: RenderedStatement["parameters"][number]): boolean {
  return parameter.direction !== undefined
    && parameter.direction !== "in"
    && parameter.hint?.databaseType.trim().toLowerCase() === "refcursor";
}

function hasRefcursor(rendered: RenderedStatement): boolean {
  return rendered.parameters.some(isRefcursor);
}

export const pgStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "pg",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    if (hasRefcursor(statement) && context.transactionScoped !== true) {
      throw new Error("BRAID_CALL_CURSOR_TX_REQUIRED: PostgreSQL refcursor calls require an existing transaction.");
    }
    assertParameterHintsUnsupported(statement);
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "pg",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    describedStatements.set(description, statement);
    bindingContexts.set(description, context);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "postgres",
  requestedReuse: "auto",
});

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? pgStatementBinding.describe(statement, {
    dialectId: statement.dialectId,
    requestedReuse: defaultBindingContext.requestedReuse,
  });
  if (describedStatements.get(description) !== statement) throw new TypeError("BRAID_BINDING_IDENTITY: PostgreSQL description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: PostgreSQL binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
  };
}

function outputRow(
  result: PgResultLike,
  rendered: RenderedStatement,
  policy: TypePolicy,
): Readonly<Record<string, unknown>> {
  const outputParameters = rendered.parameters.filter((parameter) => parameter.direction !== undefined && parameter.direction !== "in");
  if (outputParameters.length === 0 || result.rows.length === 0) return {};
  const row = result.rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  const fields = result.fields ?? [];
  let values: unknown[] | undefined;
  const output: Record<string, unknown> = {};
  let positional = 0;
  for (const parameter of outputParameters) {
    const name = parameter.outputName;
    if (!name) continue;
    const field = fields[positional];
    const source = field === undefined
      ? (values ??= Object.values(row))[positional]
      : Object.hasOwn(row, field.name) ? (row as Record<string, unknown>)[field.name] : undefined;
    positional += 1;
    const databaseType = field?.dataType ?? (field?.dataTypeID === undefined ? undefined : oidTypes[field.dataTypeID]);
    Object.defineProperty(output, name, {
      value: databaseType ? policy.decode(databaseType, source) : source,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function quotePortal(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function createPgExecutor(client: PgClientLike, options: PgExecutorOptions = {}): QueryExecutor {
  assertPgClient(client);
  const policy = options.typePolicy ?? defaultTypePolicy;
  const batchSize = options.streamBatchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new RangeError("PostgreSQL streamBatchSize must be a positive safe integer.");
  const runControl = async (text: string): Promise<void> => { await client.query({ text, values: [] }); };
  return {
    ownershipKey: client,
    statementBinding: pgStatementBinding,
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      const result = await client.query(materialize(rendered, binding));
      assertUniqueFields(result.fields ?? []);
      const rows = result.rows.map((row) => plainRow(row, result.fields ?? [], policy));
      const rowCount = result.rowCount ?? undefined;
      const rowBearing = (result.fields?.length ?? 0) > 0 || result.rows.length > 0 || result.command === "SELECT";
      return rowBearing ? { rows: rows as readonly Row[], rowCount, kind: "rows" } : { rows: [], rowCount, kind: "command", command: { affectedRows: rowCount } };
    },
    async *stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncGenerator<Row> {
      assertParameterHintsUnsupported(rendered);
      signal?.throwIfAborted();
      if (signal && typeof client.end !== "function") {
        throw new Error("BRAID_STREAM_UNSUPPORTED: abortable PostgreSQL streams require the physical client's end() method.");
      }
      const prepared = materialize(rendered, binding);
      const Cursor = options.cursor ?? await optionalCursorFactory();
      signal?.throwIfAborted();
      const cursor = new Cursor(prepared.text, prepared.values);
      let ending: Promise<void> | undefined;
      const abort = (): void => {
        // Closing a portal cannot interrupt an in-flight Execute. Disconnect instead.
        ending ??= Promise.resolve().then(() => client.end!());
        void ending.catch(() => undefined); // Observed by the cleanup path below.
      };
      signal?.addEventListener("abort", abort, { once: true });
      let streamError: unknown;
      try {
        // pg's optional Submittable overload is used only by the cursor capability.
        (client.query as unknown as (cursor: PgCursorLike) => PgCursorLike).call(client, cursor);
        while (true) {
          signal?.throwIfAborted();
          const result = await readCursor(cursor, batchSize, signal);
          const fields = result.fields ?? [];
          assertUniqueFields(fields);
          if (result.fields !== undefined && fields.length === 0) throw new Error("BRAID_RESULT_KIND: PostgreSQL stream requires a row-producing statement.");
          const rows = result.rows;
          if (rows.length === 0) break;
          for (const row of rows) {
            signal?.throwIfAborted();
            yield plainRow(row, fields, policy) as Row;
          }
          if (rows.length < batchSize) break;
        }
      } catch (error) {
        streamError = error;
        throw error;
      } finally {
        try {
          if (!ending) {
            try {
              await cursorOperation<void>(signal, (done) => cursor.close((error) => done(error, undefined)));
            } catch (error) {
              if (!ending) throw error;
            }
          }
          if (ending) {
            await ending;
            throw cleanupFailure("PostgreSQL physical connection was terminated after stream abort.", signal?.reason);
          }
        } catch (error) {
          const cleanup = cleanupFailure("PostgreSQL cursor close failed.", error);
          if (streamError !== undefined) throw cleanupAggregate([streamError, cleanup], "PostgreSQL cursor cleanup failed.", streamError);
          throw cleanup;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      }
    },
    async call(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<DriverRoutineResult> {
      assertParameterHintsUnsupported(rendered);
      const transactionScoped = binding === undefined ? false : bindingContexts.get(binding)?.transactionScoped === true;
      if (hasRefcursor(rendered) && !transactionScoped) {
        throw new Error("BRAID_CALL_CURSOR_TX_REQUIRED: PostgreSQL refcursor calls require an existing transaction.");
      }
      const result = await client.query(materialize(rendered, binding));
      assertUniqueFields(result.fields ?? []);
      const output = outputRow(result, rendered, policy);
      const cursorParameters = rendered.parameters.filter(isRefcursor);
      if (cursorParameters.length === 0) {
        const rows = rendered.parameters.some((parameter) => parameter.direction !== undefined && parameter.direction !== "in")
          ? []
          : result.rows.map((row) => plainRow(row, result.fields ?? [], policy));
        return {
          output,
          resultSets: rows.length === 0 ? [] : [{ rows, source: { kind: "emitted", index: 0 } }],
        };
      }
      const portals = cursorParameters.map((parameter) => {
        const name = parameter.outputName;
        if (!name || !Object.hasOwn(output, name) || typeof output[name] !== "string") {
          throw new Error(`BRAID_CALL_CURSOR: PostgreSQL refcursor output ${name ?? "<unnamed>"} did not return a portal name.`);
        }
        return { outputName: name, portal: output[name] as string };
      });
      const normalizedOutput = Object.fromEntries(
        Object.entries(output).filter(([name]) => !cursorParameters.some((parameter) => parameter.outputName === name)),
      );
      const resultSets: DriverRoutineResult["resultSets"][number][] = [];
      const live = [...portals];
      let failure: unknown;
      try {
        for (const entry of portals) {
          const fetched = await client.query({ text: `FETCH ALL FROM ${quotePortal(entry.portal)}`, values: [] });
          assertUniqueFields(fetched.fields ?? []);
          resultSets.push({
            rows: fetched.rows.map((row) => plainRow(row, fetched.fields ?? [], policy)),
            source: {
              kind: "out-cursor",
              name: entry.outputName,
              parameterIndex: rendered.parameters.findIndex((parameter) => parameter.outputName === entry.outputName),
            },
          });
          await client.query({ text: `CLOSE ${quotePortal(entry.portal)}`, values: [] });
          live.shift();
        }
      } catch (error) {
        failure = error;
      }
      const cleanupErrors: unknown[] = [];
      for (const entry of live) {
        try {
          await client.query({ text: `CLOSE ${quotePortal(entry.portal)}`, values: [] });
        } catch (error) {
          cleanupErrors.push(cleanupFailure(`PostgreSQL refcursor ${entry.outputName} close failed.`, error));
        }
      }
      if (failure !== undefined) {
        if (cleanupErrors.length > 0) throw cleanupAggregate([failure, ...cleanupErrors], "PostgreSQL refcursor cleanup failed.", failure);
        throw failure;
      }
      if (cleanupErrors.length > 0) throw cleanupAggregate(cleanupErrors, "PostgreSQL refcursor cleanup failed.");
      return { output: normalizedOutput, resultSets };
    },
    begin: () => runControl("BEGIN"),
    commit: () => runControl("COMMIT"),
    rollback: () => runControl("ROLLBACK"),
    savepoint: (name) => runControl(`SAVEPOINT ${name}`),
    rollbackTo: (name) => runControl(`ROLLBACK TO SAVEPOINT ${name}`),
    releaseSavepoint: (name) => runControl(`RELEASE SAVEPOINT ${name}`),
  };
}

export function createPgDatabase(client: PgClientLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, cursor, streamBatchSize, ...databaseOptions } = options;
  return createDatabase(createPgExecutor(client, { typePolicy, cursor, streamBatchSize }), databaseOptions);
}

export function createPgPoolProvider(pool: PgPoolLike, options: PgExecutorOptions = {}): ConnectionProvider {
  return {
    statementBinding: pgStatementBinding,
    async acquire(): Promise<ConnectionLease> {
      const client = await pool.connect();
      const executor = createPgExecutor(client, options);
      let released = false;
      return {
        ...executor,
        async release(releaseOptions = {}): Promise<void> {
          if (released) return;
          released = true;
          if (releaseOptions.discard === true) await client.release(true);
          else await client.release();
        },
      };
    },
  };
}

export function createPgPoolDatabase(pool: PgPoolLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, cursor, streamBatchSize, ...databaseOptions } = options;
  return createPooledDatabase(createPgPoolProvider(pool, { typePolicy, cursor, streamBatchSize }), databaseOptions);
}
