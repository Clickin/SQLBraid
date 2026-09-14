import { Buffer } from "node:buffer";
import { ISOLATION_LEVEL, Request, TYPES } from "tedious";
import type {
  ConnectionLease,
  ConnectionProvider,
  DatabaseOptions,
  DriverRoutineResult,
  DriverEnvironment,
  BulkBindingDescription,
  BulkExecutionResult,
  ParameterTypeHint,
  QueryExecutor,
  QueryExecutionResult,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
  TypePolicy,
} from "@sqlbraid/core";
import { createBulkBindingDescription, createRenderedStatement, createStatementBindingDescription } from "@sqlbraid/core";
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
  once?(event: string, listener: (...args: any[]) => void): this;
  removeListener?(event: string, listener: (...args: any[]) => void): this;
  addParameter(name: string, type: unknown, value?: unknown, options?: { readonly length?: number; readonly precision?: number; readonly scale?: number }): void;
  addOutputParameter?(name: string, type: unknown, value?: unknown, options?: { readonly length?: number; readonly precision?: number; readonly scale?: number }): void;
  cancel?(): void;
  pause?(): void;
  resume?(): void;
}

export interface TediousConnectionLike {
  execSql(request: TediousRequestLike): void;
  prepare?(request: TediousRequestLike): void;
  execute?(request: TediousRequestLike, parameters: Record<string, unknown>): void;
  unprepare?(request: TediousRequestLike): void;
  callProcedure?(request: TediousRequestLike): void;
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

interface TediousMaterializedParameter {
  readonly name: string;
  readonly databaseType: DatabaseType;
  readonly type: unknown;
  readonly value: unknown;
  readonly options?: { readonly length?: number; readonly precision?: number; readonly scale?: number };
  readonly direction: "in" | "out" | "inout";
  readonly outputName?: string;
}

interface TediousStatementBindingAdapter extends StatementBindingAdapter {
  readonly materializedParameters: (
    statement: RenderedStatement,
    description: StatementBindingDescription,
  ) => readonly TediousMaterializedParameter[] | undefined;
  readonly materializedBulkParameters: (
    bulk: RenderedBulk,
    description: BulkBindingDescription,
  ) => readonly (readonly TediousMaterializedParameter[])[] | undefined;
}

export interface TediousStatementBindingOptions {
  readonly typePolicy?: TypePolicy;
}

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
  if (value === "cursor" || value === "cursorvarying" || value === "refcursor") {
    throw new Error("BRAID_CALL_CURSOR_UNSUPPORTED: SQL Server cursor output parameters are not application result cursors.");
  }
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

function resourceCleanupError(cause: unknown, cleanupFailures: readonly unknown[]): Error {
  const values = cause === undefined ? cleanupFailures : [cause, ...cleanupFailures];
  const error = new AggregateError(values, "BRAID_RESOURCE_CLEANUP: SQL Server request cleanup failed.", { cause: cause ?? cleanupFailures[0] });
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function setOutputValue(output: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(output, name, { value, enumerable: true, configurable: true, writable: true });
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
  readonly returnValue?: number;
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

function materializeParameter(
  index: number,
  actualValue: unknown,
  actualHint: ParameterTypeHint | undefined,
  policy: TypePolicy,
  direction: "in" | "out" | "inout" = "in",
  outputName?: string,
): TediousMaterializedParameter {
  if (direction !== "in" && actualHint === undefined) {
    throw new TypeError("BRAID_BIND_HINT_UNSUPPORTED: SQL Server OUTPUT and INOUT parameters require an explicit type hint.");
  }
  if (direction === "in" && actualValue === undefined) throw new TypeError("BRAID_BIND_TYPE_REQUIRED: undefined is not a SQL Server parameter value.");
  const inferred = direction === "in" && actualHint === undefined ? inferType(actualValue) : undefined;
  const type = actualHint === undefined ? inferred!.type : typeForHint(actualHint);
  const input = direction === "out" ? undefined : actualHint === undefined ? inferred!.value : actualValue;
  let encoded = direction === "out" ? undefined : policy.encode(type, input);
  if (direction !== "out" && (type === "decimal" || type === "numeric")) encoded = decimalInput(encoded);
  if (direction !== "out" && (type === "varbinary" || type === "binary") && encoded instanceof Uint8Array && !Buffer.isBuffer(encoded)) encoded = Buffer.from(encoded);
  const options: { length?: number; precision?: number; scale?: number } = {};
  if (actualHint?.length !== undefined) options.length = actualHint.length === "max" ? Infinity : actualHint.length;
  if (actualHint?.precision !== undefined) options.precision = actualHint.precision;
  if (actualHint?.scale !== undefined) options.scale = actualHint.scale;
  const tediousType = TYPES[typeNames[type] as keyof typeof TYPES];
  if (!tediousType) throw new Error(`BRAID_BIND_HINT_UNSUPPORTED: Tedious does not expose SQL Server type ${type}.`);
  // Tedious repeats this validation from Request just before sending. Run the
  // collation-independent part here so bad values fail before a pooled lease
  // is acquired. Text encoding is checked for its stable JS shape here; any
  // collation-dependent details remain in Tedious.
  if (direction === "out") {
    // Tedious validates the output value when the server sends it.
  } else if (type === "nvarchar" || type === "varchar" || type === "char") {
    if (encoded !== null && typeof encoded !== "string") {
      throw new TypeError(`BRAID_BIND_TYPE_REQUIRED: invalid SQL Server ${type} parameter: expected a string.`);
    }
  } else {
    const validate = (tediousType as { readonly validate?: (value: unknown, collation?: unknown) => unknown }).validate;
    if (typeof validate === "function") {
      try {
        encoded = validate(encoded);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new TypeError(`BRAID_BIND_TYPE_REQUIRED: invalid SQL Server ${type} parameter: ${detail}`, { cause: error });
      }
    }
  }
  return {
    name: `p${index}`,
    databaseType: type,
    type: tediousType,
    value: encoded,
    direction,
    ...(outputName === undefined ? {} : { outputName }),
    ...(Object.keys(options).length === 0 ? {} : { options }),
  };
}

function addParameter(request: TediousRequestLike, parameter: TediousMaterializedParameter): void {
  if (parameter.direction === "in") {
    request.addParameter(parameter.name, parameter.type, parameter.value, parameter.options);
    return;
  }
  if (typeof request.addOutputParameter !== "function") {
    throw new Error("BRAID_CALL_OUT_UNSUPPORTED: Tedious Request does not expose addOutputParameter().");
  }
  request.addOutputParameter(
    parameter.name,
    parameter.type,
    parameter.direction === "inout" ? parameter.value : undefined,
    parameter.options,
  );
}

function tediousLiteralValue(
  value: unknown,
  databaseType: DatabaseType,
  binary: "summary" | "full" | undefined = "summary",
): string {
  if (value === null || value === undefined) return "NULL";
  if (databaseType === "int" || databaseType === "bigint" || databaseType === "decimal" || databaseType === "numeric" || databaseType === "float") {
    if (typeof value === "bigint") return value.toString(10);
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "[unsupported numeric value]";
    if (typeof value === "string" && /^-?(?:\d+)(?:\.\d+)?$/u.test(value)) return value;
    return "[unsupported numeric value]";
  }
  if (databaseType === "bit") {
    if (typeof value === "boolean") return value ? "1" : "0";
    if (value === 0 || value === 1) return String(value);
    return "[unsupported bit value]";
  }
  if (databaseType === "nvarchar" || databaseType === "varchar" || databaseType === "char" || databaseType === "uniqueidentifier") {
    return typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : "[unsupported string value]";
  }
  if (databaseType === "date" || databaseType === "datetime2" || databaseType === "datetimeoffset") {
    return value instanceof Date && Number.isFinite(Date.prototype.getTime.call(value))
      ? `'${Date.prototype.toISOString.call(value)}'`
      : "[unsupported date]";
  }
  if (value instanceof Uint8Array) {
    if (binary !== "full") return `<binary ${value.byteLength} bytes>`;
    return `0x${Buffer.from(value).toString("hex").toUpperCase()}`;
  }
  return typeof value === "object" ? "[unsupported object]" : `[unsupported ${typeof value}]`;
}

function createBinding(options: TediousStatementBindingOptions = {}): TediousStatementBindingAdapter {
  const policy = options.typePolicy ?? defaultTypePolicy;
  const materialized = new WeakMap<StatementBindingDescription, { readonly statement: RenderedStatement; readonly parameters: readonly TediousMaterializedParameter[] }>();
  const materializedBulks = new WeakMap<BulkBindingDescription, { readonly bulk: RenderedBulk; readonly parameters: readonly (readonly TediousMaterializedParameter[])[] }>();
  const adapter: TediousStatementBindingAdapter = {
    id: "tedious",
    describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
      const outputNames = new Set<string>();
      const parameters = statement.parameters.map((parameter, index) => {
        const direction = parameter.direction ?? "in";
        if (direction !== "in" && statement.resultKind !== "call") {
          throw new Error("BRAID_CALL_OUT_UNSUPPORTED: OUT and INOUT parameters are legal only for sql.call().");
        }
        if (direction !== "in") {
          if (!parameter.outputName) throw new Error("BRAID_CALL_OUT_UNSUPPORTED: OUT and INOUT parameters require outputName.");
          if (outputNames.has(parameter.outputName)) throw new Error(`BRAID_CALL_OUT_UNSUPPORTED: duplicate outputName ${parameter.outputName}.`);
          outputNames.add(parameter.outputName);
        }
        return materializeParameter(index + 1, parameter.value, parameter.hint, policy, direction, parameter.outputName);
      });
      const description = createStatementBindingDescription(statement, context, {
        adapterId: "tedious",
        transport: "typed-request",
        placeholder: (index) => `@p${index}`,
        reuse: {
          effective: "simple",
          owner: "driver",
        },
        formatLiteral: (_parameter, index, literalOptions) => tediousLiteralValue(
          parameters[index]?.value,
          parameters[index]?.databaseType ?? "nvarchar",
          literalOptions.binary,
        ),
      });
      materialized.set(description, { statement, parameters });
      return description;
    },
    describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
      const statement = createRenderedStatement(bulk.statement);
      if (statement.resultKind !== "command") throw new Error("BRAID_BULK_SHAPE: SQL Server bulk requires command queries.");
      if (statement.parameters.some((parameter) => (parameter.direction ?? "in") !== "in")) {
        throw new Error("BRAID_BULK_SHAPE: SQL Server bulk does not support OUT or INOUT parameters.");
      }
      const canonicalParameters = statement.parameters.map((parameter, index) =>
        materializeParameter(index + 1, parameter.value, parameter.hint, policy),
      );
      const encodedRows = bulk.parameterSets.map((values) => {
        if (values.length !== statement.parameters.length) throw new Error("BRAID_BULK_SHAPE: SQL Server bulk parameter cardinality changed.");
        return values.map((value, index) => {
          const parameter = statement.parameters[index]!;
          const materializedParameter = materializeParameter(index + 1, value, parameter.hint, policy);
          const canonical = canonicalParameters[index]!;
          if (materializedParameter.databaseType !== canonical.databaseType) {
            throw new Error(`BRAID_BULK_SHAPE: SQL Server bulk parameter ${index + 1} changed inferred type from ${canonical.databaseType} to ${materializedParameter.databaseType}.`);
          }
          return materializedParameter;
        });
      });
      const description = createBulkBindingDescription(bulk, context, {
        adapterId: "tedious",
        transport: "typed-request",
        placeholder: (index) => `@p${index}`,
        reuse: { effective: "reuse", owner: "driver" },
        formatLiteral: (_parameter, index, literalOptions) => tediousLiteralValue(
          encodedRows[0]?.[index]?.value,
          encodedRows[0]?.[index]?.databaseType ?? "nvarchar",
          literalOptions.binary,
        ),
      });
      materializedBulks.set(description, { bulk, parameters: encodedRows });
      return description;
    },
    materializedParameters(statement: RenderedStatement, description: StatementBindingDescription): readonly TediousMaterializedParameter[] | undefined {
      const prepared = materialized.get(description);
      return prepared?.statement === statement ? prepared.parameters : undefined;
    },
    materializedBulkParameters(bulk: RenderedBulk, description: BulkBindingDescription): readonly (readonly TediousMaterializedParameter[])[] | undefined {
      const prepared = materializedBulks.get(description);
      return prepared?.bulk === bulk ? prepared.parameters : undefined;
    },
  };
  return Object.freeze(adapter);
}

export function createTediousStatementBinding(options: TediousStatementBindingOptions = {}): StatementBindingAdapter {
  return createBinding(options);
}

/** Default adapter for callers that do not supply a custom type policy. */
export const tediousStatementBinding: StatementBindingAdapter = createTediousStatementBinding();

function executionBinding(
  adapter: TediousStatementBindingAdapter,
  statement: RenderedStatement,
  description: StatementBindingDescription | undefined,
): { readonly description: StatementBindingDescription; readonly parameters: readonly TediousMaterializedParameter[] } {
  const binding = description ?? adapter.describe(statement, {
    dialectId: statement.dialectId,
    requestedReuse: "auto",
  });
  if (binding.adapterId !== adapter.id) {
    throw new TypeError(`SQLBraid Tedious executor requires binding adapter "${adapter.id}".`);
  }
  const parameters = adapter.materializedParameters(statement, binding);
  if (parameters === undefined) {
    throw new TypeError("SQLBraid Tedious executor received a binding description not produced by its adapter.");
  }
  return { description: binding, parameters };
}

function collect(
  connection: TediousConnectionLike,
  parameterizedSql: string,
  parameters: readonly TediousMaterializedParameter[],
  policy: TypePolicy,
  routineProcedure?: { readonly name: string; readonly parameterNames: readonly string[] },
): Promise<CollectedResult> {
  return new Promise<CollectedResult>((resolve, reject) => {
    let request: TediousRequestLike | undefined;
    let callbackError: unknown;
    let eventError: unknown;
    let cleanupFailure: unknown;
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
    let procedureReturnValue: number | undefined;
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
          cleanupFailure = cleanupFailure ?? cancelError;
        }
      }
      finish();
    };
    const finish = (): void => {
      if (!completed || settled) return;
      settled = true;
      const error = asError(eventError ?? callbackError);
      if (error !== undefined) {
        reject(cleanupFailure === undefined ? error : resourceCleanupError(error, [cleanupFailure]));
        return;
      }
      if (cleanupFailure !== undefined) {
        reject(resourceCleanupError(undefined, [cleanupFailure]));
        return;
      }
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
        ...(routineProcedure === undefined || procedureReturnValue === undefined ? {} : { returnValue: procedureReturnValue }),
      });
    };
    try {
      const requestParameters = routineProcedure === undefined
        ? parameters
        : parameters.map((parameter, index) => ({ ...parameter, name: routineProcedure.parameterNames[index]! }));
      request = new Request(routineProcedure?.name ?? parameterizedSql, ((error: unknown, rowCount?: number) => {
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
        if (typeof name === "string") {
          try {
            const parameter = requestParameters.find((candidate) => candidate.name === name);
            const outputName = parameter?.outputName ?? name;
            setOutputValue(output, outputName, parameter === undefined ? value : policy.decode(parameter.databaseType, value));
          } catch (error) {
            fail(error);
          }
        }
      });
      request.on("doneProc", (_rowCount: unknown, _more: unknown, status: unknown) => {
        if (routineProcedure !== undefined && typeof status === "number") procedureReturnValue = status;
      });
      request.on("error", (error: unknown) => { fail(error); });
      request.on("requestCompleted", () => { completed = true; finish(); });
      for (const parameter of requestParameters) addParameter(request, parameter);
      started = true;
      if (routineProcedure !== undefined) {
        if (typeof connection.callProcedure !== "function") throw new Error("BRAID_CALL_RETURN_UNSUPPORTED: Tedious connection does not expose callProcedure().");
        connection.callProcedure(request);
      } else {
        connection.execSql(request);
      }
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

function rollbackTo(connection: TediousConnectionLike, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const request = new Request(`ROLLBACK TRANSACTION [${name.replaceAll("]", "]]")}]`, () => resolve()) as unknown as TediousRequestLike;
      connection.execSql(request);
    } catch (error) {
      reject(error);
    }
  });
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

