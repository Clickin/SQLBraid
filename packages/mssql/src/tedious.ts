import { Buffer } from "node:buffer";
import { ISOLATION_LEVEL, Request, TYPES } from "tedious";
import type {
  ConnectionLease,
  ConnectionProvider,
  DatabaseOptions,
  ParameterTypeHint,
  QueryExecutor,
  QueryExecutionResult,
  RenderedQuery,
  RoutineCallResult,
  TypePolicy,
} from "@sqlbraid/core";
import { isBoundParameter } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { typePolicy as defaultTypePolicy } from "./type-policy.js";

export interface TediousColumnMetadataLike {
  readonly colName?: string;
  readonly name?: string;
  readonly type?: { readonly name?: string } | string;
  readonly precision?: number;
  readonly scale?: number;
  readonly dataLength?: number;
}

export interface TediousColumnLike {
  readonly value?: unknown;
  readonly metadata?: TediousColumnMetadataLike;
}

export interface TediousRequestLike {
  on(event: string, listener: (...args: any[]) => void): this;
  addParameter(name: string, type: unknown, value: unknown, options?: { readonly length?: number; readonly precision?: number; readonly scale?: number }): void;
  cancel?(): void;
  pause?(): void;
  resume?(): void;
}

export interface TediousConnectionLike {
  execSql(request: TediousRequestLike): void;
  readonly beginTransaction: (...args: any[]) => void;
  readonly commitTransaction: (...args: any[]) => void;
  readonly rollbackTransaction: (...args: any[]) => void;
  readonly saveTransaction: (...args: any[]) => void;
  cancel?(): void;
  close?(): void | Promise<void>;
}

export interface TediousPoolConnectionLike extends TediousConnectionLike {
  release(): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

export interface TediousPoolLike {
  acquire?(): Promise<TediousPoolConnectionLike>;
  connect?(): Promise<TediousPoolConnectionLike>;
  getConnection?(): Promise<TediousPoolConnectionLike>;
}

export type TediousDatabaseOptions = DatabaseOptions & {
  readonly typePolicy?: TypePolicy;
  readonly maxBufferedRows?: number;
};

export type TediousExecutorOptions = {
  readonly typePolicy?: TypePolicy;
  readonly maxBufferedRows?: number;
};

type DatabaseType = "int" | "bigint" | "decimal" | "numeric" | "float" | "bit" | "nvarchar" | "varchar" | "char" | "varbinary" | "binary" | "uniqueidentifier" | "date" | "datetime2" | "datetimeoffset";

const typeNames: Readonly<Record<DatabaseType, string>> = {
  int: "Int",
  bigint: "BigInt",
  decimal: "Decimal",
  numeric: "Numeric",
  float: "Float",
  bit: "Bit",
  nvarchar: "NVarChar",
  varchar: "VarChar",
  char: "Char",
  varbinary: "VarBinary",
  binary: "Binary",
  uniqueidentifier: "UniqueIdentifier",
  date: "Date",
  datetime2: "DateTime2",
  datetimeoffset: "DateTimeOffset",
};

function canonicalType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]/gu, "");
}

