import type {
  BulkBindingDescription,
  CommandResult,
  ConnectionLease,
  ConnectionProvider,
  DatabaseOptions,
  DriverRoutineResult,
  DriverEnvironment,
  ExecutionOptions,
  QueryExecutor,
  QueryExecutionResult,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
  TransactionOptions,
  TypePolicy,
} from "@sqlbraid/core";
import {
  createBulkBindingDescription,
  createRenderedStatement,
  createStatementBindingDescription,
  ResultExactnessError,
  normalizeExactInteger,
  safeDatabaseCount,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { assertSavepointName, createCleanupScope, defineResultProperty } from "@sqlbraid/core/driver";
import { createDatabase, createPooledDatabase, DatabaseResultKindError } from "@sqlbraid/runtime";
import { typePolicyForProfile, type MariaDbProfileOptions, type MariaDbRepresentationProfile } from "./type-policy.js";

export type {
  MariaDbConnectionOptions,
  MariaDbJsonProfile,
  MariaDbProfileOptions,
  MariaDbRepresentationProfile,
  MariaDbTemporalProfile,
} from "./type-policy.js";
export {
  MARIADB_DATE_TEXT,
  MARIADB_JSON_TEXT,
  MARIADB_LOSSLESS_TEXT,
  MARIADB_NATIVE,
  representationProfiles,
  typePolicyForProfile,
} from "./type-policy.js";

export interface MariaDbFieldLike {
  readonly name?: string | (() => string);
  readonly type?: string;
  readonly columnType?: number;
  readonly columnLength?: number;
  readonly scale?: number;
  readonly isDataTypeFormatJson?: () => boolean;
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

export interface MariaDbQueryOptions {
  readonly sql: string;
  readonly rowsAsArray?: boolean;
  readonly metaAsArray?: boolean;
  readonly insertIdAsNumber?: boolean;
}

export interface MariaDbConnectionLike {
  execute(sql: string | MariaDbQueryOptions, values?: readonly MariaDbParameter[]): Promise<unknown>;
  query?(sql: string | MariaDbQueryOptions, values?: readonly MariaDbParameter[]): Promise<unknown>;
  queryStream?(sql: string | MariaDbQueryOptions, values?: readonly MariaDbParameter[]): MariaDbStreamLike;
  batch?(sql: string | MariaDbQueryOptions, values: readonly (readonly MariaDbParameter[])[]): Promise<unknown>;
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
  /**
   * Declarative evidence for the Connector/Node.js result-shaping options.
   * The connector does not expose effective options on physical connections.
   */
  readonly profile?: MariaDbProfileOptions | MariaDbRepresentationProfile;
}

export type MariaDbDatabaseOptions = DatabaseOptions & MariaDbExecutorOptions;

const fieldTypes: Readonly<Record<number, string>> = {
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
    !connection ||
    typeof connection !== "object" ||
    typeof connection.execute !== "function" ||
    typeof connection.beginTransaction !== "function" ||
    typeof connection.commit !== "function" ||
    typeof connection.rollback !== "function" ||
    typeof candidate.getConnection === "function"
  ) {
    throw new TypeError("SQLBraid MariaDB direct adapter requires a physical MariaDB Connector/Node.js Connection.");
  }
}

function assertExecutionOptions(connection: MariaDbConnectionLike, options?: ExecutionOptions): void {
  const signal = options?.signal;
  if (signal?.aborted) throw signal.reason;
  if (signal !== undefined && typeof connection.destroy !== "function") {
    throw new UnsupportedFeatureError(
      "statement.cancel",
      "BRAID_CANCEL_UNSUPPORTED",
      "MariaDB Connector/Node.js connection does not expose the documented destroy() cancellation primitive.",
    );
  }
}

async function executeWithCancellation<T>(
  connection: MariaDbConnectionLike,
  operation: () => Promise<T>,
  options?: ExecutionOptions,
): Promise<T> {
  assertExecutionOptions(connection, options);
  const signal = options?.signal;
  if (signal === undefined) return operation();
  let aborted = false;
  let destroyFailure: unknown;
  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    try {
      connection.destroy!();
    } catch (error) {
      destroyFailure = error;
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await operation();
    if (destroyFailure !== undefined) {
      const cleanup = cleanupError("MariaDB cancellation cleanup failed.", destroyFailure);
      throw cleanup;
    }
    if (aborted)
      throw cleanupError(
        "MariaDB cancellation discarded the physical connection.",
        signal.reason ?? new Error("Execution aborted."),
      );
    return result;
  } catch (error) {
    if (destroyFailure !== undefined) {
      throw cleanupAggregate(
        [error, cleanupError("MariaDB cancellation cleanup failed.", destroyFailure)],
        "MariaDB cancellation cleanup failed.",
        error,
      );
    }
    if (aborted) {
      throw cleanupError("MariaDB cancellation discarded the physical connection.", signal.reason ?? error);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cleanupError(message: string, cause?: unknown): Error & { readonly code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function cleanupAggregate(
  errors: readonly unknown[],
  message: string,
  cause?: unknown,
): AggregateError & { readonly code: string } {
  const error = new AggregateError(errors, message, cause === undefined ? undefined : { cause }) as AggregateError & {
    readonly code: string;
  };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function databaseType(field: MariaDbFieldLike | undefined): string | undefined {
  if (field?.isDataTypeFormatJson?.()) return "JSON";
  if (typeof field?.type === "string" && field.type.length > 0) {
    const type = field.type.toUpperCase();
    if (type === "TINY") return "TINYINT";
    if (type === "SHORT") return "SMALLINT";
    if (type === "INT24") return "MEDIUMINT";
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

function isFieldMetadata(value: unknown): value is readonly MariaDbFieldLike[] {
  return (
    Array.isArray(value) &&
    value.every(
      (field) =>
        field !== null && typeof field === "object" && ("name" in field || "type" in field || "columnType" in field),
    )
  );
}

function attachMetadata(rows: readonly unknown[], fields: readonly MariaDbFieldLike[]): MariaDbRowSet {
  Object.defineProperty(rows, "meta", { configurable: true, enumerable: false, value: fields });
  return rows as MariaDbRowSet;
}

function normalizeMetadataResult(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (
    value.length === 2 &&
    value[0] !== null &&
    typeof value[0] === "object" &&
    !Array.isArray(value[0]) &&
    Array.isArray(value[1]) &&
    value[1].length === 0
  ) {
    return value[0];
  }
  if (
    value.length === 2 &&
    Array.isArray(value[0]) &&
    Array.isArray(value[1]) &&
    value[0].some((entry) => Array.isArray(entry)) &&
    value[1].some((entry) => Array.isArray(entry)) &&
    !isFieldMetadata(value[1])
  ) {
    const rowSets: MariaDbRowSet[] = [];
    const rows = value[0];
    const metadata = value[1];
    for (let index = 0; index < rows.length; index += 1) {
      const rowSet = rows[index];
      const fields = metadata[index];
      if (Array.isArray(rowSet) && isFieldMetadata(fields)) rowSets.push(attachMetadata(rowSet, fields));
    }
    return rowSets;
  }
  if (value.length === 2 && Array.isArray(value[0]) && isFieldMetadata(value[1])) {
    return attachMetadata(value[0], value[1]);
  }
  if (
    value.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && Array.isArray(entry[0]) && isFieldMetadata(entry[1]),
    )
  ) {
    return value.map((entry) => normalizeMetadataResult(entry));
  }
  return value;
}

function assertUniqueFields(fields: readonly MariaDbFieldLike[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    const name = typeof field.name === "function" ? field.name() : field.name;
    if (name === undefined) continue;
    if (names.has(name)) {
      const error = new Error(`BRAID_RESULT_COLUMNS: duplicate MariaDB result label ${name}.`);
      Object.defineProperty(error, "code", { value: "BRAID_RESULT_COLUMNS", enumerable: true });
      throw error;
    }
    names.add(name);
  }
}

function plainRow(value: unknown, fields: readonly MariaDbFieldLike[], policy: TypePolicy): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("BRAID_RESULT_COLUMNS: MariaDB Connector must return result rows.");
  }
  const row: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      const key = typeof field.name === "function" ? field.name() : field.name;
      if (key === undefined) continue;
      const entry = value[index];
      const type = databaseType(field);
      assertMariaDbNumericValue(type, entry);
      defineResultProperty(row, key, type === undefined ? entry : policy.decode(type, entry));
    }
    return row;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === undefined) continue;
    const field = fields.find(
      (candidate) => (typeof candidate.name === "function" ? candidate.name() : candidate.name) === key,
    );
    const type = databaseType(field);
    assertMariaDbNumericValue(type, entry);
    defineResultProperty(row, key, type === undefined ? entry : policy.decode(type, entry));
  }
  return row;
}

function assertMariaDbNumericValue(databaseType: string | undefined, value: unknown): void {
  if (value === null || value === undefined || databaseType === undefined) return;
  const type = databaseType.toUpperCase();
  if (type === "TINYINT" || type === "SMALLINT" || type === "MEDIUMINT" || type === "INT") {
    if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
      throw new ResultExactnessError(`MariaDB ${type} result has an unsupported representation.`);
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new ResultExactnessError(`MariaDB ${type} result was an unsafe JavaScript number.`);
    }
    return;
  }
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
    return;
  }
  if (type === "FLOAT" || type === "DOUBLE") {
    if (typeof value !== "number") {
      throw new ResultExactnessError(`MariaDB ${type} result must remain a JavaScript number.`);
    }
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "MariaDB Connector/Node.js does not expose SQLBraid parameter type descriptors.",
    );
  }
}

