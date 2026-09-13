import oracledb from "oracledb";
import {
  createStatementBindingDescription,
  type ConnectionLease,
  type ConnectionProvider,
  type DatabaseOptions,
  type DriverRoutineResult,
  type ParameterTypeHint,
  type QueryExecutor,
  type QueryExecutionResult,
  type RenderedStatement,
  type StatementBindingAdapter,
  type StatementBindingContext,
  type StatementBindingDescription,
  type TypePolicy,
} from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { typePolicy as defaultTypePolicy } from "./type-policy.js";

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

interface OracleCleanupResource {
  close(): Promise<void> | void;
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
  commit(): Promise<void>;
  rollback(): Promise<void>;
  readonly stmtCacheSize?: number;
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
  readonly STRING?: unknown;
  readonly NUMBER?: unknown;
  readonly DATE?: unknown;
  readonly BUFFER?: unknown;
  readonly BINARY_FLOAT?: unknown;
  readonly BINARY_DOUBLE?: unknown;
  readonly DB_TYPE_VARCHAR?: unknown;
  readonly DB_TYPE_NVARCHAR?: unknown;
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

interface OracleStatementBindingAdapter extends StatementBindingAdapter {
  readonly materializedBinds: (
    statement: RenderedStatement,
    description: StatementBindingDescription,
  ) => readonly unknown[] | undefined;
}

export interface OracledbStatementBindingOptions {
  readonly typePolicy?: TypePolicy;
  readonly driver?: OracleDriverLike;
  readonly executeOptions?: OracleExecuteOptionsLike;
  readonly stmtCacheSize?: number;
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
  if (value === driver.DB_TYPE_VARCHAR || value === driver.STRING) return "VARCHAR2";
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
  return undefined;
}

function decodeRow(value: unknown, fields: readonly OracleMetaDataLike[], policy: TypePolicy, driver: OracleDriverLike): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const row: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.name === key);
    const type = metadataType(field, driver);
    row[key] = type === undefined ? entry : policy.decode(type, entry);
  }
  return row;
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
    if (typeName === "NUMBER" || typeName === "CLOB" || typeName === "NCLOB"
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
    : type === "VARCHAR2" ? (driver.DB_TYPE_VARCHAR ?? driver.STRING)
    : type === "NVARCHAR2" ? driver.DB_TYPE_NVARCHAR
      : type === "NUMBER" ? (driver.DB_TYPE_NUMBER ?? driver.NUMBER)
        : type === "BINARY_FLOAT" ? (driver.DB_TYPE_BINARY_FLOAT ?? driver.BINARY_FLOAT)
          : type === "BINARY_DOUBLE" ? (driver.DB_TYPE_BINARY_DOUBLE ?? driver.BINARY_DOUBLE)
            : type === "DATE" ? (driver.DB_TYPE_DATE ?? driver.DATE)
              : type === "TIMESTAMP" ? driver.DB_TYPE_TIMESTAMP
                : type === "TIMESTAMP WITH TIME ZONE" ? driver.DB_TYPE_TIMESTAMP_TZ
                  : type === "TIMESTAMP WITH LOCAL TIME ZONE" ? driver.DB_TYPE_TIMESTAMP_LTZ
                    : type === "RAW" ? (driver.DB_TYPE_RAW ?? driver.BUFFER)
                      : type === "BLOB" ? (driver.DB_TYPE_BLOB ?? driver.BLOB)
                        : type === "CLOB" ? (driver.DB_TYPE_CLOB ?? driver.CLOB)
                          : type === "NCLOB" ? (driver.DB_TYPE_NCLOB ?? driver.NCLOB)
                            : undefined;
  if (value === undefined) throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: Oracle driver cannot bind explicit type ${databaseType}.`);
  return value;
}

function identifier(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/u.test(name)) throw new Error("BRAID_SAVEPOINT_NAME: Oracle savepoint names must be simple identifiers.");
  return name;
}

function bindValues(rendered: RenderedStatement, policy: TypePolicy, driver: OracleDriverLike): readonly unknown[] {
  const values: unknown[] = [];
  for (let index = 0; index < rendered.parameters.length; index += 1) {
    const parameter = rendered.parameters[index]! as OracleRoutineParameter;
    const value = parameter.value;
    const hint = parameter.hint;
    const direction = parameter.direction ?? "in";
    if (direction !== "in" && rendered.resultKind !== "call") {
      throw new Error("BRAID_CALL_OUT_UNSUPPORTED: OUT and INOUT parameters are legal only for sql.call().");
    }
    if (direction !== "in" && hint === undefined) {
      throw new Error("BRAID_BIND_HINT_UNSUPPORTED: Oracle OUT and INOUT parameters require an explicit type hint.");
    }
    const databaseType = hint === undefined ? undefined : normalType(hint.databaseType);
    const isCursor = databaseType === "REF CURSOR" || databaseType === "REFCURSOR" || databaseType === "SYS_REFCURSOR" || databaseType === "CURSOR";
    if (isCursor && direction === "in") {
      throw new Error("BRAID_CALL_CURSOR_UNSUPPORTED: Oracle REF CURSOR parameters must be OUT or INOUT.");
    }
    if (isCursor) {
      if (hint!.length !== undefined || hint!.precision !== undefined || hint!.scale !== undefined) {
        throw new Error("BRAID_BIND_HINT_UNSUPPORTED: Oracle REF CURSOR does not accept type facets.");
      }
      const cursorType = driver.CURSOR;
      if (cursorType === undefined) throw new Error("BRAID_CALL_CURSOR_UNSUPPORTED: Oracle driver does not expose CURSOR binds.");
      values.push({
        dir: direction === "out" ? driver.BIND_OUT : driver.BIND_INOUT,
        ...(direction === "inout" ? { val: value } : {}),
        type: cursorType,
      } satisfies OracleBindLike);
      continue;
    }
    if (hint === undefined) {
      if (value === null || value === undefined) throw new Error("BRAID_BIND_TYPE_REQUIRED: Oracle null parameters require sql.bind(null, oracleParameter.*).");
      values.push(value);
      continue;
    }
    if (hint.precision !== undefined || hint.scale !== undefined) {
      throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: Oracle bind ${databaseType} does not support precision or scale facets.`);
    }
    if (hint.length !== undefined && (direction === "in" || (databaseType !== "VARCHAR2" && databaseType !== "NVARCHAR2"))) {
      throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: Oracle bind ${databaseType} does not support length facets.`);
    }
    const encoded = direction === "out" ? undefined : policy.encode(databaseType!, value);
    if (databaseType === "NUMBER" && typeof encoded === "string" && direction !== "out") {
      throw new Error("BRAID_BIND_HINT_UNSUPPORTED: Oracle NUMBER binds do not accept decimal strings with a NUMBER driver type; use bigint/number or an unhinted decimal string.");
    }
    values.push({
      dir: direction === "in" ? driver.BIND_IN : direction === "out" ? driver.BIND_OUT : driver.BIND_INOUT,
      ...(direction === "out" ? {} : { val: encoded }),
      type: typeConstant(databaseType!, driver),
      ...(direction !== "in" && hint.length !== undefined
        && (databaseType === "VARCHAR2" || databaseType === "NVARCHAR2")
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
  if (type === "NUMBER" || type === "BINARY_FLOAT" || type === "BINARY_DOUBLE") {
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

function createBinding(options: OracledbStatementBindingOptions = {}): OracleStatementBindingAdapter {
  const policy = options.typePolicy ?? defaultTypePolicy;
  const driver = options.driver ?? defaultDriver;
  const effectiveReuse = options.executeOptions?.keepInStmtCache === false || options.stmtCacheSize === 0 ? "simple" : "reuse";
  const encodedBinds = new WeakMap<StatementBindingDescription, { readonly statement: RenderedStatement; readonly binds: readonly unknown[] }>();
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
    materializedBinds(statement: RenderedStatement, description: StatementBindingDescription): readonly unknown[] | undefined {
      const materialized = encodedBinds.get(description);
      return materialized?.statement === statement ? materialized.binds : undefined;
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
    ...(driver.OUT_FORMAT_OBJECT === undefined ? {} : { outFormat: driver.OUT_FORMAT_OBJECT }),
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

function cleanupError(cause: unknown, failures: readonly unknown[]): Error | undefined {
  if (failures.length === 0) return cause instanceof Error ? cause : cause === undefined ? undefined : new Error(String(cause), { cause });
  const values = cause === undefined ? [...failures] : [cause, ...failures];
  const error = new AggregateError(values, "BRAID_RESOURCE_CLEANUP: Oracle ResultSet cleanup failed.", { cause: cause ?? failures[0] });
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
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
    throw new Error(`BRAID_CALL_LOB_UNSUPPORTED: Oracle output ${name} did not return a Lob with the documented destroy() stream API.`);
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
  throw new TypeError(`BRAID_CALL_LOB_UNSUPPORTED: Oracle output ${name} did not return ${expected} Lob data.`);
}

async function closeAllResources(resources: readonly OracleCleanupResource[], cause?: unknown): Promise<Error | undefined> {
  const failures: unknown[] = [];
  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      failures.push(error);
    }
  }
  return cleanupError(cause, failures);
}

function routineParameter(parameter: unknown): OracleRoutineParameter {
  return parameter as OracleRoutineParameter;
}

function outBindValue(outBinds: unknown, index: number): unknown {
  if (Array.isArray(outBinds)) return outBinds[index];
  if (outBinds && typeof outBinds === "object") {
    const object = outBinds as Record<string, unknown>;
    return object[String(index + 1)] ?? object[`p${index + 1}`] ?? object[index];
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
  throw new Error("BRAID_CALL_CURSOR_UNSUPPORTED: Oracle ResultSet does not expose getRows, getRow, or async iteration.");
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
  return {
    ownershipKey: connection,
    statementBinding: bindingAdapter,
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      const execution = executionBinding(bindingAdapter, rendered, binding);
      const result = executionResult(await connection.execute(execution.description.parameterizedSql!, execution.binds, executeOptions(options, driver)));
      const fields = Array.isArray(result.metaData) ? result.metaData : [];
      assertUniqueFields(fields);
      if (Array.isArray(result.rows)) {
        const rows = result.rows.map((row) => decodeRow(row, fields, policy, driver));
        return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
      }
      return { rows: [], rowCount: result.rowsAffected, kind: "command", command: { affectedRows: result.rowsAffected } };
    },
    async call(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<DriverRoutineResult> {
      if (rendered.routineProcedure !== undefined) {
        throw new Error("BRAID_CALL_UNSUPPORTED: Oracle does not support native routine procedure metadata; author an Oracle PL/SQL call text instead.");
      }
      const execution = executionBinding(bindingAdapter, rendered, binding);
      const parameters = rendered.parameters.map(routineParameter);
      const resultSets: DriverRoutineResult["resultSets"][number][] = [];
      const resources: OracleCleanupResource[] = [];
      let failure: unknown;
      let value: DriverRoutineResult | undefined;
      try {
        const result = executionResult(await connection.execute(
          execution.description.parameterizedSql!,
          execution.binds,
          executeOptions(options, driver, true),
        ));
        const implicit = Array.isArray(result.implicitResults) ? result.implicitResults : [];
        resources.push(...implicit);
        if (result.resultSet) resources.push(result.resultSet);
        const explicit = parameters
          .map((parameter, index) => ({ parameter, index, value: outBindValue(result.outBinds, index) }))
          .filter(({ parameter }) => (parameter.direction ?? "in") !== "in");
        const output: Record<string, unknown> = {};
        const explicitCursors: Array<{ readonly name: string; readonly index: number; readonly resultSet: OracleResultSetLike }> = [];
        let explicitLobs: Map<number, OracleLobLike> | undefined;
        let explicitResourceFailure: unknown;
        for (const { parameter, index, value } of explicit) {
          const name = parameter.outputName;
          const hintType = parameter.hint === undefined ? undefined : normalType(parameter.hint.databaseType);
          const isCursor = hintType === "REF CURSOR" || hintType === "REFCURSOR" || hintType === "SYS_REFCURSOR" || hintType === "CURSOR";
          if (isCursor) {
            if (!name) {
              explicitResourceFailure ??= new Error(`BRAID_CALL_OUT_UNSUPPORTED: Oracle output parameter ${index + 1} is missing outputName.`);
            } else if (!value || typeof value !== "object" || typeof (value as OracleResultSetLike).close !== "function") {
              explicitResourceFailure ??= new Error(`BRAID_CALL_CURSOR_UNSUPPORTED: Oracle output ${name} did not return a ResultSet.`);
            } else {
              const resultSet = value as OracleResultSetLike;
              explicitCursors.push({ name, index, resultSet });
              resources.push(resultSet);
            }
            if (!name && value && typeof value === "object" && typeof (value as OracleResultSetLike).close === "function") {
              resources.push(value as OracleResultSetLike);
            }
            continue;
          }
          if (!materializedLobType(hintType) || value === null || value === undefined) continue;
          if (isMaterializedLobValue(hintType!, value)) continue;
          try {
            const lob = oracleLob(value, name ?? `parameter ${index + 1}`);
            if (lob === undefined) {
              explicitResourceFailure ??= new Error(`BRAID_CALL_LOB_UNSUPPORTED: Oracle output ${name ?? `parameter ${index + 1}`} did not return a Lob.`);
            } else {
              (explicitLobs ??= new Map()).set(index, lob);
              resources.push({ close: () => closeLob(lob) });
            }
          } catch (error) {
            explicitResourceFailure ??= error;
          }
        }
        if (explicitResourceFailure !== undefined) throw explicitResourceFailure;
        for (const { parameter, index, value } of explicit) {
          const name = parameter.outputName;
          if (!name) throw new Error(`BRAID_CALL_OUT_UNSUPPORTED: Oracle output parameter ${index + 1} is missing outputName.`);
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
      } catch (error) {
        failure = error;
      }
      const cleanup = await closeAllResources(resources, failure);
      if (cleanup !== undefined) throw cleanup;
      if (failure !== undefined) throw failure;
      return value!;
    },
    async *stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncGenerator<Row> {
      const execution = executionBinding(bindingAdapter, rendered, binding);
      signal?.throwIfAborted();
      const result = executionResult(await connection.execute(execution.description.parameterizedSql!, execution.binds, executeOptions(options, driver, true)));
      const resultSet = result.resultSet;
      if (!resultSet) {
        const implicit = Array.isArray(result.implicitResults) ? result.implicitResults : [];
        const cleanup = await closeAllResources(implicit);
        if (cleanup !== undefined) throw cleanup;
        throw new Error("BRAID_STREAM_UNSUPPORTED: Oracle execute did not return a ResultSet.");
      }
      const resources = [resultSet, ...(Array.isArray(result.implicitResults) ? result.implicitResults : [])];
      let closePromise: Promise<Error | undefined> | undefined;
      const close = (): Promise<Error | undefined> => {
        if (closePromise === undefined) closePromise = closeAllResources(resources);
        return closePromise;
      };
      const abort = (): void => { void close(); };
      let failure: unknown;
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
          throw new Error("BRAID_STREAM_UNSUPPORTED: Oracle ResultSet does not expose getRow or async iteration.");
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        const earlyCleanup = await close();
        if (failure !== undefined && earlyCleanup !== undefined) {
          const failures = earlyCleanup instanceof AggregateError ? earlyCleanup.errors : [earlyCleanup];
          throw cleanupError(failure, failures);
        }
        if (earlyCleanup !== undefined) throw earlyCleanup;
      }
    },
    begin: async () => undefined,
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    savepoint: async (name) => { await control(`SAVEPOINT ${identifier(name)}`); },
    rollbackTo: async (name) => { await control(`ROLLBACK TO SAVEPOINT ${identifier(name)}`); },
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
