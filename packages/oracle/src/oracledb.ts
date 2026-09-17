import oracledb from "oracledb";
import {
  AdapterError,
  createBulkBindingDescription,
  createRenderedStatement,
  createStatementBindingDescription,
  ResultExactnessError,
  safeDatabaseCount,
  type BulkBindingDescription,
  type BulkExecutionResult,
  type ConnectionLease,
  type ConnectionProvider,
  type DatabaseOptions,
  type DriverRoutineResult,
  type DriverEnvironment,
  type ExecutionOptions,
  type ParameterTypeHint,
  type QueryExecutor,
  type QueryExecutionResult,
  type RenderedBulk,
  type RenderedStatement,
  type StatementBindingAdapter,
  type StatementBindingContext,
  type StatementBindingDescription,
  type TransactionOptions,
  type TypePolicy,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { assertSavepointName, createCleanupScope, defineResultProperty } from "@sqlbraid/core/driver";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { utf8ByteLength } from "@sqlbraid/template";
import {
  isOracleBinaryNumericType,
  isOracleExactNumericType,
  typePolicy as defaultTypePolicy,
} from "./type-policy.js";

export interface OracleMetaDataLike {
  readonly name?: string;
  readonly dbType?: unknown;
  readonly dbTypeName?: string;
  readonly type?: unknown;
}

export interface OracleResultSetLike {
  readonly metaData?: readonly OracleMetaDataLike[];
  getRow?(): Promise<unknown | null | undefined>;
  getRows?(numRows?: number): Promise<readonly unknown[]>;
  close(): Promise<void> | void;
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>;
}

interface OracleLobLike {
  getData(): Promise<unknown>;
  destroy(error?: Error): unknown;
  once(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  readonly destroyed?: boolean;
  readonly closed?: boolean;
}

export interface OracleExecuteResultLike {
  readonly rows?: readonly unknown[];
  readonly rowsAffected?: number;
  readonly metaData?: readonly OracleMetaDataLike[];
  readonly resultSet?: OracleResultSetLike;
  readonly outBinds?: unknown;
  readonly implicitResults?: readonly OracleResultSetLike[];
}

export interface OracleBindLike {
  readonly dir?: unknown;
  readonly val?: unknown;
  readonly type?: unknown;
  readonly maxSize?: number;
}

export interface OracleExecuteOptionsLike {
  readonly outFormat?: unknown;
  readonly fetchTypeHandler?: (metadata: OracleMetaDataLike) => { readonly type?: unknown; readonly converter?: (value: unknown) => unknown } | undefined;
  readonly resultSet?: boolean;
  readonly [key: string]: unknown;
}

export interface OracleConnectionLike {
  execute(sql: string, bindParams?: any, options?: any): Promise<unknown>;
  executeMany?(sql: string, binds: any, options?: any): Promise<unknown>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  readonly stmtCacheSize?: number;
  break?(): Promise<void> | void;
  close?(options?: { readonly drop?: boolean }): Promise<void> | void;
}

export interface OraclePoolConnectionLike extends OracleConnectionLike {
  close(options?: { readonly drop?: boolean }): Promise<void> | void;
}

export interface OraclePoolLike {
  getConnection(): Promise<OraclePoolConnectionLike>;
  readonly stmtCacheSize?: number;
}

export interface OracleDriverLike {
  readonly BIND_IN?: unknown;
  readonly BIND_OUT?: unknown;
  readonly BIND_INOUT?: unknown;
  readonly OUT_FORMAT_OBJECT?: unknown;
  readonly OUT_FORMAT_ARRAY?: unknown;
  readonly STRING?: unknown;
  readonly NUMBER?: unknown;
  readonly DATE?: unknown;
  readonly BUFFER?: unknown;
  readonly BINARY_FLOAT?: unknown;
  readonly BINARY_DOUBLE?: unknown;
  readonly DB_TYPE_VARCHAR?: unknown;
  readonly DB_TYPE_CHAR?: unknown;
  readonly DB_TYPE_NVARCHAR?: unknown;
  readonly DB_TYPE_NCHAR?: unknown;
  readonly DB_TYPE_NUMBER?: unknown;
  readonly DB_TYPE_BINARY_FLOAT?: unknown;
  readonly DB_TYPE_BINARY_DOUBLE?: unknown;
  readonly DB_TYPE_DATE?: unknown;
  readonly DB_TYPE_TIMESTAMP?: unknown;
  readonly DB_TYPE_TIMESTAMP_TZ?: unknown;
  readonly DB_TYPE_TIMESTAMP_LTZ?: unknown;
  readonly DB_TYPE_RAW?: unknown;
  readonly DB_TYPE_BLOB?: unknown;
  readonly DB_TYPE_CLOB?: unknown;
  readonly DB_TYPE_NCLOB?: unknown;
  readonly DB_TYPE_ROWID?: unknown;
  readonly DB_TYPE_UROWID?: unknown;
  readonly DB_TYPE_JSON?: unknown;
  readonly DB_TYPE_OBJECT?: unknown;
  readonly DB_TYPE_VECTOR?: unknown;
  readonly BLOB?: unknown;
  readonly NCLOB?: unknown;
  readonly CURSOR?: unknown;
  readonly [key: string]: unknown;
}

export interface OracleDatabaseOptions extends DatabaseOptions {
  readonly typePolicy?: TypePolicy;
  readonly driver?: OracleDriverLike;
  readonly executeOptions?: OracleExecuteOptionsLike;
  readonly streamFetchSize?: number;
}

const defaultDriver = oracledb as unknown as OracleDriverLike;
// node-oracledb's stable OUT_FORMAT_ARRAY constant; arrays preserve __proto__ labels.
const oracleOutFormatArray = 4001;

const oracleEnvironment = Object.freeze<DriverEnvironment>({
  database: { product: "oracle" },
  driver: { id: "node-oracledb", profile: "oracle-thin" },
  typePolicy: { id: defaultTypePolicy.id, hash: defaultTypePolicy.hash },
  capabilities: {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": { status: "unsupported", canonical: "string", rawRepresentations: ["string"] },
    "numeric.exact-decimal": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "numeric.approximate-special": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "numeric.bind-exact": { status: "unsupported", conditionCode: "oracle.bind-nls-sensitive" },
    "data.json-parsed": { status: "guaranteed", rawRepresentations: ["object", "array", "string", "number", "boolean", "null"] },
    "data.json-lossless-text": { status: "unsupported", canonical: "string", rawRepresentations: ["string"], conditionCode: "oracle.json-serialize-required" },
    "data.oracle-object": { status: "unsupported", rawRepresentations: ["object"], conditionCode: "oracle.object-nested-numeric-unclassified" },
    "data.oracle-collection": { status: "unsupported", rawRepresentations: ["object", "array"], conditionCode: "oracle.collection-nested-numeric-unclassified" },
    "data.vector": { status: "unsupported", rawRepresentations: ["object", "array"], conditionCode: "oracle.vector-unclassified" },
    "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["Buffer"] },
    "data.uuid": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
    "data.temporal-native": { status: "guarded", rawRepresentations: ["Date"], conditionCode: "oracle.date-millisecond-precision" },
    "data.temporal-lossless": { status: "unsupported", canonical: "string", rawRepresentations: ["string"], conditionCode: "oracle.temporal-text-cast-required" },
    "metadata.command-safe": { status: "guarded", rawRepresentations: ["number"], conditionCode: "oracle.count-safe-integer" },
    "session.pinned": { status: "guaranteed" },
    "transaction": { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": { status: "guaranteed" },
    "transaction.isolation.read-uncommitted": { status: "unsupported" },
    "transaction.isolation.read-committed": { status: "guaranteed" },
    "transaction.isolation.repeatable-read": { status: "unsupported" },
    "transaction.isolation.serializable": { status: "guaranteed" },
    "statement.prepare": { status: "guaranteed" },
    "statement.cancel": { status: "guarded", conditionCode: "oracle.connection-break" },
    "statement.stream": { status: "guaranteed" },
    "statement.bulk": { status: "guaranteed" },
    "routine.call": { status: "guaranteed" },
    "routine.out": { status: "guaranteed" },
    "routine.inout": { status: "guaranteed" },
    "routine.return-value": { status: "unsupported" },
    "routine.result-sets": { status: "guaranteed" },
    "routine.out-cursor": { status: "guaranteed" },
  },
  probe: {
    statement: createRenderedStatement({
      segments: ["SELECT banner AS version FROM v$version WHERE ROWNUM = 1"],
      parameters: [],
      resultKind: "rows",
      dialectId: "oracle",
    }),
    read: (rows) => {
      const row = rows[0];
      if (!row || typeof row !== "object" || Array.isArray(row)) return {};
      const version = (row as Record<string, unknown>).VERSION ?? (row as Record<string, unknown>).version;
      return typeof version === "string" ? { version } : {};
    },
  },
});

function customOracleEnvironment(
  policy: TypePolicy,
  cancellationSupported: boolean,
): DriverEnvironment {
  return {
    ...oracleEnvironment,
    driver: { id: "node-oracledb", profile: "custom" },
    typePolicy: { id: policy.id, hash: policy.hash },
    capabilities: cancellationSupported
      ? { "statement.cancel": oracleEnvironment.capabilities["statement.cancel"]! }
      : {},
  };
}

interface OracleStatementBindingAdapter extends StatementBindingAdapter {
  readonly materializedBinds: (
    statement: RenderedStatement,
    description: StatementBindingDescription,
  ) => readonly unknown[] | undefined;
  readonly materializedBulk: (
    bulk: RenderedBulk,
    description: BulkBindingDescription,
  ) => { readonly binds: readonly (readonly unknown[])[]; readonly bindDefs: readonly OracleBindLike[] } | undefined;
}

export interface OracledbStatementBindingOptions {
  readonly typePolicy?: TypePolicy;
  readonly driver?: OracleDriverLike;
  readonly executeOptions?: OracleExecuteOptionsLike;
  readonly stmtCacheSize?: number;
}

export interface OracleExecuteManyOptionsLike {
  readonly bindDefs?: readonly OracleBindLike[];
  readonly batchErrors?: boolean;
  readonly dmlRowCounts?: boolean;
  readonly [key: string]: unknown;
}

interface OracleRoutineParameter {
  readonly value: unknown;
  readonly hint?: ParameterTypeHint;
  readonly direction?: "in" | "out" | "inout";
  readonly outputName?: string;
}

function assertConnection(connection: OracleConnectionLike): void {
  if (!connection || typeof connection !== "object" || typeof connection.execute !== "function" || typeof connection.commit !== "function" || typeof connection.rollback !== "function" || typeof (connection as { readonly getConnection?: unknown }).getConnection === "function") {
    throw new TypeError("SQLBraid Oracle direct adapter requires a physical node-oracledb Connection.");
  }
}

function assertExecutionOptions(connection: OracleConnectionLike, options?: ExecutionOptions): void {
  const signal = options?.signal;
  if (signal === undefined) return;
  if (signal.aborted) throw signal.reason;
  if (typeof connection.break !== "function") {
    throw new UnsupportedFeatureError(
      "statement.cancel",
      "BRAID_CANCEL_UNSUPPORTED",
      "node-oracledb connection does not expose the documented break() cancellation primitive.",
    );
  }
}

async function executeWithCancellation<T>(
  connection: OracleConnectionLike,
  operation: () => Promise<T>,
  options?: ExecutionOptions,
): Promise<T> {
  assertExecutionOptions(connection, options);
  const signal = options?.signal;
  if (signal === undefined) return operation();
  let aborted = false;
  let breakFailure: unknown;
  let hasBreakFailure = false;
  let breakPromise: Promise<void> | undefined;
  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    try {
      breakPromise = Promise.resolve(connection.break!()).catch((error) => {
        breakFailure = error;
        hasBreakFailure = true;
      });
    } catch (error) {
      breakFailure = error;
      hasBreakFailure = true;
      breakPromise = Promise.resolve();
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await operation();
    if (breakPromise !== undefined) await breakPromise;
    if (aborted) {
      if (hasBreakFailure) {
        await throwWithCleanup(signal.reason, [breakFailure]);
      }
      throw signal.reason;
    }
    return result;
  } catch (error) {
    if (breakPromise !== undefined) await breakPromise;
    if (hasBreakFailure) {
      await throwWithCleanup(error, [breakFailure]);
    }
    if (aborted) throw signal.reason;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function throwWithCleanup(primary: unknown, failures: readonly unknown[]): Promise<never> {
  const scope = createCleanupScope();
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const failure = failures[index];
    scope.add(() => { throw failure; });
  }
  await scope.run(primary);
  throw primary;
}

function assertPoolConnection(connection: OraclePoolConnectionLike): void {
  if (!connection || typeof connection !== "object" || typeof connection.execute !== "function" || typeof connection.commit !== "function" || typeof connection.rollback !== "function" || typeof connection.close !== "function") {
    throw new TypeError("SQLBraid Oracle pool provider requires a physical node-oracledb Pool connection.");
  }
}

function executionResult(value: unknown): OracleExecuteResultLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ORACLE_RESULT: node-oracledb returned a malformed execution result.");
  }
  return value as OracleExecuteResultLike;
}

function normalType(value: string): string {
  return value.trim().toUpperCase().replaceAll(/\s+/gu, " ");
}

function metadataType(field: OracleMetaDataLike | undefined, driver: OracleDriverLike): string | undefined {
  const named = field?.dbTypeName ?? (typeof field?.type === "string" ? field.type : undefined);
  if (named) return normalType(named);
  const value = field?.dbType ?? field?.type;
  if (typeof value === "string") return normalType(value);
  if (value === undefined) return undefined;
  if (value === driver.DB_TYPE_CHAR) return "CHAR";
  if (value === driver.DB_TYPE_VARCHAR || value === driver.STRING) return "VARCHAR2";
  if (value === driver.DB_TYPE_NCHAR) return "NCHAR";
  if (value === driver.DB_TYPE_NVARCHAR) return "NVARCHAR2";
  if (value === driver.DB_TYPE_NUMBER || value === driver.NUMBER) return "NUMBER";
  if (value === driver.DB_TYPE_BINARY_FLOAT || value === driver.BINARY_FLOAT) return "BINARY_FLOAT";
  if (value === driver.DB_TYPE_BINARY_DOUBLE || value === driver.BINARY_DOUBLE) return "BINARY_DOUBLE";
  if (value === driver.DB_TYPE_DATE || value === driver.DATE) return "DATE";
  if (value === driver.DB_TYPE_TIMESTAMP) return "TIMESTAMP";
  if (value === driver.DB_TYPE_TIMESTAMP_TZ) return "TIMESTAMP WITH TIME ZONE";
  if (value === driver.DB_TYPE_TIMESTAMP_LTZ) return "TIMESTAMP WITH LOCAL TIME ZONE";
  if (value === driver.DB_TYPE_RAW || value === driver.BUFFER) return "RAW";
  if (value === driver.DB_TYPE_BLOB || value === driver.BLOB) return "BLOB";
  if (value === driver.DB_TYPE_CLOB || value === driver.CLOB) return "CLOB";
  if (value === driver.DB_TYPE_NCLOB || value === driver.NCLOB) return "NCLOB";
  if (value === driver.DB_TYPE_ROWID) return "ROWID";
  if (value === driver.DB_TYPE_UROWID) return "UROWID";
  if (value === driver.DB_TYPE_JSON) return "JSON";
  if (value === driver.DB_TYPE_OBJECT) return "OBJECT";
  if (value === driver.DB_TYPE_VECTOR) return "VECTOR";
  return undefined;
}

function decodeRow(value: unknown, fields: readonly OracleMetaDataLike[], policy: TypePolicy, driver: OracleDriverLike): Record<string, unknown> {
  if (Array.isArray(value)) {
    const row: Record<string, unknown> = {};
    for (const [index, entry] of value.entries()) {
      const key = fields[index]?.name;
      if (key === undefined) continue;
      const type = metadataType(fields[index], driver);
      assertOracleNumericValue(type, entry);
      defineResultProperty(row, key, type === undefined ? entry : policy.decode(type, entry));
    }
    return row;
  }
  if (!value || typeof value !== "object") return { value };
  const row: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.name === key);
    const type = metadataType(field, driver);
    assertOracleNumericValue(type, entry);
    defineResultProperty(row, key, type === undefined ? entry : policy.decode(type, entry));
  }
  return row;
}

