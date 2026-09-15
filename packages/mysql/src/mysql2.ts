import { Buffer } from "node:buffer";
import type {
  CommandResult,
  ConnectionLease,
  ConnectionProvider,
  DatabaseOptions,
  DriverRoutineResult,
  DriverEnvironment,
  ExecutionOptions,
  BulkBindingDescription,
  BulkExecutionResult,
  QueryExecutor,
  QueryExecutionResult,
  RenderedBulk,
  RenderedStatement,
  TypePolicy,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
  TransactionIsolation,
  TransactionOptions,
} from "@sqlbraid/core";
import {
  AdapterError,
  createBulkBindingDescription,
  createRenderedStatement,
  createStatementBindingDescription,
  normalizeExactInteger,
  ResultExactnessError,
  safeDatabaseCount,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { createDatabase, createPooledDatabase, DatabaseResultKindError } from "@sqlbraid/runtime";
import {
  typePolicyForProfile,
  type Mysql2JsonProfile,
  type Mysql2ProfileOptions,
  type Mysql2RepresentationProfile,
  type Mysql2TemporalProfile,
} from "./type-policy.js";

export type {
  Mysql2ConnectionOptions,
  Mysql2JsonProfile,
  Mysql2ProfileOptions,
  Mysql2RepresentationProfile,
  Mysql2TemporalProfile,
} from "./type-policy.js";
export {
  MYSQL2_DATE_TEXT,
  MYSQL2_JSON_TEXT,
  MYSQL2_LOSSLESS_TEXT,
  MYSQL2_NATIVE,
  representationProfiles,
  typePolicyForProfile,
} from "./type-policy.js";

export interface Mysql2FieldLike {
  readonly name?: string;
  readonly type?: string | number;
}
export type Mysql2FieldPayload = readonly Mysql2FieldLike[] | readonly (readonly Mysql2FieldLike[])[];

export type Mysql2ResultHeader = Omit<CommandResult, "affectedRows" | "insertId"> & {
  readonly affectedRows?: unknown;
  readonly insertId?: unknown;
  readonly warningStatus?: unknown;
};

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
  readonly stream?: {
    readonly destroyed?: boolean;
    destroy(error?: Error): void;
  };
}

export interface Mysql2PreparedStatementLike {
  execute(values?: Mysql2Parameter[]): Promise<readonly [unknown, Mysql2FieldPayload | undefined]>;
  close(): Promise<void>;
}

export interface Mysql2ConnectionLike {
  execute(sql: string, values?: Mysql2Parameter[]): Promise<readonly [unknown, Mysql2FieldPayload | undefined]>;
  prepare?(sql: string): Promise<Mysql2PreparedStatementLike>;
  unprepare?(sql: string): void | Promise<void>;
  query?(sql: string): Promise<readonly [unknown, Mysql2FieldPayload | undefined]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  getConnection?: never;
}

function unsupported(
  feature: string,
  code: `BRAID_${string}`,
  message: string,
  cause?: unknown,
): UnsupportedFeatureError {
  return new UnsupportedFeatureError(feature, code, message, cause === undefined ? undefined : { cause });
}