function typeForHint(hint: ParameterTypeHint): DatabaseType {
  const value = canonicalType(hint.databaseType);
  const aliases: Readonly<Record<string, DatabaseType>> = {
    int: "int",
    integer: "int",
    int32: "int",
    int64: "bigint",
    bigint: "bigint",
    decimal: "decimal",
    numeric: "numeric",
    float: "float",
    bit: "bit",
    boolean: "bit",
    nvarchar: "nvarchar",
    varchar: "varchar",
    char: "char",
    varbinary: "varbinary",
    binary: "binary",
    uniqueidentifier: "uniqueidentifier",
    uuid: "uniqueidentifier",
    date: "date",
    datetime2: "datetime2",
    datetimeoffset: "datetimeoffset",
  };
  const result = aliases[value];
  if (!result) throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: unsupported SQL Server parameter type ${hint.databaseType}.`);
  const hasUnsupportedFacet = (facet: string): never => {
    throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: ${hint.databaseType} does not support ${facet}.`);
  };
  if (result !== "decimal" && result !== "numeric" && hint.precision !== undefined) hasUnsupportedFacet("precision");
  if (result !== "decimal" && result !== "numeric" && result !== "datetime2" && result !== "datetimeoffset" && hint.scale !== undefined) {
    hasUnsupportedFacet("scale");
  }
  if (result !== "nvarchar" && result !== "varchar" && result !== "char" && result !== "varbinary" && result !== "binary" && hint.length !== undefined) {
    hasUnsupportedFacet("length");
  }
  if ((result === "decimal" || result === "numeric") && hint.length !== undefined) hasUnsupportedFacet("length");
  if ((result === "datetime2" || result === "datetimeoffset") && hint.length !== undefined) hasUnsupportedFacet("length");
  if ((result === "decimal" || result === "numeric") && (hint.precision === undefined || hint.scale === undefined)) {
    throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: ${hint.databaseType} requires precision and scale.`);
  }
  if ((result === "decimal" || result === "numeric")
    && (hint.precision! < 1 || hint.precision! > 38 || hint.scale! < 0 || hint.scale! > hint.precision!)) {
    throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: ${hint.databaseType} precision must be 1..38 and scale must be 0..precision.`);
  }
  if ((result === "datetime2" || result === "datetimeoffset")
    && (hint.scale !== undefined && (!Number.isSafeInteger(hint.scale) || hint.scale < 0 || hint.scale > 7))) {
    throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: ${hint.databaseType} scale must be an integer from 0 through 7.`);
  }
  if (result === "nvarchar" || result === "varchar" || result === "char" || result === "varbinary" || result === "binary") {
    if (hint.length === undefined) throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: ${hint.databaseType} requires a length or "max".`);
    if (hint.length !== "max" && (!Number.isSafeInteger(hint.length) || hint.length <= 0)) {
      throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: ${hint.databaseType} length must be a positive integer or "max".`);
    }
    const maximum = result === "nvarchar" ? 4000 : 8000;
    if (hint.length !== "max" && hint.length > maximum) {
      throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: ${hint.databaseType} length exceeds SQL Server's ${maximum}-character limit.`);
    }
  }
  return result;
}

function inferType(value: unknown): { readonly type: DatabaseType; readonly value: unknown } {
  if (typeof value === "string") return { type: "nvarchar", value };
  if (typeof value === "boolean") return { type: "bit", value };
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("BRAID_BIND_TYPE_REQUIRED: invalid Date requires an explicit SQL Server hint.");
    return { type: "datetime2", value };
  }
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value)) {
      throw new TypeError("BRAID_BIND_TYPE_REQUIRED: non-finite or unsafe number requires an explicit SQL Server hint.");
    }
    if (Number.isInteger(value)) {
      return Math.abs(value) <= 2_147_483_647 ? { type: "int", value } : { type: "bigint", value: String(value) };
    }
    return { type: "float", value };
  }
  if (value instanceof Uint8Array) return { type: "varbinary", value };
  throw new TypeError("BRAID_BIND_TYPE_REQUIRED: this value requires an explicit SQL Server parameter hint.");
}

function decimalInput(value: unknown): unknown {
  if (value === null) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new TypeError("BRAID_BIND_DECIMAL_EXACTNESS: Tedious sends Decimal/Numeric parameters as JavaScript numbers; use a finite safe number.");
    }
    return value;
  }
  if (typeof value !== "string" || !/^-?(?:\d+)(?:\.\d+)?$/u.test(value)) {
    throw new TypeError("BRAID_BIND_DECIMAL_EXACTNESS: Decimal/Numeric parameters accept only finite safe numbers or plain decimal strings.");
  }
  const digits = value.replace(/^-?/u, "").replace(/\./gu, "").replace(/^0+/u, "");
  if (digits.length > 15) {
    throw new TypeError("BRAID_BIND_DECIMAL_EXACTNESS: Tedious converts Decimal/Numeric parameters through JavaScript Number; strings over 15 significant digits are rejected.");
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError("BRAID_BIND_DECIMAL_EXACTNESS: Decimal/Numeric strings must fit a finite JavaScript Number.");
  }
  return numeric;
}