function assertOracleNumericValue(databaseType: string | undefined, value: unknown): void {
  if (value === null || value === undefined || databaseType === undefined) return;
  const type = normalType(databaseType);
  if (isOracleExactNumericType(type)) {
    if (typeof value !== "string") {
      throw new ResultExactnessError(`Oracle ${type} results must remain exact strings.`);
    }
    return;
  }
  if (isOracleBinaryNumericType(type)) {
    if (typeof value !== "number") {
      throw new ResultExactnessError(`Oracle ${type} results must remain JavaScript numbers, including native non-finite values.`);
    }
  }
}

function matchesDriverType(value: unknown, candidate: unknown): boolean {
  return candidate !== undefined && value === candidate;
}

function fetchTypeHandler(driver: OracleDriverLike): NonNullable<OracleExecuteOptionsLike["fetchTypeHandler"]> {
  const stringType = driver.STRING ?? driver.DB_TYPE_VARCHAR;
  const bufferType = driver.BUFFER ?? driver.DB_TYPE_RAW;
  return (metadata) => {
    const named = metadata.dbTypeName ?? (typeof metadata.type === "string" ? metadata.type : undefined);
    const typeName = named === undefined ? undefined : normalType(named);
    const typeValue = metadata.dbType ?? metadata.type;
    if ((typeName !== undefined && isOracleExactNumericType(typeName)) || typeName === "CLOB" || typeName === "NCLOB"
      || matchesDriverType(typeValue, driver.DB_TYPE_NUMBER)
      || matchesDriverType(typeValue, driver.NUMBER)
      || matchesDriverType(typeValue, driver.DB_TYPE_CLOB)
      || matchesDriverType(typeValue, driver.CLOB)
      || matchesDriverType(typeValue, driver.DB_TYPE_NCLOB)
      || matchesDriverType(typeValue, driver.NCLOB)) {
      return stringType === undefined ? undefined : { type: stringType };
    }
    if (typeName === "BLOB" || matchesDriverType(typeValue, driver.DB_TYPE_BLOB) || matchesDriverType(typeValue, driver.BLOB)) {
      return bufferType === undefined ? undefined : { type: bufferType };
    }
    return undefined;
  };
}

