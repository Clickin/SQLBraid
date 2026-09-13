import oracledb from "oracledb";
import {
  createStatementBindingDescription,
  type ConnectionLease,
  type ConnectionProvider,
  type DatabaseOptions,
  type ParameterTypeHint,
  type QueryExecutor,
  type QueryExecutionResult,
  type RenderedStatement,
  type RoutineCallResult,
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
  getRow?(): Promise<unknown | null | undefined>;
  getRows?(numRows?: number): Promise<readonly unknown[]>;
  close(): Promise<void> | void;
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>;
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
  readonly CLOB?: unknown;
  readonly NCLOB?: unknown;
  readonly [key: string]: unknown;
}

export interface OracleDatabaseOptions extends DatabaseOptions {
  readonly typePolicy?: TypePolicy;
  readonly driver?: OracleDriverLike;
  readonly executeOptions?: OracleExecuteOptionsLike;
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
  const value = type === "VARCHAR2" ? (driver.DB_TYPE_VARCHAR ?? driver.STRING)
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
    const parameter = rendered.parameters[index]!;
    const value = parameter.value;
    const hint = parameter.hint;
    if (hint === undefined) {
      if (value === null || value === undefined) throw new Error("BRAID_BIND_TYPE_REQUIRED: Oracle null parameters require sql.bind(null, oracleParameter.*).");
      values.push(value);
      continue;
    }
    const databaseType = normalType(hint.databaseType);
    if (hint.length !== undefined || hint.precision !== undefined || hint.scale !== undefined) {
      throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: Oracle driver does not support ${databaseType} bind length, precision, or scale facets.`);
    }
    const encoded = policy.encode(databaseType, value);
    if (databaseType === "NUMBER" && typeof encoded === "string") {
      throw new Error("BRAID_BIND_HINT_UNSUPPORTED: Oracle NUMBER binds do not accept decimal strings with a NUMBER driver type; use bigint/number or an unhinted decimal string.");
    }
    values.push({ dir: driver.BIND_IN, val: encoded, type: typeConstant(databaseType, driver) } satisfies OracleBindLike);
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

function unsupportedCall(): never {
  throw new Error("BRAID_CALL_UNSUPPORTED: Oracle routine calls are unsupported until OUT/IN OUT bind descriptors are available.");
}

function makeOracledbExecutor(
  connection: OracleConnectionLike,
  options: Omit<OracleDatabaseOptions, "observers">,
  bindingAdapter: OracleStatementBindingAdapter,
): QueryExecutor {
  const policy = options.typePolicy ?? defaultTypePolicy;
  const driver = options.driver ?? defaultDriver;
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
    async call<Row>(_rendered: RenderedStatement): Promise<RoutineCallResult<Row>> {
      unsupportedCall();
    },
    async *stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncGenerator<Row> {
      const execution = executionBinding(bindingAdapter, rendered, binding);
      signal?.throwIfAborted();
      const result = executionResult(await connection.execute(execution.description.parameterizedSql!, execution.binds, executeOptions(options, driver, true)));
      const resultSet = result.resultSet;
      if (!resultSet) throw new Error("BRAID_STREAM_UNSUPPORTED: Oracle execute did not return a ResultSet.");
      let closePromise: Promise<void> | undefined;
      let closeFailure: unknown;
      const close = (): Promise<void> => {
        if (closePromise === undefined) closePromise = Promise.resolve(resultSet.close());
        return closePromise;
      };
      const abort = (): void => { void close().catch((error: unknown) => { closeFailure = error; }); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const fields = Array.isArray(result.metaData) ? result.metaData : [];
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
            const batch = await resultSet.getRows(100);
            if (batch.length === 0) break;
            for (const row of batch) {
              signal?.throwIfAborted();
              yield decodeRow(row, fields, policy, driver) as Row;
            }
            if (batch.length < 100) break;
          }
        } else if (resultSet[Symbol.asyncIterator]) {
          for await (const row of resultSet as AsyncIterable<unknown>) {
            signal?.throwIfAborted();
            yield decodeRow(row, fields, policy, driver) as Row;
          }
        } else {
          throw new Error("BRAID_STREAM_UNSUPPORTED: Oracle ResultSet does not expose getRow or async iteration.");
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        await close();
        if (closeFailure !== undefined) throw closeFailure;
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
  const { typePolicy, driver, executeOptions, ...databaseOptions } = options;
  return createDatabase(createOracledbExecutor(connection, { typePolicy, driver, executeOptions }), databaseOptions);
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
  const { typePolicy, driver, executeOptions, ...databaseOptions } = options;
  return createPooledDatabase(createOracledbPoolProvider(pool, { typePolicy, driver, executeOptions }), databaseOptions);
}