function invalidTransactionOptions(message: string): TypeError & { readonly code: string } {
  const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: ${message}`) as TypeError & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
  return error;
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
  /**
   * Optional evidence for connection options that mysql2 does not expose
   * consistently across PromiseConnection and PoolConnection wrappers.
   * Detected physical connection settings always take precedence.
   */
  readonly profile?: Mysql2ProfileOptions | Mysql2RepresentationProfile;
}

export type Mysql2DatabaseOptions = DatabaseOptions & Mysql2ExecutorOptions;

const mysqlTypes: Readonly<Record<number, string>> = {
  0: "DECIMAL",
  1: "TINYINT",
  2: "SMALLINT",
  3: "INT",
  4: "FLOAT",
  5: "DOUBLE",
  7: "TIMESTAMP",
  8: "BIGINT",
  9: "MEDIUMINT",
  10: "DATE",
  11: "TIME",
  12: "DATETIME",
  13: "YEAR",
  14: "DATE",
  15: "VARCHAR",
  16: "BIT",
  245: "JSON",
  246: "DECIMAL",
  247: "ENUM",
  248: "SET",
  249: "BLOB",
  250: "BLOB",
  251: "BLOB",
  252: "BLOB",
  253: "VARCHAR",
  254: "VARCHAR",
  255: "GEOMETRY",
};

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

function destroyMysqlConnection(raw: Mysql2RawConnectionLike, error?: Error): void {
  // mysql2 3.x destroy() aliases graceful close(); force the raw socket to
  // reject an unknown in-flight command before the pool can reuse it.
  raw.destroy();
  if (raw.stream?.destroyed !== true) raw.stream?.destroy(error);
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

function isCleanupFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "BRAID_RESOURCE_CLEANUP";
}

async function withMysqlCancellation<T>(
  connection: Mysql2ConnectionLike,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return operation();
  const raw = rawConnection(connection);
  if (raw === undefined) {
    throw unsupported(
      "statement.cancel",
      "BRAID_CANCEL_UNSUPPORTED",
      "MySQL cancellation requires the physical connection's documented destroy() method.",
    );
  }
  let aborted = false;
  let destroyError: unknown;
  const abort = (): void => {
    aborted = true;
    try {
      const reason = signal.reason;
      destroyMysqlConnection(
        raw,
        reason instanceof Error ? reason : new Error("MySQL statement aborted.", { cause: reason }),
      );
    } catch (error) {
      destroyError = error;
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    try {
      const result = await operation();
      if (!aborted) {
        signal.throwIfAborted();
        return result;
      }
      if (destroyError !== undefined) {
        throw cleanupError("MySQL physical connection destruction after statement abort failed.", destroyError);
      }
      throw cleanupError("MySQL physical connection was destroyed after statement abort.", signal.reason);
    } catch (error) {
      if (!aborted) throw error;
      if (isCleanupFailure(error)) throw error;
      if (destroyError !== undefined) {
        throw cleanupAggregate([error, cleanupError("MySQL physical connection destruction after statement abort failed.", destroyError)], "MySQL statement cancellation cleanup failed.", error);
      }
      throw cleanupError("MySQL physical connection was destroyed after statement abort.", signal.reason);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function plainRow(value: unknown, fields: readonly Mysql2FieldLike[], policy: TypePolicy): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BRAID_RESULT_COLUMNS: mysql2 must return object rows; rowsAsArray=true is unsupported.");
  }
  const row: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.name === key);
    const databaseType = mysqlDatabaseType(field);
    assertMysqlNumericValue(databaseType, entry);
    Object.defineProperty(row, key, {
      value: databaseType ? policy.decode(databaseType, entry) : entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return row;
}

function mysqlDatabaseType(field: Mysql2FieldLike | undefined): string | undefined {
  if (typeof field?.type === "number") return mysqlTypes[field.type];
  if (typeof field?.type !== "string") return undefined;
  const type = field.type.toUpperCase();
  if (type === "TINY") return "TINYINT";
  if (type === "SHORT") return "SMALLINT";
  if (type === "LONGLONG") return "BIGINT";
  if (type === "NEWDECIMAL") return "DECIMAL";
  if (type === "VAR_STRING" || type === "STRING") return "VARCHAR";
  if (type === "LONG") return "INT";
  if (type === "INT24") return "MEDIUMINT";
  return type;
}

function assertMysqlNumericValue(databaseType: string | undefined, value: unknown): void {
  if (value === null || value === undefined || databaseType === undefined) return;
  const type = databaseType.toUpperCase();
  if (type === "DECIMAL" || type === "NEWDECIMAL") {
    if (typeof value !== "string") {
      throw new ResultExactnessError("mysql2 DECIMAL results must remain strings; configure an exact numeric profile.");
    }
    return;
  }
  if (type === "BIGINT" || type === "LONGLONG" || type === "INT" || type === "TINYINT" || type === "SMALLINT" || type === "MEDIUMINT") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new ResultExactnessError(`mysql2 ${type} result was an unsafe JavaScript number.`);
    }
    if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
      throw new ResultExactnessError(`mysql2 ${type} result has an unsupported representation.`);
    }
    return;
  }
  if (type === "FLOAT" || type === "DOUBLE") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ResultExactnessError(`mysql2 ${type} result is not a finite JavaScript number.`);
    }
  }
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
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "MySQL adapter does not support explicit bind type hints.",
    );
  }
}

function assertMysql2Value(value: unknown, location: string): void {
  if (value === undefined) throw new AdapterError("BRAID_BIND_VALUE_UNSUPPORTED", `${location} cannot be undefined.`);
  if (typeof value === "function") throw new AdapterError("BRAID_BIND_VALUE_UNSUPPORTED", `${location} cannot be a function.`);
  if (value instanceof Date && !Number.isFinite(value.getTime())) {
    throw new AdapterError("BRAID_BIND_VALUE_UNSUPPORTED", `${location} must be a valid Date.`);
  }
  if (value !== null && typeof value === "object") {
    const candidate = value as { readonly toJSON?: unknown };
    const isBuffer = Buffer.isBuffer(value);
    const isJsonValue = !(value instanceof Date)
      && !isBuffer
      && (
        Array.isArray(value)
        || value.constructor === Object
        || typeof candidate.toJSON === "function"
      );
    if (isJsonValue) {
      try {
        if (JSON.stringify(value) === undefined) throw new TypeError("JSON encoding produced undefined.");
      } catch (error) {
        throw new AdapterError("BRAID_BIND_VALUE_UNSUPPORTED", `${location} cannot be JSON encoded.`, { cause: error });
      }
    }
  }
}

function assertMysql2Values(values: readonly unknown[], prefix: string): void {
  for (let index = 0; index < values.length; index += 1) {
    assertMysql2Value(values[index], `${prefix} parameter ${index + 1}`);
  }
}

function assertMysql2BulkValues(bulk: RenderedBulk): void {
  for (let rowIndex = 0; rowIndex < bulk.parameterSets.length; rowIndex += 1) {
    assertMysql2Values(bulk.parameterSets[rowIndex]!, `MySQL bulk row ${rowIndex + 1}`);
  }
}

function assertNoRoutineOutputsForQuery(rendered: RenderedStatement): void {
  if (rendered.resultKind !== "call" && rendered.parameters.some((parameter) => parameter.direction !== undefined && parameter.direction !== "in")) {
    throw unsupported(
      "routine.out",
      "BRAID_CALL_OUT_UNSUPPORTED",
      "OUT/INOUT parameters are only valid for routine calls.",
    );
  }
}

function normalizeCommandHeader(value: object): CommandResult {
  const header: Record<string, unknown> = { ...value };
  if (header.affectedRows !== undefined) header.affectedRows = safeDatabaseCount(header.affectedRows);
  if (header.insertId !== undefined) header.insertId = normalizeExactInteger(header.insertId);
  if (header.warningStatus !== undefined) header.warningStatus = safeDatabaseCount(header.warningStatus);
  return header as CommandResult;
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();

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
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    if (statement.resultKind !== "command") throw new Error("BRAID_BULK_SHAPE: MySQL bulk requires command queries.");
    if (statement.parameters.some((parameter) => (parameter.direction ?? "in") !== "in")) {
      throw unsupported("routine.out", "BRAID_BULK_SHAPE", "MySQL bulk does not support OUT or INOUT parameters.");
    }
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length) throw new Error("BRAID_BULK_SHAPE: MySQL bulk parameter cardinality changed.");
    }
    assertMysql2BulkValues(bulk);
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "mysql2",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "reuse", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "mysql",
  requestedReuse: "auto",
});

function isRepresentationProfile(value: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined): value is Mysql2RepresentationProfile {
  return Boolean(value && "json" in value && "temporal" in value && "typePolicy" in value);
}

function suppliedProfileOptions(supplied: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined): Mysql2ProfileOptions | undefined {
  return isRepresentationProfile(supplied) ? supplied.connectionOptions : supplied;
}

function mysql2Profile(
  connection: Mysql2ConnectionLike,
  supplied: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined,
): Mysql2ProfileOptions {
  const candidate = connection as unknown as {
    readonly config?: unknown;
    readonly connection?: { readonly config?: unknown };
  };
  const suppliedOptions = suppliedProfileOptions(supplied);
  const sources = [candidate.config, candidate.connection?.config];
  const candidates = sources.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
  const detected = candidates.find((value) => [
    "supportBigNumbers",
    "bigNumberStrings",
    "decimalNumbers",
    "rowsAsArray",
    "jsonStrings",
    "dateStrings",
    "typeCast",
  ].some((key) => key in value)) ?? candidates[0];
  if (!detected) return suppliedOptions ?? {};
  const value = (key: string): boolean | undefined => typeof detected[key] === "boolean" ? detected[key] as boolean : undefined;
  return {
    ...suppliedOptions,
    supportBigNumbers: value("supportBigNumbers") ?? suppliedOptions?.supportBigNumbers,
    bigNumberStrings: value("bigNumberStrings") ?? suppliedOptions?.bigNumberStrings,
    decimalNumbers: value("decimalNumbers") ?? suppliedOptions?.decimalNumbers,
    rowsAsArray: value("rowsAsArray") ?? suppliedOptions?.rowsAsArray,
    jsonStrings: value("jsonStrings") ?? suppliedOptions?.jsonStrings,
    dateStrings: value("dateStrings") ?? suppliedOptions?.dateStrings,
    typeCast: typeof detected.typeCast === "function"
      ? "custom"
      : detected.typeCast === false
        ? "custom"
        : detected.typeCast === true ? "default" : suppliedOptions?.typeCast,
  };
}

function mysql2RepresentationProfile(
  connection: Mysql2ConnectionLike,
  supplied: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined,
): Mysql2RepresentationProfile {
  const profile = mysql2Profile(connection, supplied);
  const json: Mysql2JsonProfile = profile.jsonStrings === undefined
    ? isRepresentationProfile(supplied) ? supplied.json : "text"
    : profile.jsonStrings ? "text" : "native";
  const temporal: Mysql2TemporalProfile = profile.dateStrings === undefined
    ? isRepresentationProfile(supplied) ? supplied.temporal : "text"
    : profile.dateStrings ? "text" : "native";
  return {
    id: `${json === "text" && temporal === "text" ? "mysql2-lossless-text" : json === "native" && temporal === "native" ? "mysql2-native" : json === "text" ? "mysql2-json-text" : "mysql2-date-text"}`,
    json,
    temporal,
    typePolicy: typePolicyForProfile({ json, temporal }),
  };
}

function mysql2Environment(
  connection: Mysql2ConnectionLike,
  supplied: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined,
  policy: TypePolicy,
): DriverEnvironment {
  const profile = mysql2Profile(connection, undefined);
  const representationProfile = mysql2RepresentationProfile(connection, supplied);
  const policyMatchesProfile = policy === representationProfile.typePolicy;
  const exactNumeric = profile.supportBigNumbers === true
    && profile.bigNumberStrings === true
    && profile.decimalNumbers === false
    && profile.rowsAsArray === false
    && profile.typeCast === "default";
  const rowObjects = profile.rowsAsArray === false && profile.typeCast === "default";
  const jsonText = profile.jsonStrings === true && rowObjects;
  const jsonNative = profile.jsonStrings === false && rowObjects;
  const temporalText = profile.dateStrings === true && rowObjects;
  const temporalNative = profile.dateStrings === false && rowObjects;
  const profileDimensionsKnown = profile.jsonStrings !== undefined && profile.dateStrings !== undefined;
  const profileName = exactNumeric && rowObjects && profileDimensionsKnown ? representationProfile.id : "mysql2-custom-profile";
  const capabilities: DriverEnvironment["capabilities"] = {
    "session.pinned": { status: "guaranteed" },
    "transaction": { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": { status: "guaranteed" },
    "transaction.isolation.read-uncommitted": { status: "guaranteed" },
    "transaction.isolation.read-committed": { status: "guaranteed" },
    "transaction.isolation.repeatable-read": { status: "guaranteed" },
    "transaction.isolation.serializable": { status: "guaranteed" },
    "statement.prepare": { status: "guaranteed" },
    "statement.cancel": { status: "guarded", conditionCode: "mysql2.physical-connection-destroy" },
    "statement.stream": { status: "guaranteed" },
    "statement.bulk": { status: "guaranteed" },
    "routine.call": { status: "guaranteed" },
    "routine.out": { status: "unsupported" },
    "routine.inout": { status: "unsupported" },
    "routine.return-value": { status: "unsupported" },
    "routine.result-sets": { status: "guaranteed" },
    "routine.out-cursor": { status: "unsupported" },
    ...(policyMatchesProfile
      ? {
      "sql.native-transparency": { status: "guaranteed" as const },
      "numeric.exact-integer": {
        status: exactNumeric ? "guaranteed" as const : "guarded" as const,
        canonical: "string" as const,
        rawRepresentations: ["number", "string"],
        ...(exactNumeric ? {} : { conditionCode: "mysql2.exact-numeric-profile" }),
      },
      "numeric.exact-decimal": {
        status: exactNumeric ? "guaranteed" as const : "guarded" as const,
        canonical: "string" as const,
        rawRepresentations: ["string"],
        ...(exactNumeric ? {} : { conditionCode: "mysql2.exact-numeric-profile" }),
      },
      "numeric.approximate-float": {
        status: rowObjects ? "guaranteed" as const : "guarded" as const,
        canonical: "number" as const,
        rawRepresentations: ["number"],
      },
      "data.json-parsed": {
        status: jsonNative ? "guaranteed" as const : profile.jsonStrings === true ? "unsupported" as const : "guarded" as const,
        rawRepresentations: ["object", "array", "string", "number", "boolean", "null"],
        ...(jsonNative ? {} : { conditionCode: "mysql2.json-strings" }),
      },
      "data.json-lossless-text": {
        status: jsonText ? "guaranteed" as const : profile.jsonStrings === false ? "unsupported" as const : "guarded" as const,
        canonical: "string" as const,
        rawRepresentations: ["string"],
        ...(jsonText ? {} : { conditionCode: "mysql2.json-strings" }),
      },
      "data.temporal-lossless": {
        status: temporalText ? "guaranteed" as const : "guarded" as const,
        canonical: "string" as const,
        rawRepresentations: ["string"],
        ...(temporalText ? {} : { conditionCode: "mysql2.date-strings" }),
      },
      "data.temporal-native": {
        status: temporalNative ? "guaranteed" as const : temporalText ? "unsupported" as const : "guarded" as const,
        rawRepresentations: ["Date", "string"],
        ...(
          temporalText || profile.dateStrings === undefined
            ? { conditionCode: "mysql2.date-strings" }
            : {}
        ),
      },
      }
      : {}),
  };
  return Object.freeze<DriverEnvironment>({
    database: { product: "mysql" },
    driver: { id: "mysql2", profile: policyMatchesProfile ? profileName : "custom-type-policy" },
    typePolicy: { id: policy.id, hash: policy.hash },
    capabilities,
    probe: {
      statement: createRenderedStatement({
        segments: ["SELECT VERSION() AS version"],
        parameters: [],
        resultKind: "rows",
        dialectId: "mysql",
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
  if (rendered.parameters.some((parameter) => parameter.direction === "out")) {
    throw unsupported(
      "routine.out",
      "BRAID_CALL_OUT_UNSUPPORTED",
      "mysql2 does not expose a proven public discriminator for prepared CALL OUT carrier results.",
    );
  }
  if (rendered.parameters.some((parameter) => parameter.direction === "inout")) {
    throw unsupported(
      "routine.inout",
      "BRAID_CALL_OUT_UNSUPPORTED",
      "mysql2 does not expose a proven public discriminator for prepared CALL INOUT carrier results.",
    );
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

function isMultipleResultPayload(payload: unknown): boolean {
  return Array.isArray(payload) && payload.some(Array.isArray);
}

async function closePrepared(
  connection: Mysql2ConnectionLike,
  sql: string,
  failure: unknown,
): Promise<void> {
  // A poisoned connection is discarded as a whole and cannot accept COM_STMT_CLOSE.
  if (isCleanupFailure(failure)) return;
  try {
    // Closing the statement alone leaves mysql2's cached handle reusable.
    await connection.unprepare!(sql);
  } catch (closeError) {
    if (failure === undefined) throw cleanupError("MySQL prepared bulk cleanup failed.", closeError);
    throw cleanupAggregate([failure, closeError], "MySQL prepared bulk cleanup failed.", failure);
  }
}

function mysqlIsolationLevel(isolation: TransactionIsolation): string {
  switch (isolation) {
    case "read-uncommitted": return "READ UNCOMMITTED";
    case "read-committed": return "READ COMMITTED";
    case "repeatable-read": return "REPEATABLE READ";
    case "serializable": return "SERIALIZABLE";
    default: throw invalidTransactionOptions(`Unsupported MySQL transaction isolation level: ${String(isolation)}.`);
  }
}

async function beginMysqlTransaction(
  connection: Mysql2ConnectionLike,
  control: (sql: string) => Promise<void>,
  transactionOptions?: TransactionOptions,
): Promise<void> {
  if (
    transactionOptions !== undefined
    && (transactionOptions === null || typeof transactionOptions !== "object" || Array.isArray(transactionOptions))
  ) {
    throw invalidTransactionOptions("MySQL transaction options must be an object.");
  }
  if (transactionOptions !== undefined) {
    const unexpected = Object.keys(transactionOptions).find((key) => key !== "isolation" && key !== "readOnly");
    if (unexpected !== undefined) throw invalidTransactionOptions(`Unknown MySQL transaction option: ${unexpected}.`);
  }
  if (
    transactionOptions?.readOnly !== undefined
    && typeof transactionOptions.readOnly !== "boolean"
  ) {
    throw invalidTransactionOptions("MySQL transaction readOnly must be a boolean.");
  }
  if (transactionOptions?.isolation !== undefined) {
    await control(`SET TRANSACTION ISOLATION LEVEL ${mysqlIsolationLevel(transactionOptions.isolation)}`);
  }
  if (transactionOptions?.readOnly === true) {
    await control("START TRANSACTION READ ONLY");
  } else if (transactionOptions?.readOnly === false) {
    await control("START TRANSACTION READ WRITE");
  } else {
    await connection.beginTransaction();
  }
}

export function createMysql2Executor(connection: Mysql2ConnectionLike, options: Mysql2ExecutorOptions = {}): QueryExecutor {
  assertMysql2Connection(connection);
  const representationProfile = mysql2RepresentationProfile(connection, options.profile);
  const policy = options.typePolicy ?? (isRepresentationProfile(options.profile) ? options.profile.typePolicy : representationProfile.typePolicy);
  const highWaterMark = options.streamHighWaterMark ?? 16;
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) throw new RangeError("MySQL streamHighWaterMark must be a positive safe integer.");
  const control = async (sql: string): Promise<void> => { await (connection.query ?? connection.execute).call(connection, sql); };
  return {
    ownershipKey: connection,
    statementBinding: mysql2StatementBinding,
    environment: mysql2Environment(connection, options.profile, policy),
    async query<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      executionOptions?.signal?.throwIfAborted();
      assertParameterHintsUnsupported(rendered);
      assertNoRoutineOutputsForQuery(rendered);
      const prepared = materialize(rendered, binding);
      const [payload, rawFields] = await withMysqlCancellation(
        connection,
        executionOptions?.signal,
        () => connection.execute(prepared.text, prepared.values as unknown as Mysql2Parameter[]),
      );
      if (isMultipleResultPayload(payload)) {
        throw unsupported(
          "routine.result-sets",
          "BRAID_RESULT_SETS_UNSUPPORTED",
          "MySQL returned multiple result sets; use database.call().",
        );
      }
      const fields = resultSetFields(rawFields, 0);
      assertUniqueFields(fields);
      if (Array.isArray(payload)) {
        const rows = payload.map((row) => plainRow(row, fields ?? [], policy));
        return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
      }
      if (!payload || typeof payload !== "object") return { rows: [], rowCount: 0, kind: "command", command: {} };
      const header = normalizeCommandHeader(payload);
      return { rows: [], rowCount: header.affectedRows, kind: "command", command: header };
    },
    async bulk(
      bulk: RenderedBulk,
      binding: BulkBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<BulkExecutionResult> {
      executionOptions?.signal?.throwIfAborted();
      if (executionOptions?.signal !== undefined && rawConnection(connection) === undefined) {
        throw unsupported(
          "statement.cancel",
          "BRAID_CANCEL_UNSUPPORTED",
          "MySQL cancellation requires the physical connection's documented destroy() method.",
        );
      }
      const described = describedBulks.get(binding);
      if (described !== bulk) throw new TypeError("BRAID_BINDING_IDENTITY: MySQL bulk description belongs to another bulk or adapter.");
      if (binding.adapterId !== mysql2StatementBinding.id || binding.dialectId !== bulk.statement.dialectId) {
        throw new TypeError("BRAID_BINDING_IDENTITY: MySQL bulk description belongs to another adapter.");
      }
      if (binding.parameterizedSql === undefined) throw new Error("BRAID_BIND_TRANSPORT: MySQL bulk binding did not provide parameterized SQL.");
      if (typeof connection.prepare !== "function" || typeof connection.unprepare !== "function") {
        throw unsupported(
          "statement.bulk",
          "BRAID_BULK_UNSUPPORTED",
          "mysql2 bulk execution requires the documented prepare() and unprepare() methods.",
        );
      }
      const prepared = await withMysqlCancellation(
        connection,
        executionOptions?.signal,
        () => connection.prepare!(binding.parameterizedSql!),
      );
      let failure: unknown;
      let affectedRows = 0;
      let affectedKnown = true;
      try {
        for (let index = 0; index < binding.itemCount; index += 1) {
          const [payload] = await withMysqlCancellation(
            connection,
            executionOptions?.signal,
            () => prepared.execute(binding.valuesAt(index) as Mysql2Parameter[]),
          );
          if (Array.isArray(payload)) throw new Error("BRAID_BULK_RESULT_KIND: MySQL bulk command returned rows.");
          if (payload && typeof payload === "object" && (payload as Mysql2ResultHeader).affectedRows !== undefined) {
            affectedRows = safeDatabaseCount(affectedRows + safeDatabaseCount((payload as Mysql2ResultHeader).affectedRows));
          } else affectedKnown = false;
        }
      } catch (error) {
        failure = error;
      }
      await closePrepared(connection, binding.parameterizedSql, failure);
      if (failure !== undefined) throw failure;
      return {
        inputCount: binding.itemCount,
        ...(affectedKnown ? { affectedRows } : {}),
        executionMode: "prepared-loop",
      };
    },
    async *stream<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): AsyncGenerator<Row> {
      const signal = executionOptions?.signal;
      assertParameterHintsUnsupported(rendered);
      assertNoRoutineOutputsForQuery(rendered);
      signal?.throwIfAborted();
      const raw = rawConnection(connection);
      if (!raw) {
        if (signal !== undefined) {
          throw unsupported(
            "statement.cancel",
            "BRAID_CANCEL_UNSUPPORTED",
            "MySQL cancellation requires the physical connection's documented destroy() method.",
          );
        }
        throw unsupported(
          "statement.stream",
          "BRAID_STREAM_UNSUPPORTED",
          "mysql2 Promise Connection does not expose its raw streaming connection.",
        );
      }
      const prepared = materialize(rendered, binding);
      const command = raw.execute(prepared.text, prepared.values as Mysql2Parameter[]);
      const source = command.stream({ highWaterMark });
      let fields: readonly Mysql2FieldLike[] = [];
      let fieldsChanged = false;
      let fieldsSeen = 0;
      let pendingError: Error | undefined;
      (source.on ?? source.once).call(source, "fields", (value: unknown) => {
        fieldsSeen += 1;
        if (fieldsSeen === 1) {
          fields = Array.isArray(value) ? value : [];
          fieldsChanged = true;
        } else {
          pendingError ??= unsupported(
            "routine.result-sets",
            "BRAID_RESULT_SETS_UNSUPPORTED",
            "MySQL stream returned multiple result sets; use database.call().",
          );
        }
      });
      const iterator = source[Symbol.asyncIterator]();
      let exhausted = false;
      let aborted = false;
      let destroyError: unknown;
      let streamError: unknown;
      const abort = (): void => {
        aborted = true;
        try {
          const reason = signal?.reason;
          destroyMysqlConnection(
            raw,
            reason instanceof Error ? reason : new Error("MySQL stream aborted.", { cause: reason }),
          );
        } catch (error) {
          destroyError = error;
        }
        const reason: unknown = signal?.reason;
        try {
          source.destroy?.(reason instanceof Error ? reason : new Error("MySQL stream aborted.", { cause: reason }));
        } catch (error) {
          destroyError ??= error;
        }
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
            if (fields.length === 0) throw new DatabaseResultKindError("rows", "command");
            fieldsChanged = false;
          }
          if (next.done) {
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
              exhausted = true;
            } catch (error) {
              const cleanup = cleanupError("MySQL stream command did not drain to completion.", error);
              const originals = [streamError, pendingError].filter((candidate, index, values): candidate is unknown => candidate !== undefined && values.indexOf(candidate) === index);
              if (originals.length > 0) throw cleanupAggregate([...originals, cleanup], "MySQL stream cleanup failed.", originals[0]);
              throw cleanup;
            }
            if (streamError === undefined && pendingError !== undefined) throw pendingError;
          }
          if (aborted) {
            const cleanup = destroyError === undefined
              ? cleanupError("MySQL physical connection was destroyed after stream abort.", signal?.reason)
              : cleanupError("MySQL physical connection destruction after stream abort failed.", destroyError);
            if (streamError !== undefined) throw cleanupAggregate([streamError, cleanup], "MySQL stream abort cleanup failed.", streamError);
            throw cleanup;
          }
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      }
    },
    async call(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<DriverRoutineResult> {
      executionOptions?.signal?.throwIfAborted();
      assertRoutineOutputsUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const [payload, rawFields] = await withMysqlCancellation(
        connection,
        executionOptions?.signal,
        () => connection.execute(prepared.text, prepared.values as unknown as Mysql2Parameter[]),
      );
      if (!Array.isArray(payload)) return { output: payload && typeof payload === "object" ? Object.fromEntries(Object.entries(payload)) : {}, resultSets: [] };
      const sets = isMultipleResultPayload(payload) ? payload.filter((entry): entry is readonly unknown[] => Array.isArray(entry)) : [payload];
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
    begin: (transactionOptions) => beginMysqlTransaction(connection, control, transactionOptions),
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    savepoint: (name) => control(`SAVEPOINT ${name}`),
    rollbackTo: (name) => control(`ROLLBACK TO SAVEPOINT ${name}`),
    releaseSavepoint: (name) => control(`RELEASE SAVEPOINT ${name}`),
  };
}

export function createMysql2Database(connection: Mysql2ConnectionLike, options: Mysql2DatabaseOptions = {}) {
  const { typePolicy, streamHighWaterMark, profile, ...databaseOptions } = options;
  return createDatabase(createMysql2Executor(connection, { typePolicy, streamHighWaterMark, profile }), databaseOptions);
}

export function createMysql2PoolProvider(pool: Mysql2PoolLike, options: Mysql2ExecutorOptions = {}): ConnectionProvider {
  const representationProfile = mysql2RepresentationProfile({} as Mysql2ConnectionLike, options.profile);
  const policy = options.typePolicy ?? representationProfile.typePolicy;
  const environment = mysql2Environment({} as Mysql2ConnectionLike, options.profile, policy);
  return {
    statementBinding: mysql2StatementBinding,
    // Unconfigured pools select their policy only after observing a physical connection.
    environment: options.typePolicy === undefined && !isRepresentationProfile(options.profile)
      ? { ...environment, typePolicy: undefined }
      : environment,
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
  const { typePolicy, streamHighWaterMark, profile, ...databaseOptions } = options;
  return createPooledDatabase(createMysql2PoolProvider(pool, { typePolicy, streamHighWaterMark, profile }), databaseOptions);
}