function assertNativeProcedureStatement(rendered: RenderedStatement): void {
  if (rendered.routineProcedure === undefined) return;
  if (rendered.routineProcedure.parameterNames.length !== rendered.parameters.length) {
    throw new Error("BRAID_CALL_RETURN_UNSUPPORTED: native procedure parameterNames must match the rendered parameter count.");
  }
  if (rendered.segments.some((segment) => !/^[\s,]*$/u.test(segment))) {
    throw new Error("BRAID_CALL_RETURN_UNSUPPORTED: native procedure calls cannot include authored SQL text; use only argument placeholders separated by commas.");
  }
}

const DEFAULT_MAX_BUFFERED_ROWS = 32;

function streamRows(
  connection: TediousConnectionLike,
  parameterizedSql: string,
  parameters: readonly TediousMaterializedParameter[],
  policy: TypePolicy,
  maxBufferedRows: number,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const max = Number.isSafeInteger(maxBufferedRows) && maxBufferedRows > 0 ? maxBufferedRows : DEFAULT_MAX_BUFFERED_ROWS;
  return (async function* (): AsyncGenerator<Record<string, unknown>> {
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<() => void> = [];
    let request: TediousRequestLike | undefined;
    let done = false;
    let failure: unknown;
    let cleanupFailure: unknown;
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
        cleanupFailure = cleanupFailure ?? error;
        failure = failure ?? error;
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
        request = new Request(parameterizedSql, ((error: unknown) => {
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
        for (const parameter of parameters) addParameter(request, parameter);
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
      if (cleanupFailure !== undefined) {
        throw resourceCleanupError(failure, [cleanupFailure]);
      }
    }
  })();
}

interface TediousPreparedRequest {
  readonly request: TediousRequestLike & { error: unknown };
  readonly parameters: readonly TediousMaterializedParameter[];
  readonly setCompletionCallback: (callback: TediousRequestCompletionCallback | undefined) => void;
}

type TediousRequestCompletionCallback = (error: unknown, rowCount?: number) => void;

const tediousEnvironment = Object.freeze<DriverEnvironment>({
  database: { product: "mssql" },
  driver: { id: "tedious", profile: "typed-request" },
  capabilities: {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": { status: "guarded", canonical: "bigint", rawRepresentations: ["bigint", "string", "number"], conditionCode: "tedious.exact-numeric-profile" },
    "numeric.exact-decimal": { status: "unsupported", rawRepresentations: ["number"] },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
  },
  probe: {
    statement: createRenderedStatement({
      segments: ["SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition"],
      parameters: [],
      resultKind: "rows",
      dialectId: "mssql",
    }),
    read: (rows) => {
      const row = rows[0];
      if (!row || typeof row !== "object" || Array.isArray(row)) return {};
      const record = row as Record<string, unknown>;
      return {
        ...(typeof record.version === "string" ? { version: record.version } : {}),
        ...(typeof record.edition === "string" ? { edition: record.edition } : {}),
      };
    },
  },
});

function prepareRequest(
  connection: TediousConnectionLike,
  sql: string,
  parameters: readonly TediousMaterializedParameter[],
): Promise<TediousPreparedRequest> {
  if (typeof connection.prepare !== "function" || typeof connection.execute !== "function" || typeof connection.unprepare !== "function") {
    return Promise.reject(new Error("BRAID_BULK_UNSUPPORTED: Tedious connection does not expose prepare/execute/unprepare()."));
  }
  const prepare = connection.prepare;
  return new Promise((resolve, reject) => {
    let settled = false;
    let completionCallback: TediousRequestCompletionCallback | undefined;
    const request = new Request(sql, ((error: unknown, rowCount?: number) => {
      completionCallback?.(error, rowCount);
    })) as unknown as TediousPreparedRequest["request"];
    const prepared = (error?: unknown): void => {
      if (settled) return;
      if (error !== undefined && error !== null) {
        settled = true;
        request.removeListener?.("prepared", prepared);
        request.removeListener?.("error", failed);
        reject(error);
        return;
      }
      settled = true;
      request.removeListener?.("prepared", prepared);
      request.removeListener?.("error", failed);
      resolve({
        request,
        parameters,
        setCompletionCallback(callback) {
          completionCallback = callback;
        },
      });
    };
    const failed = (error: unknown): void => {
      if (settled) return;
      settled = true;
      request.removeListener?.("prepared", prepared);
      request.removeListener?.("error", failed);
      reject(asError(error) ?? new Error("SQL Server prepare failed."));
    };
    request.on("prepared", prepared);
    request.on("error", failed);
    try {
      for (const parameter of parameters) request.addParameter(parameter.name, parameter.type, undefined, parameter.options);
      prepare.call(connection, request);
    } catch (error) {
      failed(error);
    }
  });
}

function executePrepared(
  connection: TediousConnectionLike,
  prepared: TediousPreparedRequest,
  parameters: readonly TediousMaterializedParameter[],
): Promise<number | undefined> {
  if (typeof connection.execute !== "function") return Promise.reject(new Error("BRAID_BULK_UNSUPPORTED: Tedious connection does not expose execute()."));
  const execute = connection.execute;
  const values = Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.value]));
  return new Promise((resolve, reject) => {
    let settled = false;
    let completed = false;
    let callbackError: unknown;
    let eventError: unknown;
    let callbackRowCount: number | undefined;
    let rowBearing = false;
    const doneRows: number[] = [];
    const doneInProcRows: number[] = [];
    const doneProcRows: number[] = [];
    const markRows = (): void => { rowBearing = true; };
    const markDone = (target: number[], count?: unknown): void => { if (typeof count === "number") target.push(count); };
    const markDoneRows = (count?: unknown): void => markDone(doneRows, count);
    const markDoneInProcRows = (count?: unknown): void => markDone(doneInProcRows, count);
    const markDoneProcRows = (count?: unknown): void => markDone(doneProcRows, count);
    const finish = (): void => {
      if (settled || !completed) return;
      settled = true;
      prepared.setCompletionCallback(undefined);
      prepared.request.removeListener?.("error", failed);
      prepared.request.removeListener?.("requestCompleted", complete);
      prepared.request.removeListener?.("columnMetadata", markRows);
      prepared.request.removeListener?.("row", markRows);
      prepared.request.removeListener?.("done", markDoneRows);
      prepared.request.removeListener?.("doneInProc", markDoneInProcRows);
      prepared.request.removeListener?.("doneProc", markDoneProcRows);
      const error = asError(callbackError ?? eventError);
      if (error !== undefined && error !== null) reject(error);
      else if (rowBearing) reject(new Error("BRAID_BULK_RESULT_KIND: SQL Server bulk command returned rows."));
      else {
        const counts = doneInProcRows.length > 0 ? doneInProcRows : doneRows.length > 0 ? doneRows : doneProcRows;
        resolve(counts.length > 0 ? counts.reduce((total, value) => total + value, 0) : callbackRowCount);
      }
    };
    const complete = (): void => {
      completed = true;
      finish();
    };
    const callback = (error: unknown, rowCount?: number): void => {
      callbackError = error;
      callbackRowCount = rowCount;
      finish();
    };
    const failed = (error: unknown): void => {
      eventError = error;
      finish();
    };
    prepared.request.on("columnMetadata", markRows);
    prepared.request.on("row", markRows);
    prepared.request.on("done", markDoneRows);
    prepared.request.on("doneInProc", markDoneInProcRows);
    prepared.request.on("doneProc", markDoneProcRows);
    prepared.request.on("error", failed);
    if (typeof prepared.request.once === "function") prepared.request.once("requestCompleted", complete);
    else prepared.request.on("requestCompleted", complete);
    prepared.setCompletionCallback(callback);
    try {
      execute.call(connection, prepared.request, values);
    } catch (error) {
      callbackError ??= error;
      completed = true;
      finish();
    }
  });
}