function assertDirectConnection(connection: TediousConnectionLike): void {
  const candidate = connection as unknown as { readonly release?: unknown; readonly getConnection?: unknown };
  if (
    !connection
    || typeof connection !== "object"
    || typeof connection.execSql !== "function"
    || typeof connection.beginTransaction !== "function"
    || typeof connection.commitTransaction !== "function"
    || typeof connection.rollbackTransaction !== "function"
    || typeof connection.saveTransaction !== "function"
    || typeof candidate.release === "function"
    || typeof candidate.getConnection === "function"
  ) {
    throw new TypeError("SQLBraid SQL Server direct adapter requires a physical Tedious Connection, not a pool.");
  }
}

function asError(error: unknown): unknown {
  return error === undefined || error === null ? undefined : error instanceof Error ? error : new Error(String(error));
}

interface ResultSetState {
  readonly columns: readonly TediousColumnMetadataLike[];
  readonly rows: Record<string, unknown>[];
}

interface CollectedResult {
  readonly resultSets: readonly ResultSetState[];
  readonly affectedRows?: number;
  readonly statementCount: number;
  readonly output: Readonly<Record<string, unknown>>;
  readonly outputSeen: boolean;
}

function metadataColumns(columns: unknown): readonly TediousColumnMetadataLike[] {
  if (Array.isArray(columns)) return columns.map((value) => (value && typeof value === "object" ? value : {})) as TediousColumnMetadataLike[];
  if (columns && typeof columns === "object") {
    return Object.entries(columns).map(([name, value]) => {
      const metadata = value && typeof value === "object" ? value as TediousColumnMetadataLike : {};
      return { ...metadata, colName: metadata.colName ?? metadata.name ?? name };
    });
  }
  return [];
}

function columnName(metadata: TediousColumnMetadataLike, index: number): string {
  return metadata.colName ?? metadata.name ?? `column${index + 1}`;
}

function columnType(metadata: TediousColumnMetadataLike): string | undefined {
  return typeof metadata.type === "string" ? metadata.type : metadata.type?.name;
}

function assertUniqueColumns(columns: readonly TediousColumnMetadataLike[]): void {
  const names = new Set<string>();
  for (const [index, metadata] of columns.entries()) {
    const name = metadata.colName ?? metadata.name;
    if (!name) continue;
    if (names.has(name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate SQL Server result label ${name} at column ${index}.`);
    names.add(name);
  }
}

function cellValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("value" in value)) return value;
  return (value as TediousColumnLike).value;
}

function mapRow(value: unknown, columns: readonly TediousColumnMetadataLike[], policy: TypePolicy): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const metadata = columns[index] ?? {};
      const type = columnType(metadata);
      const entry = cellValue(value[index]);
      row[columnName(metadata, index)] = type ? policy.decode(type, entry) : entry;
    }
    return row;
  }
  if (value && typeof value === "object") {
    for (const [key, raw] of Object.entries(value)) {
      if (Array.isArray(raw)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate SQL Server result label ${key}.`);
      const index = columns.findIndex((metadata, candidateIndex) => columnName(metadata, candidateIndex) === key);
      const metadata = index < 0 ? undefined : columns[index];
      const type = metadata === undefined ? undefined : columnType(metadata);
      const entry = cellValue(raw);
      row[key] = type ? policy.decode(type, entry) : entry;
    }
    return row;
  }
  return { value };
}