function assertRoutineOutputsUnsupported(rendered: RenderedStatement): void {
  const output = rendered.parameters.find(
    (parameter) => parameter.direction !== undefined && parameter.direction !== "in",
  );
  const direction = output?.direction;
  if (direction === undefined) return;
  throw new UnsupportedFeatureError(
    direction === "inout" ? "routine.inout" : "routine.out",
    "BRAID_CALL_OUT_UNSUPPORTED",
    "MariaDB Connector/Node.js does not expose a proven public OUT/INOUT carrier discriminator.",
  );
}

function isNestedResultPayload(value: unknown): value is readonly unknown[][] {
  return Array.isArray(value) && !Object.hasOwn(value, "meta") && value.some((entry) => Array.isArray(entry));
}

function resultRows(value: unknown, policy: TypePolicy): QueryExecutionResult<unknown> {
  if (isNestedResultPayload(value)) {
    throw new UnsupportedFeatureError(
      "routine.result-sets",
      "BRAID_RESULT_SETS_UNSUPPORTED",
      "MariaDB returned multiple result sets; use database.call().",
    );
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
  const rawCommand = { ...value } as MariaDbCommandResult;
  const command: MariaDbCommandResult = {
    ...rawCommand,
    ...(rawCommand.affectedRows === undefined ? {} : { affectedRows: safeDatabaseCount(rawCommand.affectedRows) }),
    ...(rawCommand.insertId === undefined || rawCommand.insertId === null
      ? {}
      : { insertId: normalizeExactInteger(rawCommand.insertId) }),
    ...(rawCommand.warningStatus === undefined ? {} : { warningStatus: safeDatabaseCount(rawCommand.warningStatus) }),
  };
  return {
    rows: [],
    rowCount: command.affectedRows,
    kind: "command",
    command,
  };
}

function affectedRows(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    let total = 0n;
    let found = false;
    for (const item of value) {
      const count = affectedRows(item);
      if (count !== undefined) {
        total += BigInt(count);
        found = true;
      }
    }
    return found ? safeDatabaseCount(total) : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const count = (value as { readonly affectedRows?: unknown }).affectedRows;
  return count === undefined ? undefined : safeDatabaseCount(count);
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();
const bulkMatrices = new WeakMap<BulkBindingDescription, readonly (readonly unknown[])[]>();

export const mariaDbStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "mariadb",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertRoutineOutputsUnsupported(statement);
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
    assertRoutineOutputsUnsupported(statement);
    assertParameterHintsUnsupported(statement);
    const parameterSets = Object.freeze(
      bulk.parameterSets.map((values) => {
        if (!Array.isArray(values) || values.length !== statement.parameters.length) {
          throw new Error(
            "BRAID_BULK_SHAPE: MariaDB bulk parameter sets must match the first rendered statement shape.",
          );
        }
        return Object.freeze([...values]);
      }),
    );
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

function isRepresentationProfile(
  value: MariaDbProfileOptions | MariaDbRepresentationProfile | undefined,
): value is MariaDbRepresentationProfile {
  return Boolean(value && "json" in value && "temporal" in value && "typePolicy" in value);
}

function mariaDbProfile(
  value: MariaDbProfileOptions | MariaDbRepresentationProfile | undefined,
): MariaDbRepresentationProfile {
  const options = isRepresentationProfile(value) ? value.connectionOptions : value;
  const json = options?.autoJsonMap === true ? "native" : "text";
  const temporal = options?.dateStrings === false ? "native" : "text";
  return isRepresentationProfile(value)
    ? value
    : {
        id: `mariadb-${json === "text" && temporal === "text" ? "lossless-text" : json === "native" && temporal === "native" ? "native" : json === "text" ? "json-text" : "date-text"}`,
        json,
        temporal,
        typePolicy: typePolicyForProfile({ json, temporal }),
      };
}

function mariaDbEnvironment(
  supplied: MariaDbProfileOptions | MariaDbRepresentationProfile | undefined,
  policy: TypePolicy,
): DriverEnvironment {
  const profile = mariaDbProfile(supplied);
  const policyMatchesProfile = policy === profile.typePolicy;
  return Object.freeze<DriverEnvironment>({
    database: { product: "mariadb" },
    driver: {
      id: "mariadb",
      profile: !policyMatchesProfile
        ? "custom-type-policy"
        : isRepresentationProfile(supplied)
          ? profile.id
          : "mariadb-custom-profile",
    },
    typePolicy: { id: policy.id, hash: policy.hash },
    capabilities: policyMatchesProfile
      ? {
          "sql.native-transparency": { status: "guaranteed" },
          "numeric.exact-integer": {
            status: "guarded",
            canonical: "string",
            rawRepresentations: ["number", "string", "bigint"],
            conditionCode: "mariadb.exact-numeric-profile",
          },
          "numeric.exact-decimal": {
            status: "guarded",
            canonical: "string",
            rawRepresentations: ["string"],
            conditionCode: "mariadb.exact-numeric-profile",
          },
          "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
          "data.json-lossless-text": {
            status: "guarded",
            canonical: "string",
            rawRepresentations: ["string"],
            conditionCode: "mariadb.auto-json-map-false",
          },
          "data.json-parsed": {
            status: "guarded",
            rawRepresentations: ["object", "array", "string", "number", "boolean", "null"],
            conditionCode: "mariadb.auto-json-map-true",
          },
          "data.temporal-lossless": {
            status: "guarded",
            canonical: "string",
            rawRepresentations: ["string"],
            conditionCode: "mariadb.date-strings-true",
          },
          "data.temporal-native": {
            status: "guarded",
            rawRepresentations: ["Date"],
            conditionCode: "mariadb.date-strings-false",
          },
          "metadata.command-safe": {
            status: "guarded",
            canonical: "number",
            rawRepresentations: ["number", "bigint", "string"],
            conditionCode: "mariadb.safe-command-count",
          },
          "session.pinned": { status: "guaranteed" },
          transaction: { status: "guaranteed" },
          "transaction.savepoint": { status: "guaranteed" },
          "transaction.read-only": { status: "guaranteed" },
          "transaction.isolation.read-uncommitted": { status: "guaranteed" },
          "transaction.isolation.read-committed": { status: "guaranteed" },
          "transaction.isolation.repeatable-read": { status: "guaranteed" },
          "transaction.isolation.serializable": { status: "guaranteed" },
          "statement.prepare": { status: "guaranteed" },
          "statement.cancel": { status: "guarded", conditionCode: "mariadb.connection-destroy" },
          "statement.stream": { status: "guaranteed" },
          "statement.bulk": { status: "guaranteed" },
          "routine.call": { status: "guaranteed" },
          "routine.out": { status: "unsupported" },
          "routine.inout": { status: "unsupported" },
          "routine.return-value": { status: "unsupported" },
          "routine.result-sets": { status: "guaranteed" },
          "routine.out-cursor": { status: "unsupported" },
        }
      : {},
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
}

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description =
    binding ??
    mariaDbStatementBinding.describe(statement, {
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
  const description =
    binding ??
    mariaDbStatementBinding.describeBulk!(bulk, {
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
    throw new TypeError(
      "BRAID_BULK_SHAPE: MariaDB bulk binding item count does not match the rendered parameter matrix.",
    );
  }
  const matrix = bulkMatrices.get(description);
  if (matrix === undefined)
    throw new TypeError("BRAID_BINDING_IDENTITY: MariaDB bulk description has no encoded parameter matrix.");
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

function invalidTransactionOptions(message: string): never {
  const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: ${message}`);
  Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
  throw error;
}

export function createMariaDbExecutor(
  connection: MariaDbConnectionLike,
  options: MariaDbExecutorOptions = {},
): QueryExecutor {
  assertMariaDbConnection(connection);
  const representationProfile = mariaDbProfile(options.profile);
  const policy = options.typePolicy ?? representationProfile.typePolicy;
  const control = connectionControl(connection);
  const begin = async (transactionOptions?: TransactionOptions): Promise<void> => {
    if (
      transactionOptions !== undefined &&
      (transactionOptions === null || typeof transactionOptions !== "object" || Array.isArray(transactionOptions))
    ) {
      invalidTransactionOptions("MariaDB transaction options must be an object.");
    }
    if (transactionOptions !== undefined) {
      const unexpected = Object.keys(transactionOptions).find((key) => key !== "isolation" && key !== "readOnly");
      if (unexpected !== undefined) invalidTransactionOptions(`Unknown MariaDB transaction option: ${unexpected}.`);
    }
    const clauses: string[] = [];
    if (
      transactionOptions?.isolation !== undefined &&
      transactionOptions.isolation !== "read-uncommitted" &&
      transactionOptions.isolation !== "read-committed" &&
      transactionOptions.isolation !== "repeatable-read" &&
      transactionOptions.isolation !== "serializable"
    ) {
      invalidTransactionOptions(
        `MariaDB does not recognize transaction isolation ${String(transactionOptions.isolation)}.`,
      );
    }
    if (transactionOptions?.readOnly !== undefined && typeof transactionOptions.readOnly !== "boolean") {
      invalidTransactionOptions("MariaDB readOnly must be a boolean.");
    }
    if (transactionOptions?.isolation !== undefined) {
      const levels: Readonly<Record<NonNullable<TransactionOptions["isolation"]>, string>> = {
        "read-uncommitted": "READ UNCOMMITTED",
        "read-committed": "READ COMMITTED",
        "repeatable-read": "REPEATABLE READ",
        serializable: "SERIALIZABLE",
      };
      clauses.push(`ISOLATION LEVEL ${levels[transactionOptions.isolation]}`);
    }
    if (transactionOptions?.readOnly === true) clauses.push("READ ONLY");
    else if (transactionOptions?.readOnly === false) clauses.push("READ WRITE");
    if (clauses.length > 0) await control(`SET TRANSACTION ${clauses.join(", ")}`);
    await connection.beginTransaction();
  };
  return {
    ownershipKey: connection,
    statementBinding: mariaDbStatementBinding,
    environment: mariaDbEnvironment(options.profile, policy),
    async query<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      assertRoutineOutputsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const result = await executeWithCancellation(
        connection,
        () =>
          connection.execute(
            { sql: prepared.text, rowsAsArray: true, metaAsArray: true, insertIdAsNumber: false },
            prepared.values,
          ),
        executionOptions,
      );
      return resultRows(normalizeMetadataResult(result), policy) as QueryExecutionResult<Row>;
    },
    async *stream<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): AsyncGenerator<Row> {
      assertParameterHintsUnsupported(rendered);
      assertRoutineOutputsUnsupported(rendered);
      assertExecutionOptions(connection, executionOptions);
      const signal = executionOptions?.signal;
      if (typeof connection.queryStream !== "function") {
        throw new UnsupportedFeatureError(
          "statement.stream",
          "BRAID_STREAM_UNSUPPORTED",
          "MariaDB Connector/Node.js connection does not expose queryStream().",
        );
      }
      const prepared = materialize(rendered, binding);
      const stream = connection.queryStream(
        { sql: prepared.text, rowsAsArray: true, metaAsArray: true },
        prepared.values,
      );
      const cleanup = createCleanupScope();
      const noPrimary = Symbol("mariadb.stream.no-primary");
      let primary: unknown = noPrimary;
      let fields: readonly MariaDbFieldLike[] = [];
      let fieldsChanged = false;
      let fieldsSeen = 0;
      let pendingError: unknown;
      const onFields = (value: unknown): void => {
        fieldsSeen += 1;
        if (fieldsSeen === 1) {
          fields = Array.isArray(value) ? (value as readonly MariaDbFieldLike[]) : [];
          fieldsChanged = true;
        } else {
          pendingError ??= new UnsupportedFeatureError(
            "routine.result-sets",
            "BRAID_RESULT_SETS_UNSUPPORTED",
            "MariaDB stream returned multiple result sets; use database.call().",
          );
        }
      };
      let exhausted = false;
      let abortRequested = false;
      let destroyed = false;
      let destroyFailure: unknown;
      const abort = (): void => {
        if (abortRequested) return;
        abortRequested = true;
        if (destroyed) return;
        destroyed = true;
        try {
          connection.destroy!();
        } catch (error) {
          destroyFailure ??= error;
        }
      };
      try {
        cleanup.add(async () => {
          if (abortRequested) {
            if (!destroyed) {
              destroyed = true;
              try {
                connection.destroy!();
              } catch (error) {
                destroyFailure ??= error;
              }
            }
            if (destroyFailure !== undefined) {
              throw cleanupError("MariaDB stream cancellation cleanup failed.", destroyFailure);
            }
            throw cleanupError(
              "MariaDB cancellation discarded the physical connection.",
              signal?.reason ?? new Error("Execution aborted."),
            );
          }
          if (!exhausted) {
            if (typeof stream.close !== "function") {
              if (!destroyed && typeof connection.destroy === "function") {
                destroyed = true;
                try {
                  connection.destroy();
                } catch (error) {
                  destroyFailure ??= error;
                }
              }
              throw cleanupError(
                "MariaDB stream cleanup requires queryStream().close(); the physical connection was discarded.",
                destroyFailure,
              );
            }
            await streamClose(stream);
          }
          if (destroyFailure !== undefined) {
            throw cleanupError("MariaDB stream cancellation cleanup failed.", destroyFailure);
          }
        });
        if (typeof stream.close !== "function") {
          throw new UnsupportedFeatureError(
            "statement.stream",
            "BRAID_STREAM_UNSUPPORTED",
            "MariaDB Connector/Node.js queryStream does not expose close().",
          );
        }
        (stream.on ?? stream.once)?.call(stream, "fields", onFields);
        const iterator = stream[Symbol.asyncIterator]();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
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
            if (fieldsSeen === 0) throw new DatabaseResultKindError("rows", "command");
            break;
          }
          signal?.throwIfAborted();
          yield plainRow(next.value, fields, policy) as Row;
        }
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        try {
          const result = primary === noPrimary ? cleanup.run() : cleanup.run(primary);
          if (result !== undefined) await result;
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
      assertRoutineOutputsUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const value = await executeWithCancellation(
        connection,
        () =>
          connection.execute(
            { sql: prepared.text, rowsAsArray: true, metaAsArray: true, insertIdAsNumber: false },
            prepared.values,
          ),
        executionOptions,
      );
      const normalized = normalizeMetadataResult(value);
      if (!Array.isArray(normalized)) return { output: {}, resultSets: [] };
      const sets = isNestedResultPayload(normalized)
        ? normalized.filter((entry): entry is MariaDbRowSet => Array.isArray(entry))
        : [normalized as MariaDbRowSet];
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
    async bulk(bulk: RenderedBulk, binding: BulkBindingDescription, executionOptions?: ExecutionOptions) {
      const prepared = materializeBulk(bulk, binding);
      if (typeof connection.batch !== "function") {
        throw new UnsupportedFeatureError(
          "statement.bulk",
          "BRAID_BULK_UNSUPPORTED",
          "MariaDB Connector/Node.js connection does not expose batch().",
        );
      }
      const result = await executeWithCancellation(
        connection,
        () => connection.batch!({ sql: prepared.text, insertIdAsNumber: false }, prepared.values),
        executionOptions,
      );
      return {
        inputCount: prepared.itemCount,
        affectedRows: affectedRows(result),
        executionMode: "native-bulk" as const,
      };
    },
    begin,
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    savepoint: (name) => control(`SAVEPOINT ${assertSavepointName(name)}`),
    rollbackTo: (name) => control(`ROLLBACK TO SAVEPOINT ${assertSavepointName(name)}`),
    releaseSavepoint: (name) => control(`RELEASE SAVEPOINT ${assertSavepointName(name)}`),
  };
}

export function createMariaDbDatabase(connection: MariaDbConnectionLike, options: MariaDbDatabaseOptions = {}) {
  const { typePolicy, profile, ...databaseOptions } = options;
  return createDatabase(createMariaDbExecutor(connection, { typePolicy, profile }), databaseOptions);
}

export function createMariaDbPoolProvider(
  pool: MariaDbPoolLike,
  options: MariaDbExecutorOptions = {},
): ConnectionProvider {
  if (!pool || typeof pool !== "object" || typeof pool.getConnection !== "function") {
    throw new TypeError("SQLBraid MariaDB pool adapter requires a MariaDB Connector/Node.js Pool.");
  }
  return {
    statementBinding: mariaDbStatementBinding,
    environment: mariaDbEnvironment(options.profile, options.typePolicy ?? mariaDbProfile(options.profile).typePolicy),
    async acquire(): Promise<ConnectionLease> {
      const connection = await pool.getConnection();
      try {
        const executor = createMariaDbExecutor(connection, options);
        let released = false;
        return {
          ...executor,
          async release(releaseOptions = {}): Promise<void> {
            if (released) return;
            released = true;
            if (releaseOptions.discard === true) {
              try {
                if (typeof connection.destroy === "function") {
                  connection.destroy();
                  return;
                }
                if (typeof connection.end === "function") {
                  await connection.end();
                  return;
                }
                throw cleanupError("MariaDB pool connection cannot be discarded safely.");
              } catch (error) {
                if ((error as { readonly code?: unknown }).code === "BRAID_RESOURCE_CLEANUP") throw error;
                throw cleanupError("MariaDB pool discard failed.", error);
              }
            }
            await connection.release();
          },
        };
      } catch (error) {
        try {
          await connection.release();
        } catch (cleanup) {
          throw cleanupAggregate([error, cleanup], "MariaDB pool initialization cleanup failed.", error);
        }
        throw error;
      }
    },
  };
}

export function createMariaDbPoolDatabase(pool: MariaDbPoolLike, options: MariaDbDatabaseOptions = {}) {
  const { typePolicy, profile, ...databaseOptions } = options;
  return createPooledDatabase(createMariaDbPoolProvider(pool, { typePolicy, profile }), databaseOptions);
}