function assertUniqueFields(fields: readonly OracleMetaDataLike[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (!field.name) continue;
    if (names.has(field.name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate Oracle result label ${field.name}.`);
    names.add(field.name);
  }
}

function typeConstant(databaseType: string, driver: OracleDriverLike): unknown {
  const type = normalType(databaseType);
  const value = type === "REF CURSOR" || type === "REFCURSOR" || type === "SYS_REFCURSOR" || type === "CURSOR" ? driver.CURSOR
    : type === "CHAR" ? (driver.DB_TYPE_CHAR ?? driver.DB_TYPE_VARCHAR ?? driver.STRING)
      : type === "VARCHAR" || type === "VARCHAR2" ? (driver.DB_TYPE_VARCHAR ?? driver.STRING)
        : type === "NCHAR" ? (driver.DB_TYPE_NCHAR ?? driver.DB_TYPE_NVARCHAR)
          : type === "NVARCHAR2" ? driver.DB_TYPE_NVARCHAR
            : isOracleExactNumericType(type) ? (driver.DB_TYPE_NUMBER ?? driver.NUMBER)
              : type === "BINARY_FLOAT" ? (driver.DB_TYPE_BINARY_FLOAT ?? driver.BINARY_FLOAT)
                : type === "BINARY_DOUBLE" ? (driver.DB_TYPE_BINARY_DOUBLE ?? driver.BINARY_DOUBLE)
                  : type === "DATE" ? (driver.DB_TYPE_DATE ?? driver.DATE)
                    : type === "TIMESTAMP" ? driver.DB_TYPE_TIMESTAMP
                      : type === "TIMESTAMP WITH TIME ZONE" ? driver.DB_TYPE_TIMESTAMP_TZ
                        : type === "TIMESTAMP WITH LOCAL TIME ZONE" ? driver.DB_TYPE_TIMESTAMP_LTZ
                          : type === "RAW" ? (driver.DB_TYPE_RAW ?? driver.BUFFER)
                            : type === "ROWID" ? driver.DB_TYPE_ROWID
                              : type === "UROWID" ? driver.DB_TYPE_UROWID
                                : type === "BLOB" ? (driver.DB_TYPE_BLOB ?? driver.BLOB)
                                  : type === "CLOB" ? (driver.DB_TYPE_CLOB ?? driver.CLOB)
                                    : type === "NCLOB" ? (driver.DB_TYPE_NCLOB ?? driver.NCLOB)
                                      : undefined;
  if (value === undefined) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      `Oracle driver cannot bind explicit type ${databaseType}.`,
    );
  }
  return value;
}

function bindValues(rendered: RenderedStatement, policy: TypePolicy, driver: OracleDriverLike): readonly unknown[] {
  const values: unknown[] = [];
  for (let index = 0; index < rendered.parameters.length; index += 1) {
    const parameter = rendered.parameters[index]! as OracleRoutineParameter;
    const value = parameter.value;
    const hint = parameter.hint;
    const direction = parameter.direction ?? "in";
    if (direction !== "in" && rendered.resultKind !== "call" && !(direction === "out" && rendered.resultKind === "rows")) {
      throw new UnsupportedFeatureError("routine.out", "BRAID_CALL_OUT_UNSUPPORTED", "OUT parameters require sql.call() or sql.rows(); INOUT requires sql.call().");
    }
    if (direction !== "in" && hint === undefined) {
      throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", "Oracle OUT and INOUT parameters require an explicit type hint.");
    }
    const databaseType = hint === undefined ? undefined : normalType(hint.databaseType);
    const isCursor = databaseType === "REF CURSOR" || databaseType === "REFCURSOR" || databaseType === "SYS_REFCURSOR" || databaseType === "CURSOR";
    if (isCursor && direction === "in") {
      throw new UnsupportedFeatureError("routine.out-cursor", "BRAID_CALL_CURSOR_UNSUPPORTED", "Oracle REF CURSOR parameters must be OUT or INOUT.");
    }
    if (isCursor) {
      if (hint!.length !== undefined || hint!.precision !== undefined || hint!.scale !== undefined) {
        throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", "Oracle REF CURSOR does not accept type facets.");
      }
      const cursorType = driver.CURSOR;
      if (cursorType === undefined) throw new UnsupportedFeatureError("routine.out-cursor", "BRAID_CALL_CURSOR_UNSUPPORTED", "Oracle driver does not expose CURSOR binds.");
      values.push({
        dir: direction === "out" ? driver.BIND_OUT : driver.BIND_INOUT,
        ...(direction === "inout" ? { val: value } : {}),
        type: cursorType,
      } satisfies OracleBindLike);
      continue;
    }
    if (hint === undefined) {
      if (value === null || value === undefined) throw new AdapterError("BRAID_BIND_TYPE_REQUIRED", "Oracle null parameters require sql.bind(null, oracleParameter.*).");
      values.push(value);
      continue;
    }
    if (hint.precision !== undefined || hint.scale !== undefined) {
      throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", `Oracle bind ${databaseType} does not support precision or scale facets.`);
    }
    if (direction !== "in" && hint.length === undefined
      && (databaseType === "CHAR" || databaseType === "NCHAR" || databaseType === "VARCHAR" || databaseType === "VARCHAR2" || databaseType === "NVARCHAR2" || databaseType === "RAW")) {
      throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", `Oracle ${databaseType} OUT binds require an explicit length to avoid undersized buffers.`);
    }
    if (hint.length !== undefined && (direction === "in" || (databaseType !== "CHAR" && databaseType !== "NCHAR" && databaseType !== "VARCHAR" && databaseType !== "VARCHAR2" && databaseType !== "NVARCHAR2" && databaseType !== "RAW"))) {
      throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", `Oracle bind ${databaseType} does not support length facets.`);
    }
    const encoded = direction === "out" ? undefined : policy.encode(databaseType!, value);
    const exactNumberOutput = databaseType !== undefined && isOracleExactNumericType(databaseType) && direction !== "in";
    if (databaseType !== undefined && isOracleExactNumericType(databaseType) && typeof encoded === "string" && direction !== "out") {
      throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", `Oracle ${databaseType} binds do not accept decimal strings through the exact numeric driver type; use an unhinted string with an explicit user-authored conversion and NLS clause.`);
    }
    values.push({
      dir: direction === "in" ? driver.BIND_IN : direction === "out" ? driver.BIND_OUT : driver.BIND_INOUT,
      ...(direction === "out" ? {} : { val: exactNumberOutput && (typeof encoded === "bigint" || typeof encoded === "number") ? String(encoded) : encoded }),
      // fetchTypeHandler covers row columns, not OUT binds. Bind NUMBER outputs
      // as character carriers so the driver never rounds them through Number.
      type: typeConstant(exactNumberOutput ? "VARCHAR2" : databaseType!, driver),
      ...(exactNumberOutput ? { maxSize: 172 } : {}),
      ...(direction !== "in" && hint.length !== undefined
        && (databaseType === "CHAR" || databaseType === "NCHAR" || databaseType === "VARCHAR" || databaseType === "VARCHAR2" || databaseType === "NVARCHAR2" || databaseType === "RAW")
        ? { maxSize: hint.length === "max" ? 32_767 : hint.length }
        : {}),
    } satisfies OracleBindLike);
  }
  return values;
}

function oracleLiteralValue(
  value: unknown,
  binary: "summary" | "full" | undefined = "summary",
  databaseType?: string,
): string {
  if (value === null || value === undefined) return "NULL";
  const type = databaseType === undefined ? undefined : normalType(databaseType);
  if (type !== undefined && (isOracleExactNumericType(type) || isOracleBinaryNumericType(type))) {
    return typeof value === "bigint"
      ? value.toString(10)
      : typeof value === "number" && Number.isFinite(value) ? String(value) : "[unsupported numeric value]";
  }
  if (type === "DATE" || type?.startsWith("TIMESTAMP")) {
    return value instanceof Date && Number.isFinite(Date.prototype.getTime.call(value))
      ? `TIMESTAMP '${Date.prototype.toISOString.call(value).replace("T", " ").replace("Z", "")}'`
      : "[unsupported date]";
  }
  if (type === "RAW" || type === "BLOB") {
    if (!(value instanceof Uint8Array)) return "[unsupported binary value]";
    if (binary !== "full") return `<binary ${value.byteLength} bytes>`;
    return `HEXTORAW('${Buffer.from(value).toString("hex").toUpperCase()}')`;
  }
  if (type === "VARCHAR2" || type === "NVARCHAR2" || type === "CLOB" || type === "NCLOB") {
    return typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : "[unsupported string value]";
  }
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "[unsupported number]";
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) {
    if (!Number.isFinite(Date.prototype.getTime.call(value))) return "[unsupported date]";
    return `TIMESTAMP '${Date.prototype.toISOString.call(value).replace("T", " ").replace("Z", "")}'`;
  }
  if (value instanceof Uint8Array) {
    if (binary !== "full") return `<binary ${value.byteLength} bytes>`;
    const hex = Buffer.from(value).toString("hex").toUpperCase();
    return `HEXTORAW('${hex}')`;
  }
  return typeof value === "object" ? "[unsupported object]" : `[unsupported ${typeof value}]`;
}

type OracleBulkMaterialized = {
  readonly binds: readonly (readonly unknown[])[];
  readonly bindDefs: readonly OracleBindLike[];
};

function inferredBulkType(value: unknown, driver: OracleDriverLike): { readonly type: unknown; readonly kind: "string" | "binary" | "number" | "date" } {
  if (typeof value === "string") {
    const type = driver.STRING ?? driver.DB_TYPE_VARCHAR;
    if (type === undefined) throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", "Oracle driver does not expose STRING binds.");
    return { type, kind: "string" };
  }
  if (typeof value === "number" || typeof value === "bigint") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Oracle bulk number values must be finite.");
    const type = driver.NUMBER ?? driver.DB_TYPE_NUMBER;
    if (type === undefined) throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", "Oracle driver does not expose NUMBER binds.");
    return { type, kind: "number" };
  }
  if (value instanceof Date) {
    if (!Number.isFinite(Date.prototype.getTime.call(value))) throw new TypeError("Oracle bulk date values must be valid dates.");
    const type = driver.DATE ?? driver.DB_TYPE_DATE;
    if (type === undefined) throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", "Oracle driver does not expose DATE binds.");
    return { type, kind: "date" };
  }
  if (value instanceof Uint8Array) {
    const type = driver.BUFFER ?? driver.DB_TYPE_RAW;
    if (type === undefined) throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", "Oracle driver does not expose BUFFER binds.");
    return { type, kind: "binary" };
  }
  throw new TypeError("BRAID_BULK_VALUE: Oracle bulk values must be strings, finite numbers, bigint, Date, Uint8Array, or null.");
}

function bulkMaxSize(values: readonly unknown[], kind: "string" | "binary"): number {
  let max = 0;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (kind === "string") {
      if (typeof value !== "string") throw new TypeError("BRAID_BULK_TYPE: Oracle bulk column values must use one value type.");
      max = Math.max(max, utf8ByteLength(value));
    } else {
      if (!(value instanceof Uint8Array)) throw new TypeError("BRAID_BULK_TYPE: Oracle bulk column values must use one value type.");
      max = Math.max(max, value.byteLength);
    }
  }
  return Math.max(max, 1);
}

function materializeBulk(
  bulk: RenderedBulk,
  policy: TypePolicy,
  driver: OracleDriverLike,
): OracleBulkMaterialized {
  if (bulk.statement.resultKind !== "command") throw new Error("BRAID_BULK_KIND: Oracle bulk accepts command queries only.");
  const parameters = bulk.statement.parameters.map(routineParameter);
  const sets = bulk.parameterSets;
  const columns = parameters.map((parameter, index) => {
    const direction = parameter.direction ?? "in";
    if (direction !== "in") throw new Error("BRAID_BULK_OUT: Oracle bulk does not support OUT or INOUT parameters.");
    const hint = parameter.hint;
    const typeName = hint === undefined ? undefined : normalType(hint.databaseType);
    if (hint !== undefined && (hint.precision !== undefined || hint.scale !== undefined)) {
      throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", `Oracle bulk bind ${typeName} does not support precision or scale facets.`);
    }
    if (hint !== undefined && hint.length !== undefined && typeName !== "VARCHAR2" && typeName !== "NVARCHAR2" && typeName !== "RAW") {
      throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", `Oracle bulk bind ${typeName} does not support length facets.`);
    }
    const rawValues = sets.map((values) => values[index]);
    const encoded = rawValues.map((value) => hint === undefined ? value : policy.encode(typeName!, value));
    if (typeName !== undefined && isOracleExactNumericType(typeName) && encoded.some((value) => typeof value === "string")) {
      throw new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", `Oracle ${typeName} bulk binds do not accept decimal strings through the exact numeric driver type; use an unhinted string with an explicit user-authored conversion and NLS clause.`);
    }
    if (hint === undefined) {
      const nonNull = encoded.find((value) => value !== null && value !== undefined);
      if (nonNull === undefined) throw new AdapterError("BRAID_BIND_TYPE_REQUIRED", "Oracle bulk null columns require sql.bind values with an explicit type hint.");
      const inferred = inferredBulkType(nonNull, driver);
      for (const value of encoded) {
        if (value === null || value === undefined) continue;
        const next = inferredBulkType(value, driver);
        if (next.kind !== inferred.kind) throw new TypeError("BRAID_BULK_TYPE: Oracle bulk column values must use one value type.");
      }
      const maxSize = inferred.kind === "string" || inferred.kind === "binary"
        ? bulkMaxSize(encoded, inferred.kind)
        : undefined;
      return {
        values: encoded,
        definition: {
          dir: driver.BIND_IN,
          type: inferred.type,
          ...(maxSize === undefined ? {} : { maxSize }),
        },
      };
    }
    const type = typeConstant(typeName!, driver);
    const kind = typeName === "VARCHAR2" || typeName === "NVARCHAR2" ? "string"
      : typeName === "RAW" ? "binary"
        : undefined;
    let maxSize: number | undefined;
    if (kind !== undefined) {
      maxSize = bulkMaxSize(encoded, kind);
      if (hint.length !== undefined && hint.length !== "max") maxSize = Math.max(maxSize, hint.length);
      if (hint.length === "max") maxSize = Math.max(maxSize, 32_767);
    }
    return {
      values: encoded,
      definition: {
        dir: driver.BIND_IN,
        type,
        ...(maxSize === undefined ? {} : { maxSize }),
      },
    };
  });
  const binds = Object.freeze(sets.map((_, rowIndex) => Object.freeze(columns.map((column) => column.values[rowIndex]))));
  return {
    binds,
    bindDefs: Object.freeze(columns.map((column) => Object.freeze(column.definition))),
  };
}

function createBinding(options: OracledbStatementBindingOptions = {}): OracleStatementBindingAdapter {
  const policy = options.typePolicy ?? defaultTypePolicy;
  const driver = options.driver ?? defaultDriver;
  const effectiveReuse = options.executeOptions?.keepInStmtCache === false || options.stmtCacheSize === 0 ? "simple" : "reuse";
  const encodedBinds = new WeakMap<StatementBindingDescription, { readonly statement: RenderedStatement; readonly binds: readonly unknown[] }>();
  const encodedBulk = new WeakMap<BulkBindingDescription, { readonly bulk: RenderedBulk; readonly materialized: OracleBulkMaterialized }>();
  const adapter: OracleStatementBindingAdapter = {
    id: "oracledb",
    describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
      // Materialize before creating the public description so every failure is
      // deterministic and occurs before an executor can acquire a connection.
      const binds = bindValues(statement, policy, driver);
      const description = createStatementBindingDescription(statement, context, {
        adapterId: "oracledb",
        transport: "text-positional",
        placeholder: (index) => `:${index}`,
        reuse: {
          effective: effectiveReuse,
          owner: "driver",
          ...(effectiveReuse === "reuse" && options.stmtCacheSize !== undefined && Number.isSafeInteger(options.stmtCacheSize) && options.stmtCacheSize > 0
            ? { capacity: options.stmtCacheSize }
            : {}),
        },
        formatLiteral: (parameter, index, literalOptions) => {
          const encoded = binds[index];
          const value = parameter.hint === undefined
            ? encoded
            : (encoded as OracleBindLike).val;
          return oracleLiteralValue(value, literalOptions.binary, parameter.hint?.databaseType);
        },
      });
      encodedBinds.set(description, { statement, binds });
      return description;
    },
    describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
      // Validate and encode the complete matrix before exposing the description.
      const materialized = materializeBulk(bulk, policy, driver);
      const description = createBulkBindingDescription(bulk, context, {
        adapterId: "oracledb",
        transport: "text-positional",
        placeholder: (index) => `:${index}`,
        reuse: {
          effective: effectiveReuse,
          owner: "driver",
          ...(effectiveReuse === "reuse" && options.stmtCacheSize !== undefined && Number.isSafeInteger(options.stmtCacheSize) && options.stmtCacheSize > 0
            ? { capacity: options.stmtCacheSize }
            : {}),
        },
        formatLiteral: (parameter, _index, literalOptions) => oracleLiteralValue(parameter.value, literalOptions.binary, parameter.hint?.databaseType),
      });
      encodedBulk.set(description, { bulk, materialized });
      return description;
    },
    materializedBinds(statement: RenderedStatement, description: StatementBindingDescription): readonly unknown[] | undefined {
      const materialized = encodedBinds.get(description);
      return materialized?.statement === statement ? materialized.binds : undefined;
    },
    materializedBulk(bulk: RenderedBulk, description: BulkBindingDescription): OracleBulkMaterialized | undefined {
      const materialized = encodedBulk.get(description);
      return materialized?.bulk === bulk ? materialized.materialized : undefined;
    },
  };
  return Object.freeze(adapter);
}

export function createOracledbStatementBinding(options: OracledbStatementBindingOptions = {}): StatementBindingAdapter {
  return createBinding(options);
}

/** Default adapter for callers that do not supply a custom type policy/driver. */
export const oracledbStatementBinding: StatementBindingAdapter = createOracledbStatementBinding();

function executionBinding(
  adapter: OracleStatementBindingAdapter,
  statement: RenderedStatement,
  description: StatementBindingDescription | undefined,
): { readonly description: StatementBindingDescription; readonly binds: readonly unknown[] } {
  const binding = description ?? adapter.describe(statement, {
    dialectId: statement.dialectId,
    requestedReuse: "auto",
  });
  if (binding.adapterId !== adapter.id) {
    throw new TypeError(`SQLBraid Oracle executor requires binding adapter "${adapter.id}".`);
  }
  const binds = adapter.materializedBinds(statement, binding);
  if (binds === undefined) {
    throw new TypeError("SQLBraid Oracle executor received a binding description not produced by its adapter.");
  }
  return { description: binding, binds };
}

function executeOptions(options: OracleDatabaseOptions, driver: OracleDriverLike, resultSet = false): OracleExecuteOptionsLike {
  const {
    fetchAsString: _fetchAsString,
    fetchAsBuffer: _fetchAsBuffer,
    fetchInfo: _fetchInfo,
    fetchTypeHandler: _fetchTypeHandler,
    outFormat: _outFormat,
    resultSet: _resultSet,
    ...customOptions
  } = options.executeOptions ?? {};
  return {
    ...customOptions,
    outFormat: oracleOutFormatArray,
    fetchTypeHandler: fetchTypeHandler(driver),
    ...(resultSet ? { resultSet: true } : {}),
  };
}

function streamFetchSize(options: OracleDatabaseOptions): number {
  const value = options.streamFetchSize;
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Oracle streamFetchSize must be a positive safe integer.");
  }
  return value;
}

function closeLob(lob: OracleLobLike): Promise<void> {
  if (lob.destroyed === true && lob.closed === true) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let failure: unknown;
    let settled = false;
    const onError = (error: unknown): void => { failure ??= error; };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      lob.removeListener?.("error", onError);
      lob.removeListener?.("close", onClose);
      if (failure === undefined) resolve();
      else reject(failure);
    };
    lob.once("error", onError);
    lob.once("close", onClose);
    try {
      lob.destroy();
    } catch (error) {
      failure ??= error;
      onClose();
    }
  });
}

function oracleLob(value: unknown, name: string): OracleLobLike | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as OracleLobLike).getData !== "function") return undefined;
  const lob = value as OracleLobLike;
  if (typeof lob.destroy !== "function" || typeof lob.once !== "function") {
    throw new UnsupportedFeatureError("routine.out", "BRAID_CALL_LOB_UNSUPPORTED", `Oracle output ${name} did not return a Lob with the documented destroy() stream API.`);
  }
  return lob;
}

function materializedLobType(type: string | undefined): boolean {
  return type === "BLOB" || type === "CLOB" || type === "NCLOB";
}

function isMaterializedLobValue(type: string, value: unknown): boolean {
  return type === "BLOB" ? value instanceof Uint8Array : typeof value === "string";
}

async function materializeLob(lob: OracleLobLike, type: string, name: string): Promise<string | Uint8Array> {
  const data = await lob.getData();
  if ((type === "CLOB" || type === "NCLOB") && typeof data === "string") return data;
  if (type === "BLOB" && data instanceof Uint8Array) return data;
  const expected = type === "BLOB" ? "bytes" : "string";
  throw new UnsupportedFeatureError("routine.out", "BRAID_CALL_LOB_UNSUPPORTED", `Oracle output ${name} did not return ${expected} Lob data.`);
}

function routineParameter(parameter: unknown): OracleRoutineParameter {
  return parameter as OracleRoutineParameter;
}

/**
 * Map rendered parameter indexes to node-oracledb's physical OUT ordinal.
 *
 * Positional outBinds omit IN parameters, so indexing outBinds by the
 * rendered parameter index is incorrect for mixed IN/OUT calls.
 */
export function oracleOutputOrdinals(rendered: RenderedStatement): readonly (number | undefined)[] {
  let ordinal = 0;
  return Object.freeze(rendered.parameters.map((parameter) => {
    if ((routineParameter(parameter).direction ?? "in") === "in") return undefined;
    const current = ordinal;
    ordinal += 1;
    return current;
  }));
}

function outBindValue(outBinds: unknown, ordinal: number, outputName?: string): unknown {
  if (Array.isArray(outBinds)) return outBinds[ordinal];
  if (outBinds && typeof outBinds === "object") {
    const object = outBinds as Record<string, unknown>;
    for (const key of [outputName, String(ordinal + 1), `p${ordinal + 1}`, ordinal]) {
      if (key !== undefined && Object.prototype.hasOwnProperty.call(object, key)) return object[key];
    }
  }
  return undefined;
}

function setOutputValue(output: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(output, name, { value, enumerable: true, configurable: true, writable: true });
}

async function readResultSet(
  resultSet: OracleResultSetLike,
  driver: OracleDriverLike,
  policy: TypePolicy,
): Promise<readonly Record<string, unknown>[]> {
  const fields = Array.isArray(resultSet.metaData) ? resultSet.metaData : [];
  assertUniqueFields(fields);
  const rows: Record<string, unknown>[] = [];
  if (resultSet.getRows) {
    while (true) {
      const batch = await resultSet.getRows(100);
      if (batch.length === 0) break;
      for (const row of batch) rows.push(decodeRow(row, fields, policy, driver));
      if (batch.length < 100) break;
    }
    return rows;
  }
  if (resultSet.getRow) {
    while (true) {
      const row = await resultSet.getRow();
      if (row === null || row === undefined) break;
      rows.push(decodeRow(row, fields, policy, driver));
    }
    return rows;
  }
  if (resultSet[Symbol.asyncIterator]) {
    for await (const row of resultSet as AsyncIterable<unknown>) rows.push(decodeRow(row, fields, policy, driver));
    return rows;
  }
  throw new UnsupportedFeatureError("routine.out-cursor", "BRAID_CALL_CURSOR_UNSUPPORTED", "Oracle ResultSet does not expose getRows, getRow, or async iteration.");
}

function returningParameters(rendered: RenderedStatement): readonly { readonly parameter: OracleRoutineParameter; readonly index: number; readonly ordinal: number }[] {
  const ordinals = oracleOutputOrdinals(rendered);
  const output: { readonly parameter: OracleRoutineParameter; readonly index: number; readonly ordinal: number }[] = [];
  for (let index = 0; index < rendered.parameters.length; index += 1) {
    const ordinal = ordinals[index];
    if (ordinal === undefined) continue;
    output.push({ parameter: routineParameter(rendered.parameters[index]), index, ordinal });
  }
  return output;
}

async function normalizeDmlReturning(
  rendered: RenderedStatement,
  result: OracleExecuteResultLike,
  policy: TypePolicy,
): Promise<QueryExecutionResult<Record<string, unknown>> | undefined> {
  const outputs = returningParameters(rendered);
  if (rendered.resultKind !== "rows" || outputs.length === 0) return undefined;
  const cleanupScope = createCleanupScope();
  let failure: unknown;
  let hasFailure = false;
  const recordFailure = (error: unknown): void => {
    if (!hasFailure) {
      failure = error;
      hasFailure = true;
    }
  };
  const values: Array<readonly unknown[] | undefined> = [];
  for (const { parameter, ordinal, index } of outputs) {
    try {
      const value = outBindValue(result.outBinds, ordinal, parameter.outputName);
      if (!Array.isArray(value)) {
        recordFailure(new TypeError(`BRAID_RETURNING_ARRAY: Oracle DML RETURNING output ${parameter.outputName ?? `parameter ${index + 1}`} was not an array.`));
        values.push(undefined);
      } else {
        values.push(value);
      }
    } catch (error) {
      recordFailure(error);
      values.push(undefined);
    }
  }
  const lobs = new Map<OracleLobLike, OracleLobLike>();
  for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
    const { parameter, index } = outputs[outputIndex]!;
    const hintType = parameter.hint === undefined ? undefined : normalType(parameter.hint.databaseType);
    const valuesForOutput = values[outputIndex];
    if (valuesForOutput === undefined || hintType === undefined || !materializedLobType(hintType)) continue;
    const name = parameter.outputName ?? `parameter ${index + 1}`;
    for (const value of valuesForOutput) {
      if (value === null || value === undefined || isMaterializedLobValue(hintType, value)) continue;
      try {
        const lob = oracleLob(value, name);
        if (lob === undefined) {
          recordFailure(new UnsupportedFeatureError("routine.out", "BRAID_CALL_LOB_UNSUPPORTED", `Oracle output ${name} did not return a Lob.`));
          continue;
        }
        if (!lobs.has(lob)) {
          lobs.set(lob, lob);
          cleanupScope.add(() => closeLob(lob));
        }
      } catch (error) {
        recordFailure(error);
      }
    }
  }
  const rowCount = values[0]?.length ?? 0;
  if (!hasFailure) {
    for (const [index, value] of values.entries()) {
      if (value!.length !== rowCount) {
        recordFailure(new Error(`BRAID_RETURNING_LENGTH: Oracle DML RETURNING output arrays have different lengths (output ${index + 1} has ${value!.length}, expected ${rowCount}).`));
      }
    }
  }
  if (!hasFailure && result.rowsAffected !== undefined) {
    try {
      const affectedRows = safeDatabaseCount(result.rowsAffected);
      if (affectedRows !== rowCount) {
        recordFailure(new Error(`BRAID_RETURNING_ROWCOUNT: Oracle rowsAffected (${affectedRows}) does not match returned row count (${rowCount}).`));
      }
    } catch (error) {
      recordFailure(error);
    }
  }
  let rows: readonly Record<string, unknown>[] | undefined;
  if (!hasFailure) try {
    const materialized: Record<string, unknown>[] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row: Record<string, unknown> = {};
      for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
        const { parameter, index } = outputs[outputIndex]!;
        const name = parameter.outputName;
        if (!name) throw new UnsupportedFeatureError("routine.out", "BRAID_CALL_OUT_UNSUPPORTED", `Oracle output parameter ${index + 1} is missing outputName.`);
        const hintType = parameter.hint === undefined ? undefined : normalType(parameter.hint.databaseType);
        let value = values[outputIndex]![rowIndex];
        if (hintType !== undefined && materializedLobType(hintType) && value !== null && value !== undefined && !isMaterializedLobValue(hintType, value)) {
          const lob = lobs.get(value as OracleLobLike);
          if (lob === undefined) throw new UnsupportedFeatureError("routine.out", "BRAID_CALL_LOB_UNSUPPORTED", `Oracle output ${name} did not return a Lob.`);
          value = await materializeLob(lob, hintType, name);
        }
        assertOracleNumericValue(hintType, value);
        setOutputValue(row, name, hintType === undefined ? value : policy.decode(hintType, value));
      }
      materialized.push(row);
    }
    rows = materialized;
  } catch (error) {
    recordFailure(error);
  }
  if (!hasFailure) await cleanupScope.run();
  else await cleanupScope.run(failure);
  return { rows: rows!, rowCount, kind: "rows" };
}

function validateOracleTransactionOptions(transactionOptions?: TransactionOptions): void {
  if (
    transactionOptions !== undefined
    && (transactionOptions === null || typeof transactionOptions !== "object" || Array.isArray(transactionOptions))
  ) {
    const error = new TypeError("BRAID_TX_OPTIONS_INVALID: Oracle transaction options must be an object.");
    Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
    throw error;
  }
  if (transactionOptions !== undefined) {
    const unexpected = Object.keys(transactionOptions).find((key) => key !== "isolation" && key !== "readOnly");
    if (unexpected !== undefined) {
      const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: Unknown Oracle transaction option: ${unexpected}.`);
      Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
      throw error;
    }
  }
  const isolation = transactionOptions?.isolation;
  if (isolation !== undefined
    && isolation !== "read-uncommitted"
    && isolation !== "read-committed"
    && isolation !== "repeatable-read"
    && isolation !== "serializable") {
    const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: Oracle does not recognize transaction isolation ${String(isolation)}.`);
    Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
    throw error;
  }
  if (transactionOptions?.readOnly !== undefined && typeof transactionOptions.readOnly !== "boolean") {
    const error = new TypeError("BRAID_TX_OPTIONS_INVALID: Oracle readOnly must be a boolean.");
    Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
    throw error;
  }
  if (isolation !== undefined && transactionOptions?.readOnly !== undefined) {
    throw new UnsupportedFeatureError(
      `transaction.isolation.${isolation}`,
      "BRAID_TX_OPTION_UNSUPPORTED",
      "Oracle does not support combining isolation and readOnly transaction options.",
    );
  }
  if (isolation === "read-uncommitted" || isolation === "repeatable-read") {
    throw new UnsupportedFeatureError(
      `transaction.isolation.${isolation}`,
      "BRAID_TX_OPTION_UNSUPPORTED",
      `Oracle does not support transaction isolation ${isolation}.`,
    );
  }
}

function makeOracledbExecutor(
  connection: OracleConnectionLike,
  options: Omit<OracleDatabaseOptions, "observers">,
  bindingAdapter: OracleStatementBindingAdapter,
): QueryExecutor {
  const policy = options.typePolicy ?? defaultTypePolicy;
  const driver = options.driver ?? defaultDriver;
  const fetchSize = streamFetchSize(options);
  const control = async (text: string): Promise<void> => { await connection.execute(text, [], executeOptions(options, driver)); };
  const begin = async (transactionOptions?: TransactionOptions): Promise<void> => {
    validateOracleTransactionOptions(transactionOptions);
    const isolation = transactionOptions?.isolation;
    if (isolation === "read-committed") await control("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    else if (isolation === "serializable") await control("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    else if (transactionOptions?.readOnly === true) await control("SET TRANSACTION READ ONLY");
    else if (transactionOptions?.readOnly === false) await control("SET TRANSACTION READ WRITE");
  };
  return {
    ownershipKey: connection,
    statementBinding: bindingAdapter,
    environment: policy === defaultTypePolicy && driver === defaultDriver && oracledb.thin
      ? oracleEnvironment
      : customOracleEnvironment(policy, typeof connection.break === "function"),
    validateTransactionOptions: validateOracleTransactionOptions,
    async bulk(bulk: RenderedBulk, binding: BulkBindingDescription, executionOptions?: ExecutionOptions): Promise<BulkExecutionResult> {
      assertExecutionOptions(connection, executionOptions);
      if (typeof connection.executeMany !== "function") {
        throw new UnsupportedFeatureError("statement.bulk", "BRAID_BULK_UNSUPPORTED", "Oracle connection does not expose executeMany().");
      }
      if (binding.adapterId !== bindingAdapter.id) {
        throw new TypeError(`SQLBraid Oracle executor requires binding adapter "${bindingAdapter.id}".`);
      }
      const materialized = bindingAdapter.materializedBulk(bulk, binding);
      if (materialized === undefined) {
        throw new TypeError("SQLBraid Oracle executor received a bulk binding description not produced by its adapter.");
      }
      const {
        fetchAsString: _fetchAsString,
        fetchAsBuffer: _fetchAsBuffer,
        fetchInfo: _fetchInfo,
        fetchTypeHandler: _fetchTypeHandler,
        outFormat: _outFormat,
        resultSet: _resultSet,
        bindDefs: _bindDefs,
        batchErrors: _batchErrors,
        dmlRowCounts: _dmlRowCounts,
        ...customOptions
      } = options.executeOptions ?? {};
      const result = executionResult(await executeWithCancellation(
        connection,
        () => connection.executeMany!(
          binding.parameterizedSql!,
          materialized.binds,
          {
            ...customOptions,
            bindDefs: materialized.bindDefs,
            batchErrors: false,
            dmlRowCounts: false,
          } satisfies OracleExecuteManyOptionsLike,
        ),
        executionOptions,
      ));
      return {
        inputCount: bulk.parameterSets.length,
        ...(result.rowsAffected === undefined ? {} : { affectedRows: safeDatabaseCount(result.rowsAffected) }),
        executionMode: "native-bulk",
      };
    },
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription, executionOptions?: ExecutionOptions): Promise<QueryExecutionResult<Row>> {
      const execution = executionBinding(bindingAdapter, rendered, binding);
      return executeWithCancellation<QueryExecutionResult<Row>>(connection, async () => {
        const result = executionResult(await connection.execute(
          execution.description.parameterizedSql!,
          execution.binds,
          executeOptions(options, driver),
        ));
        const returning = await normalizeDmlReturning(rendered, result, policy);
        if (returning !== undefined) return returning as QueryExecutionResult<Row>;
        const fields = Array.isArray(result.metaData) ? result.metaData : [];
        assertUniqueFields(fields);
        if (Array.isArray(result.rows)) {
          const rows = result.rows.map((row) => decodeRow(row, fields, policy, driver));
          return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
        }
        const affectedRows = result.rowsAffected === undefined ? undefined : safeDatabaseCount(result.rowsAffected);
        return { rows: [], ...(affectedRows === undefined ? {} : { rowCount: affectedRows }), kind: "command", command: affectedRows === undefined ? {} : { affectedRows } };
      }, executionOptions);
    },
    async call(rendered: RenderedStatement, binding?: StatementBindingDescription, executionOptions?: ExecutionOptions): Promise<DriverRoutineResult> {
      if (rendered.routineProcedure !== undefined) {
        throw new UnsupportedFeatureError(
          "routine.call",
          "BRAID_CALL_UNSUPPORTED",
          "Oracle does not support native routine procedure metadata; author an Oracle PL/SQL call text instead.",
        );
      }
      const execution = executionBinding(bindingAdapter, rendered, binding);
      const parameters = rendered.parameters.map(routineParameter);
      const ordinals = oracleOutputOrdinals(rendered);
      const resultSets: DriverRoutineResult["resultSets"][number][] = [];
      const cleanupScope = createCleanupScope();
      let failure: unknown;
      let hasFailure = false;
      let value: DriverRoutineResult | undefined;
      try {
        await executeWithCancellation(connection, async () => {
          const result = executionResult(await connection.execute(
            execution.description.parameterizedSql!,
            execution.binds,
            executeOptions(options, driver, true),
          ));
          const implicit = Array.isArray(result.implicitResults) ? result.implicitResults : [];
          for (const resource of implicit) cleanupScope.add(() => resource.close());
          if (result.resultSet) cleanupScope.add(() => result.resultSet!.close());
          const explicit = parameters
            .map((parameter, index) => ({ parameter, index, ordinal: ordinals[index], value: ordinals[index] === undefined ? undefined : outBindValue(result.outBinds, ordinals[index]!, parameter.outputName) }))
            .filter(({ ordinal }) => ordinal !== undefined);
          const output: Record<string, unknown> = {};
          const explicitCursors: Array<{ readonly name: string; readonly index: number; readonly resultSet: OracleResultSetLike }> = [];
          let explicitLobs: Map<number, OracleLobLike> | undefined;
          let explicitResourceFailure: unknown;
          let hasExplicitResourceFailure = false;
          let explicitResourceFailureIndex = Number.POSITIVE_INFINITY;
          const recordExplicitResourceFailure = (error: unknown, index: number): void => {
            if (index < explicitResourceFailureIndex) {
              explicitResourceFailure = error;
              hasExplicitResourceFailure = true;
              explicitResourceFailureIndex = index;
            }
          };
          for (let explicitIndex = explicit.length - 1; explicitIndex >= 0; explicitIndex -= 1) {
            const { parameter, index, value } = explicit[explicitIndex]!;
            const name = parameter.outputName;
            const hintType = parameter.hint === undefined ? undefined : normalType(parameter.hint.databaseType);
            const isCursor = hintType === "REF CURSOR" || hintType === "REFCURSOR" || hintType === "SYS_REFCURSOR" || hintType === "CURSOR";
            if (isCursor) {
              if (!name) {
                recordExplicitResourceFailure(new UnsupportedFeatureError("routine.out", "BRAID_CALL_OUT_UNSUPPORTED", `Oracle output parameter ${index + 1} is missing outputName.`), index);
              } else if (!value || typeof value !== "object" || typeof (value as OracleResultSetLike).close !== "function") {
                recordExplicitResourceFailure(new UnsupportedFeatureError("routine.out-cursor", "BRAID_CALL_CURSOR_UNSUPPORTED", `Oracle output ${name} did not return a ResultSet.`), index);
              } else {
                const resultSet = value as OracleResultSetLike;
                explicitCursors.push({ name, index, resultSet });
                cleanupScope.add(() => resultSet.close());
              }
              if (!name && value && typeof value === "object" && typeof (value as OracleResultSetLike).close === "function") {
                cleanupScope.add(() => (value as OracleResultSetLike).close());
              }
              continue;
            }
            if (!materializedLobType(hintType) || value === null || value === undefined) continue;
            if (isMaterializedLobValue(hintType!, value)) continue;
            try {
              const lob = oracleLob(value, name ?? `parameter ${index + 1}`);
              if (lob === undefined) {
                recordExplicitResourceFailure(new UnsupportedFeatureError("routine.out", "BRAID_CALL_LOB_UNSUPPORTED", `Oracle output ${name ?? `parameter ${index + 1}`} did not return a Lob.`), index);
              } else {
                (explicitLobs ??= new Map()).set(index, lob);
                cleanupScope.add(() => closeLob(lob));
              }
            } catch (error) {
              recordExplicitResourceFailure(error, index);
            }
          }
          if (hasExplicitResourceFailure) throw explicitResourceFailure;
          for (const { parameter, index, value } of explicit) {
            const name = parameter.outputName;
            if (!name) throw new UnsupportedFeatureError("routine.out", "BRAID_CALL_OUT_UNSUPPORTED", `Oracle output parameter ${index + 1} is missing outputName.`);
            const hintType = parameter.hint === undefined ? undefined : normalType(parameter.hint.databaseType);
            const isCursor = hintType === "REF CURSOR" || hintType === "REFCURSOR" || hintType === "SYS_REFCURSOR" || hintType === "CURSOR";
            if (isCursor) {
              const resultSet = explicitCursors.find((cursor) => cursor.index === index)!.resultSet;
              resultSets.push({
                rows: await readResultSet(resultSet, driver, policy),
                source: { kind: "out-cursor", name, parameterIndex: index },
              });
            } else {
              const lob = materializedLobType(hintType) ? explicitLobs?.get(index) : undefined;
              const outputValue = lob === undefined ? value : await materializeLob(lob, hintType!, name);
              assertOracleNumericValue(hintType, outputValue);
              setOutputValue(output, name, hintType === undefined ? outputValue : policy.decode(hintType, outputValue));
            }
          }
          for (const [index, resultSet] of implicit.entries()) {
            resultSets.push({
              rows: await readResultSet(resultSet, driver, policy),
              source: { kind: "implicit", index },
            });
          }
          if (result.resultSet) {
            resultSets.push({
              rows: await readResultSet(result.resultSet, driver, policy),
              source: { kind: "emitted", index: 0 },
            });
          } else if (Array.isArray(result.rows)) {
            const fields = Array.isArray(result.metaData) ? result.metaData : [];
            assertUniqueFields(fields);
            resultSets.push({
              rows: result.rows.map((row) => decodeRow(row, fields, policy, driver)),
              source: { kind: "emitted", index: 0 },
            });
          }
          value = { output, resultSets };
        }, executionOptions);
      } catch (error) {
        failure = error;
        hasFailure = true;
      }
      if (!hasFailure) await cleanupScope.run();
      else await cleanupScope.run(failure);
      return value!;
    },
    async *stream<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription, executionOptions?: ExecutionOptions): AsyncGenerator<Row> {
      const execution = executionBinding(bindingAdapter, rendered, binding);
      assertExecutionOptions(connection, executionOptions);
      const signal = executionOptions?.signal;
      const result = executionResult(await executeWithCancellation(
        connection,
        () => connection.execute(execution.description.parameterizedSql!, execution.binds, executeOptions(options, driver, true)),
        executionOptions,
      ));
      const resultSet = result.resultSet;
      if (!resultSet) {
        const implicit = Array.isArray(result.implicitResults) ? result.implicitResults : [];
        const cleanupScope = createCleanupScope();
        for (const resource of implicit) cleanupScope.add(() => resource.close());
        await cleanupScope.run(new UnsupportedFeatureError("statement.stream", "BRAID_STREAM_UNSUPPORTED", "Oracle execute did not return a ResultSet."));
        return;
      }
      const cleanupScope = createCleanupScope();
      cleanupScope.add(() => resultSet!.close());
      for (const resource of Array.isArray(result.implicitResults) ? result.implicitResults : []) cleanupScope.add(() => resource.close());
      let breakFailure: unknown;
      let hasBreakFailure = false;
      let breakPromise: Promise<void> | undefined;
      const abort = (): void => {
        if (breakPromise !== undefined) return;
        try {
          breakPromise = Promise.resolve(connection.break!()).catch((error) => {
            breakFailure = error;
            hasBreakFailure = true;
          });
        } catch (error) {
          breakFailure = error;
          hasBreakFailure = true;
          breakPromise = Promise.resolve();
        }
      }
      let failure: unknown;
      let hasFailure = false;
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const fields = Array.isArray(resultSet.metaData)
          ? resultSet.metaData
          : Array.isArray(result.metaData) ? result.metaData : [];
        assertUniqueFields(fields);
        if (resultSet.getRow) {
          while (true) {
            signal?.throwIfAborted();
            const row = await resultSet.getRow();
            if (row === null || row === undefined) break;
            signal?.throwIfAborted();
            yield decodeRow(row, fields, policy, driver) as Row;
          }
        } else if (resultSet.getRows) {
          while (true) {
            signal?.throwIfAborted();
            const batch = await resultSet.getRows(fetchSize);
            if (batch.length === 0) break;
            for (const row of batch) {
              signal?.throwIfAborted();
              yield decodeRow(row, fields, policy, driver) as Row;
            }
            if (batch.length < fetchSize) break;
          }
        } else if (resultSet[Symbol.asyncIterator]) {
          for await (const row of resultSet as AsyncIterable<unknown>) {
            signal?.throwIfAborted();
            yield decodeRow(row, fields, policy, driver) as Row;
          }
        } else {
          throw new UnsupportedFeatureError("statement.stream", "BRAID_STREAM_UNSUPPORTED", "Oracle ResultSet does not expose getRow or async iteration.");
        }
      } catch (error) {
        failure = error;
        hasFailure = true;
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (breakPromise !== undefined) await breakPromise;
        if (hasBreakFailure) cleanupScope.add(() => { throw breakFailure; });
        const primary = signal?.aborted ? signal.reason : failure;
        if (!hasFailure && signal?.aborted !== true) await cleanupScope.run();
        else await cleanupScope.run(primary);
      }
    },
    begin,
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    savepoint: async (name) => { await control(`SAVEPOINT ${assertSavepointName(name)}`); },
    rollbackTo: async (name) => { await control(`ROLLBACK TO SAVEPOINT ${assertSavepointName(name)}`); },
    // Oracle releases savepoints implicitly; this is a logical runtime boundary.
    releaseSavepoint: async (_name) => undefined,
  };
}

export function createOracledbExecutor(connection: OracleConnectionLike, options: Omit<OracleDatabaseOptions, "observers"> = {}): QueryExecutor {
  assertConnection(connection);
  return makeOracledbExecutor(connection, options, createBinding({
    ...options,
    stmtCacheSize: connection.stmtCacheSize,
  }));
}

export function createOracledbDatabase(connection: OracleConnectionLike, options: OracleDatabaseOptions = {}) {
  const { typePolicy, driver, executeOptions, streamFetchSize, ...databaseOptions } = options;
  return createDatabase(createOracledbExecutor(connection, { typePolicy, driver, executeOptions, streamFetchSize }), databaseOptions);
}

export function createOracledbPoolProvider(pool: OraclePoolLike, options: Omit<OracleDatabaseOptions, "observers"> = {}): ConnectionProvider {
  const bindingAdapter = createBinding({
    ...options,
    stmtCacheSize: pool.stmtCacheSize,
  });
  return {
    statementBinding: bindingAdapter,
    environment: (options.typePolicy === undefined || options.typePolicy === defaultTypePolicy) && (options.driver === undefined || options.driver === defaultDriver) && oracledb.thin
      ? oracleEnvironment
      : customOracleEnvironment(options.typePolicy ?? defaultTypePolicy, true),
    validateTransactionOptions: validateOracleTransactionOptions,
    async acquire(): Promise<ConnectionLease> {
      const connection = await pool.getConnection();
      assertPoolConnection(connection);
      const executor = makeOracledbExecutor(connection, options, bindingAdapter);
      let released = false;
      return {
        ...executor,
        async release(releaseOptions = {}): Promise<void> {
          if (released) return;
          released = true;
          if (releaseOptions.discard === true) await connection.close({ drop: true });
          else await connection.close();
        },
      };
    },
  };
}

export function createOracledbPoolDatabase(pool: OraclePoolLike, options: OracleDatabaseOptions = {}) {
  const { typePolicy, driver, executeOptions, streamFetchSize, ...databaseOptions } = options;
  return createPooledDatabase(createOracledbPoolProvider(pool, { typePolicy, driver, executeOptions, streamFetchSize }), databaseOptions);
}