function addParameter(request: TediousRequestLike, index: number, value: unknown, suppliedHint: ParameterTypeHint | undefined, policy: TypePolicy): void {
  const wrapped = isBoundParameter(value) ? value : undefined;
  const actualValue = wrapped === undefined ? value : wrapped.value;
  const actualHint = suppliedHint ?? (wrapped === undefined ? undefined : wrapped.hint);
  if (actualValue === undefined) throw new TypeError("BRAID_BIND_TYPE_REQUIRED: undefined is not a SQL Server parameter value.");
  const inferred = actualHint === undefined ? inferType(actualValue) : undefined;
  const type = actualHint === undefined ? inferred!.type : typeForHint(actualHint);
  const input = actualHint === undefined ? inferred!.value : actualValue;
  let encoded = policy.encode(type, input);
  if (type === "decimal" || type === "numeric") encoded = decimalInput(encoded);
  if ((type === "varbinary" || type === "binary") && encoded instanceof Uint8Array && !Buffer.isBuffer(encoded)) encoded = Buffer.from(encoded);
  const options: { length?: number; precision?: number; scale?: number } = {};
  if (actualHint?.length !== undefined) options.length = actualHint.length === "max" ? Infinity : actualHint.length;
  if (actualHint?.precision !== undefined) options.precision = actualHint.precision;
  if (actualHint?.scale !== undefined) options.scale = actualHint.scale;
  const tediousType = TYPES[typeNames[type] as keyof typeof TYPES];
  if (!tediousType) throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: Tedious does not expose SQL Server type ${type}.`);
  request.addParameter(`p${index}`, tediousType, encoded, Object.keys(options).length === 0 ? undefined : options);
}

function collect(connection: TediousConnectionLike, rendered: RenderedQuery, policy: TypePolicy): Promise<CollectedResult> {
  return new Promise<CollectedResult>((resolve, reject) => {
    let request: TediousRequestLike | undefined;
    let callbackError: unknown;
    let eventError: unknown;
    let completed = false;
    let settled = false;
    let started = false;
    let cancellationRequested = false;
    let current: ResultSetState | undefined;
    const resultSets: ResultSetState[] = [];
    const output: Record<string, unknown> = {};
    let outputSeen = false;
    const doneRowCounts: number[] = [];
    const doneInProcRowCounts: number[] = [];
    let callbackRowCount: number | undefined;
    let doneCount = 0;
    let doneInProcCount = 0;
    const fail = (error: unknown): void => {
      if (settled) return;
      eventError = eventError ?? error;
      if (!started) {
        settled = true;
        reject(asError(eventError) ?? new Error("SQL Server request failed."));
        return;
      }
      if (!cancellationRequested) {
        cancellationRequested = true;
        try { request?.cancel?.(); } catch (cancelError) {
          eventError = new AggregateError([eventError, cancelError], "Failed to cancel SQL Server request.", { cause: eventError });
        }
      }
      finish();
    };
    const finish = (): void => {
      if (!completed || settled) return;
      settled = true;
      const error = asError(eventError ?? callbackError);
      if (error !== undefined) { reject(error); return; }
      // execSql wraps the batch in sp_executesql: doneInProc is emitted once
      // per statement and doneProc once for the wrapper itself.
      const rowCounts = doneInProcCount > 0 ? doneInProcRowCounts : doneRowCounts;
      const statementCount = doneInProcCount > 0 ? doneInProcCount : doneCount;
      const affected = rowCounts.length > 0
        ? rowCounts.filter((count) => Number.isFinite(count)).reduce((total, count) => total + count, 0)
        : callbackRowCount;
      resolve({
        resultSets,
        ...(affected === undefined ? {} : { affectedRows: affected }),
        statementCount,
        output,
        outputSeen,
      });
    };
    try {
      request = new Request(rendered.text, ((error: unknown, rowCount?: number) => {
        callbackError = error;
        if (typeof rowCount === "number") callbackRowCount = rowCount;
        finish();
      })) as unknown as TediousRequestLike;
      request.on("columnMetadata", (columns: unknown) => {
        try {
          const metadata = metadataColumns(columns);
          assertUniqueColumns(metadata);
          current = { columns: metadata, rows: [] };
          resultSets.push(current);
        } catch (error) {
          fail(error);
        }
      });
      request.on("row", (row: unknown) => {
        if (eventError) return;
        try {
          if (!current) {
            current = { columns: [], rows: [] };
            resultSets.push(current);
          }
          current.rows.push(mapRow(row, current.columns, policy));
        } catch (error) {
          fail(error);
        }
      });
      const done = (rowCount?: number): void => {
        doneCount += 1;
        if (typeof rowCount === "number") doneRowCounts.push(rowCount);
      };
      request.on("done", done);
      request.on("doneInProc", (rowCount?: number) => {
        doneInProcCount += 1;
        if (typeof rowCount === "number") doneInProcRowCounts.push(rowCount);
      });
      // doneProc is the completion notification for the sp_executesql wrapper.
      request.on("returnValue", (name: unknown, value: unknown) => {
        outputSeen = true;
        if (typeof name === "string") output[name] = value;
      });
      request.on("error", (error: unknown) => { fail(error); });
      request.on("requestCompleted", () => { completed = true; finish(); });
      const hints = rendered.parameterHints ?? [];
      for (let index = 0; index < rendered.values.length; index += 1) addParameter(request, index + 1, rendered.values[index], hints[index], policy);
      started = true;
      connection.execSql(request);
    } catch (error) {
      started = false;
      fail(error);
    }
  });
}

function control(connection: TediousConnectionLike, method: "beginTransaction" | "commitTransaction" | "rollbackTransaction" | "saveTransaction", name?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const callback = (error?: unknown): void => {
        const normalized = asError(error);
        if (normalized === undefined) resolve();
        else reject(normalized);
      };
      if (method === "saveTransaction") connection.saveTransaction(callback, name);
      else if (method === "beginTransaction") connection.beginTransaction(callback, name, ISOLATION_LEVEL.NO_CHANGE);
      else connection[method](callback);
    } catch (error) {
      reject(error);
    }
  });
}

function rollbackTo(connection: TediousConnectionLike, name: string, policy: TypePolicy): Promise<void> {
  const rendered = { text: `ROLLBACK TRANSACTION [${name.replaceAll("]", "]]")}]`, values: [], resultKind: "command" as const };
  return collect(connection, rendered, policy).then(() => undefined);
}

function rowResult(result: CollectedResult): QueryExecutionResult<Record<string, unknown>> {
  if (result.resultSets.length > 1) throw new Error("BRAID_RESULT_SETS_UNSUPPORTED: SQL Server returned multiple result sets; use database.call().");
  if (result.resultSets.length === 1 && result.statementCount > 1) {
    throw new Error("BRAID_RESULT_SETS_UNSUPPORTED: SQL Server returned rows and additional statement results; use database.call().");
  }
  if (result.resultSets.length === 1) {
    return { kind: "rows", rows: result.resultSets[0].rows, rowCount: result.resultSets[0].rows.length };
  }
  return { kind: "command", rows: [], rowCount: result.affectedRows, command: { affectedRows: result.affectedRows } };
}

const DEFAULT_MAX_BUFFERED_ROWS = 32;

function streamRows(connection: TediousConnectionLike, rendered: RenderedQuery, policy: TypePolicy, maxBufferedRows: number, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const max = Number.isSafeInteger(maxBufferedRows) && maxBufferedRows > 0 ? maxBufferedRows : DEFAULT_MAX_BUFFERED_ROWS;
  return (async function* (): AsyncGenerator<Record<string, unknown>> {
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<() => void> = [];
    let request: TediousRequestLike | undefined;
    let done = false;
    let failure: unknown;
    let paused = false;
    let cancellationRequested = false;
    let completion!: Promise<void>;
    const wake = (): void => { for (const waiter of waiters.splice(0)) waiter(); };
    const waitForData = (): Promise<void> => new Promise((resolve) => waiters.push(resolve));
    const cancel = (): void => {
      if (done || cancellationRequested) return;
      cancellationRequested = true;
      failure = failure ?? signal?.reason ?? new Error("SQL Server stream aborted.");
      try {
        if (request?.cancel) request.cancel();
        else if (request) connection.cancel?.();
        if (paused) { request?.resume?.(); paused = false; }
      } catch (error) {
        failure = new AggregateError([failure, error], "Failed to cancel SQL Server stream.", { cause: failure });
      }
      wake();
    };
    const onAbort = (): void => {
      failure = failure ?? signal?.reason ?? new Error("SQL Server stream aborted.");
      cancel();
      wake();
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", onAbort, { once: true });
    completion = new Promise<void>((resolve, reject) => {
      if (failure) {
        done = true;
        reject(failure);
        return;
      }
      try {
        request = new Request(rendered.text, ((error: unknown) => {
          if (error !== undefined && error !== null) {
            failure = failure ?? asError(error);
            cancel();
          }
        })) as unknown as TediousRequestLike;
        let resultSetCount = 0;
        let doneCount = 0;
        let doneInProcCount = 0;
        let columns: readonly TediousColumnMetadataLike[] = [];
        request.on("done", () => { doneCount += 1; });
        request.on("doneInProc", () => { doneInProcCount += 1; });
        request.on("columnMetadata", (metadata: unknown) => {
          try {
            if (resultSetCount > 0) throw new Error("BRAID_RESULT_SETS_UNSUPPORTED: SQL Server stream returned multiple result sets.");
            resultSetCount += 1;
            columns = metadataColumns(metadata);
            assertUniqueColumns(columns);
          }
          catch (error) { failure = failure ?? error; cancel(); }
        });
        request.on("row", (row: unknown) => {
          if (failure) return;
          try {
            queue.push(mapRow(row, columns, policy));
            if (queue.length >= max && !paused) { request?.pause?.(); paused = true; }
            wake();
          } catch (error) {
            failure = failure ?? error;
            cancel();
          }
        });
        request.on("error", (error: unknown) => {
          failure = failure ?? asError(error);
          cancel();
        });
        request.on("returnValue", () => {
          failure = failure ?? new Error("BRAID_CALL_OUT_UNSUPPORTED: SQL Server output parameters are not implemented.");
          cancel();
        });
        request.on("requestCompleted", () => {
          done = true;
          if (!failure && resultSetCount === 0) failure = new Error("BRAID_STREAM_UNSUPPORTED: SQL Server request did not return a result set.");
          const statementCount = doneInProcCount > 0 ? doneInProcCount : doneCount;
          if (!failure && resultSetCount === 1 && statementCount > 1) {
            failure = new Error("BRAID_RESULT_SETS_UNSUPPORTED: SQL Server stream returned rows and additional statement results.");
          }
          wake();
          if (failure) reject(failure);
          else resolve();
        });
        const hints = rendered.parameterHints ?? [];
        for (let index = 0; index < rendered.values.length; index += 1) addParameter(request, index + 1, rendered.values[index], hints[index], policy);
        request.pause?.();
        paused = true;
        connection.execSql(request);
        request.resume?.();
        paused = false;
      } catch (error) {
        failure = error;
        done = true;
        wake();
        reject(error);
      }
    });
    // Completion can fail while the consumer is processing a previously yielded row.
    // Keep the rejection observed; finally still drains it before releasing the lease.
    void completion.catch(() => undefined);
    try {
      while (true) {
        while (queue.length === 0 && !done && !failure) await waitForData();
        if (failure) throw failure;
        if (queue.length > 0) {
          const row = queue.shift()!;
          if (paused && queue.length <= Math.floor(max / 2) && !failure && !done) { request?.resume?.(); paused = false; }
          yield row;
          continue;
        }
        if (done) break;
        await waitForData();
      }
      await completion;
    } finally {
      if (!done) cancel();
      signal?.removeEventListener("abort", onAbort);
      try { await completion; } catch (error) { if (!failure) failure = error; }
    }
  })();
}

function makeTediousExecutor(connection: TediousConnectionLike, options: TediousExecutorOptions = {}): QueryExecutor {
  const policy = options.typePolicy ?? defaultTypePolicy;
  const maxBufferedRows = options.maxBufferedRows ?? DEFAULT_MAX_BUFFERED_ROWS;
  return {
    ownershipKey: connection,
    async query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>> {
      const result = await collect(connection, rendered, policy);
      if (result.outputSeen) throw new Error("BRAID_CALL_OUT_UNSUPPORTED: SQL Server output parameters are not implemented.");
      return rowResult(result) as QueryExecutionResult<Row>;
    },
    stream<Row>(rendered: RenderedQuery, signal?: AbortSignal): AsyncIterable<Row> {
      return streamRows(connection, rendered, policy, maxBufferedRows, signal) as AsyncIterable<Row>;
    },
    async call<Row>(rendered: RenderedQuery): Promise<RoutineCallResult<Row>> {
      const result = await collect(connection, rendered, policy);
      if (result.outputSeen) throw new Error("BRAID_CALL_OUT_UNSUPPORTED: SQL Server output parameters are not implemented.");
      return {
        output: {},
        resultSets: result.resultSets.map((set) => ({ rows: set.rows as readonly Row[] })),
      };
    },
    begin: () => control(connection, "beginTransaction"),
    commit: () => control(connection, "commitTransaction"),
    rollback: () => control(connection, "rollbackTransaction"),
    savepoint: (name) => control(connection, "saveTransaction", name),
    rollbackTo: (name) => rollbackTo(connection, name, policy),
    releaseSavepoint: async () => undefined,
  };
}

export function createTediousExecutor(connection: TediousConnectionLike, options: TediousExecutorOptions = {}): QueryExecutor {
  assertDirectConnection(connection);
  return makeTediousExecutor(connection, options);
}

export function createTediousDatabase(connection: TediousConnectionLike, options: TediousDatabaseOptions = {}) {
  const { typePolicy, maxBufferedRows, ...databaseOptions } = options;
  return createDatabase(createTediousExecutor(connection, { typePolicy, maxBufferedRows }), databaseOptions);
}

export function createTediousPoolProvider(pool: TediousPoolLike, options: TediousExecutorOptions = {}): ConnectionProvider {
  const acquireConnection = !pool ? undefined
    : typeof pool.acquire === "function" ? pool.acquire.bind(pool)
      : typeof pool.connect === "function" ? pool.connect.bind(pool)
        : typeof pool.getConnection === "function" ? pool.getConnection.bind(pool)
          : undefined;
  if (!acquireConnection) throw new TypeError("SQLBraid SQL Server pool provider requires acquire(), connect(), or getConnection().");
  return {
    async acquire(): Promise<ConnectionLease> {
      const connection = await acquireConnection();
      if (!connection || typeof connection.release !== "function") throw new TypeError("SQL Server pool returned a connection without explicit release ownership.");
      const executor = makeTediousExecutor(connection, options);
      let released = false;
      return {
        ...executor,
        async release(releaseOptions = {}): Promise<void> {
          if (released) return;
          released = true;
          if (releaseOptions.discard === true) {
            if (typeof connection.destroy === "function") await connection.destroy();
            else if (typeof connection.close === "function") await connection.close();
            else await connection.release();
          } else {
            await connection.release();
          }
        },
      };
    },
  };
}

export function createTediousPoolDatabase(pool: TediousPoolLike, options: TediousDatabaseOptions = {}) {
  const { typePolicy, maxBufferedRows, ...databaseOptions } = options;
  return createPooledDatabase(createTediousPoolProvider(pool, { typePolicy, maxBufferedRows }), databaseOptions);
}