function unprepareRequest(connection: TediousConnectionLike, prepared: TediousPreparedRequest): Promise<void> {
  if (typeof connection.unprepare !== "function") return Promise.reject(new Error("BRAID_BULK_UNSUPPORTED: Tedious connection does not expose unprepare()."));
  const unprepare = connection.unprepare;
  return new Promise((resolve, reject) => {
    let settled = false;
    let completed = false;
    let callbackError: unknown;
    let eventError: unknown;
    const finish = (): void => {
      if (settled || !completed) return;
      settled = true;
      prepared.setCompletionCallback(undefined);
      prepared.request.removeListener?.("error", failed);
      prepared.request.removeListener?.("requestCompleted", complete);
      const error = asError(callbackError ?? eventError);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const complete = (): void => {
      completed = true;
      finish();
    };
    const callback = (error: unknown): void => {
      callbackError = error;
      finish();
    };
    const failed = (error: unknown): void => {
      eventError = error;
      finish();
    };
    try {
      prepared.request.on("error", failed);
      if (prepared.request.once) prepared.request.once("requestCompleted", complete);
      else prepared.request.on("requestCompleted", complete);
      prepared.setCompletionCallback(callback);
      // Tedious retains the prior execute error on a reused Request.
      prepared.request.error = undefined;
      unprepare.call(connection, prepared.request);
    } catch (error) {
      callbackError ??= error;
      completed = true;
      finish();
    }
  });
}

function makeTediousExecutor(
  connection: TediousConnectionLike,
  options: TediousExecutorOptions = {},
  bindingAdapter: TediousStatementBindingAdapter = createBinding(options),
): QueryExecutor {
  const policy = options.typePolicy ?? defaultTypePolicy;
  const maxBufferedRows = options.maxBufferedRows ?? DEFAULT_MAX_BUFFERED_ROWS;
  return {
    ownershipKey: connection,
    statementBinding: bindingAdapter,
    environment: policy === defaultTypePolicy ? tediousEnvironment : { ...tediousEnvironment, driver: { id: "tedious", profile: "custom-type-policy" }, capabilities: {} },
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      const execution = executionBinding(bindingAdapter, rendered, binding);
      const result = await collect(connection, execution.description.parameterizedSql!, execution.parameters, policy);
      if (result.outputSeen) throw new Error("BRAID_CALL_OUT_UNSUPPORTED: SQL Server output parameters are not implemented.");
      return rowResult(result) as QueryExecutionResult<Row>;
    },
    async bulk(bulk: RenderedBulk, binding: BulkBindingDescription): Promise<BulkExecutionResult> {
      const parameters = bindingAdapter.materializedBulkParameters(bulk, binding);
      if (parameters === undefined) {
        throw new TypeError("SQLBraid Tedious executor received a bulk binding description not produced by its adapter.");
      }
      if (binding.parameterizedSql === undefined) throw new Error("BRAID_BIND_TRANSPORT: SQL Server bulk binding did not provide parameterized SQL.");
      const prepared = await prepareRequest(connection, binding.parameterizedSql, parameters[0] ?? []);
      let failure: unknown;
      let affectedRows = 0;
      let affectedKnown = true;
      try {
        for (const row of parameters) {
          const rowCount = await executePrepared(connection, prepared, row);
          if (typeof rowCount === "number") affectedRows += rowCount;
          else affectedKnown = false;
        }
      } catch (error) {
        failure = error;
      }
      try {
        await unprepareRequest(connection, prepared);
      } catch (error) {
        failure = resourceCleanupError(failure, [error]);
      }
      if (failure !== undefined) throw failure;
      return {
        inputCount: parameters.length,
        ...(affectedKnown ? { affectedRows } : {}),
        executionMode: "prepared-loop",
      };
    },
    stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncIterable<Row> {
      const execution = executionBinding(bindingAdapter, rendered, binding);
      return streamRows(connection, execution.description.parameterizedSql!, execution.parameters, policy, maxBufferedRows, signal) as AsyncIterable<Row>;
    },
    async call(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<DriverRoutineResult> {
      const execution = executionBinding(bindingAdapter, rendered, binding);
      assertNativeProcedureStatement(rendered);
      const result = await collect(connection, execution.description.parameterizedSql!, execution.parameters, policy, rendered.routineProcedure);
      return {
        output: result.output,
        ...(result.returnValue === undefined ? {} : { returnValue: result.returnValue }),
        resultSets: result.resultSets.map((set, index) => ({
          rows: set.rows,
          source: { kind: "emitted" as const, index },
        })),
      };
    },
    begin: () => control(connection, "beginTransaction"),
    commit: () => control(connection, "commitTransaction"),
    rollback: () => control(connection, "rollbackTransaction"),
    savepoint: (name) => control(connection, "saveTransaction", name),
    rollbackTo: (name) => rollbackTo(connection, name),
    releaseSavepoint: async () => undefined,
  };
}

export function createTediousExecutor(connection: TediousConnectionLike, options: TediousExecutorOptions = {}): QueryExecutor {
  assertDirectConnection(connection);
  return makeTediousExecutor(connection, options, createBinding(options));
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
  const bindingAdapter = createBinding(options);
  return {
    statementBinding: bindingAdapter,
    environment: options.typePolicy === undefined || options.typePolicy === defaultTypePolicy ? tediousEnvironment : { ...tediousEnvironment, driver: { id: "tedious", profile: "custom-type-policy" }, capabilities: {} },
    async acquire(): Promise<ConnectionLease> {
      const connection = await acquireConnection();
      if (!connection || typeof connection.release !== "function") throw new TypeError("SQL Server pool returned a connection without explicit release ownership.");
      const executor = makeTediousExecutor(connection, options, bindingAdapter);
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
