import type {
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
import { assertSavepointName } from "@sqlbraid/core/driver";
import {
  createBulkBindingDescription,
  createRenderedStatement,
  createStatementBindingDescription,
  AdapterError,
  ResultExactnessError,
  safeDatabaseCount,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { createDatabase, createPooledDatabase, DatabaseResultKindError } from "@sqlbraid/runtime";
import {
  representationProfiles,
  typePolicyForProfile,
  type PgJsonProfile,
  type PgRepresentationProfile,
  type PgTemporalProfile,
} from "./type-policy.js";

export interface PgFieldLike {
  readonly name: string;
  readonly dataTypeID?: number;
  readonly dataType?: string;
}

export interface PgTypeOverrides {
  getTypeParser(oid: number, format?: string): (value: string) => unknown;
}

export interface PgResultLike {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
  readonly fields?: readonly PgFieldLike[];
  readonly command?: string;
}

export interface PgClientLike {
  query(config: {
    readonly text: string;
    readonly values: readonly unknown[];
    readonly name?: string;
    readonly types?: PgTypeOverrides;
  }): Promise<PgResultLike>;
  query(text: string, values?: readonly unknown[]): Promise<PgResultLike>;
  /**
   * Physical node-postgres clients expose these helpers; pools do not.
   * They are the public discriminator that keeps pool usage on the lease API.
   */
  escapeIdentifier(value: string): string;
  escapeLiteral(value: string): string;
  getTypeParser?(oid: number, format?: string): (value: string) => unknown;
  /** Required when streaming with an AbortSignal; ends the physical connection. */
  end?(): Promise<void>;
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

/** Native cursor constructor used to implement `db.stream()`; the optional peer keeps materialized queries usable without it. */
export interface PgCursorFactory {
  new (text: string, values: readonly unknown[], config?: { readonly types?: PgTypeOverrides }): PgCursorLike;
}

/** Parser overrides must agree with the selected representation profile when both are supplied. */
export interface PgParserProfile {
  readonly json?: PgJsonProfile;
  readonly temporal?: PgTemporalProfile;
}

/**
 * PostgreSQL executor policy. Exact numerics remain text by default; `cursor` is required for native streaming.
 * `parserProfile` changes pg type parsers and is rejected when it contradicts `profile`.
 */
export interface PgExecutorOptions {
  readonly typePolicy?: TypePolicy;
  readonly profile?: PgRepresentationProfile;
  readonly streamBatchSize?: number;
  readonly cursor?: PgCursorFactory;
  readonly parserProfile?: PgParserProfile;
}

export type PgDatabaseOptions = DatabaseOptions & PgExecutorOptions;

export const pgOidTypes: Readonly<Record<number, string>> = Object.freeze({
  16: "bool",
  17: "bytea",
  18: "char",
  19: "name",
  20: "int8",
  21: "int2",
  23: "int4",
  25: "text",
  26: "oid",
  114: "json",
  790: "money",
  1082: "date",
  1083: "time",
  1114: "timestamp",
  1184: "timestamp with time zone",
  1186: "interval",
  1266: "time with time zone",
  1700: "numeric",
  2950: "uuid",
  3802: "jsonb",
  700: "float4",
  701: "float8",
  791: "money[]",
  1000: "bool[]",
  1001: "bytea[]",
  1002: "char[]",
  1003: "name[]",
  1005: "int2[]",
  1007: "int4[]",
  1009: "text[]",
  1014: "bpchar[]",
  1015: "varchar[]",
  1016: "int8[]",
  1021: "float4[]",
  1022: "float8[]",
  1028: "oid[]",
  1182: "date[]",
  1183: "time[]",
  1185: "timestamp with time zone[]",
  1187: "interval[]",
  1231: "numeric[]",
  1270: "time with time zone[]",
  199: "json[]",
  2951: "uuid[]",
  3807: "jsonb[]",
  143: "xml[]",
});

const defaultParserProfile: Required<Pick<PgParserProfile, "json" | "temporal">> = Object.freeze({
  json: "text",
  temporal: "text",
});

function resolveParserProfile(
  options: PgParserProfile | undefined,
  descriptor?: PgRepresentationProfile,
): { readonly json: PgJsonProfile; readonly temporal: PgTemporalProfile } {
  const requestedJson = options?.json;
  const requestedTemporal = options?.temporal;
  if (descriptor && requestedJson !== undefined && requestedJson !== descriptor.json) {
    throw new ResultExactnessError(
      "PostgreSQL parserProfile JSON setting contradicts the selected representation profile.",
    );
  }
  if (descriptor && requestedTemporal !== undefined && requestedTemporal !== descriptor.temporal) {
    throw new ResultExactnessError(
      "PostgreSQL parserProfile temporal setting contradicts the selected representation profile.",
    );
  }
  const profile = {
    json: descriptor?.json ?? requestedJson ?? defaultParserProfile.json,
    temporal: descriptor?.temporal ?? requestedTemporal ?? defaultParserProfile.temporal,
  };
  if (profile.json !== "text" && profile.json !== "native")
    throw new RangeError(`Unsupported PostgreSQL JSON parser profile: ${String(profile.json)}`);
  if (profile.temporal !== "text" && profile.temporal !== "native")
    throw new RangeError(`Unsupported PostgreSQL temporal parser profile: ${String(profile.temporal)}`);
  return profile;
}

const jsonOids = new Set([114, 3802]);
const temporalOids = new Set([1082, 1083, 1114, 1184, 1186, 1266]);
const exactNumericOids = new Set([20, 21, 23, 26, 790, 1700]);
const arrayOids = new Set([
  143, 199, 1000, 1001, 1002, 1003, 1005, 1007, 1009, 1014, 1015, 1016, 1021, 1022, 1028, 1115, 1182, 1183, 1185, 1187,
  1231, 1270, 791, 2951, 3807,
]);

function textValue(value: unknown): unknown {
  if (typeof value === "string") return value;
  throw new ResultExactnessError("PostgreSQL lossless text profile requires text-format results.");
}

function binary64Value(value: unknown): number {
  return Number(textValue(value));
}

function binary32Value(value: unknown): number {
  return Math.fround(binary64Value(value));
}

function queryTypeOverrides(client: PgClientLike, profile: Required<PgParserProfile>): PgTypeOverrides | undefined {
  const lossless = profile.json === "text" && profile.temporal === "text";
  return {
    getTypeParser(oid, format) {
      if (oid === 700) return binary32Value;
      if (oid === 701) return binary64Value;
      if (
        exactNumericOids.has(oid) ||
        (profile.json === "text" && jsonOids.has(oid)) ||
        (profile.temporal === "text" && temporalOids.has(oid)) ||
        (lossless && (arrayOids.has(oid) || pgOidTypes[oid] === undefined))
      ) {
        return textValue;
      }
      return client.getTypeParser?.(oid, format) ?? ((value: unknown) => value);
    },
  };
}

async function optionalCursorFactory(): Promise<PgCursorFactory> {
  try {
    const loaded = (await import("pg-cursor")) as unknown as { readonly default?: unknown };
    const factory = loaded.default;
    if (typeof factory !== "function") throw new TypeError("pg-cursor did not export a constructor.");
    return factory as PgCursorFactory;
  } catch (error) {
    throw unsupported(
      "statement.stream",
      "BRAID_STREAM_UNSUPPORTED",
      "PostgreSQL streaming requires the optional pg-cursor peer.",
      error,
    );
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
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
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

async function withPgCancellation<T>(
  client: PgClientLike,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return operation();
  if (typeof client.end !== "function") {
    throw unsupported(
      "statement.cancel",
      "BRAID_CANCEL_UNSUPPORTED",
      "PostgreSQL cancellation requires the physical client's documented end() method.",
    );
  }
  let aborted = false;
  let termination: Promise<void> | undefined;
  const abort = (): void => {
    aborted = true;
    termination ??= Promise.resolve().then(() => client.end!());
    void termination.catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    try {
      const result = await operation();
      if (!aborted) {
        signal.throwIfAborted();
        return result;
      }
      await termination;
      throw cleanupFailure("PostgreSQL physical connection was terminated after statement abort.", signal.reason);
    } catch (error) {
      if (!aborted) throw error;
      try {
        await termination;
      } catch (cleanup) {
        throw cleanupAggregate([error, cleanup], "PostgreSQL statement cancellation cleanup failed.", error);
      }
      throw cleanupFailure("PostgreSQL physical connection was terminated after statement abort.", signal.reason);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function assertPgClient(client: PgClientLike): void {
  if (
    !client ||
    typeof client !== "object" ||
    typeof client.escapeIdentifier !== "function" ||
    typeof client.escapeLiteral !== "function"
  ) {
    throw new TypeError("SQLBraid PostgreSQL direct adapter requires a physical pg Client or PoolClient.");
  }
}

function plainRow(value: unknown, fields: readonly PgFieldLike[], policy: TypePolicy): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const row: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.name === key);
    const databaseType =
      field?.dataType ?? (field?.dataTypeID === undefined ? undefined : pgOidTypes[field.dataTypeID]);
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
    if (names.has(field.name))
      throw new Error(`BRAID_RESULT_COLUMNS: duplicate PostgreSQL result label ${field.name}.`);
    names.add(field.name);
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (
    rendered.parameters.some(
      (parameter) => parameter.hint !== undefined && !(rendered.resultKind === "call" && isRefcursor(parameter)),
    )
  ) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "PostgreSQL adapter does not support explicit bind type hints.",
    );
  }
}

function assertPgRoutineDirections(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.direction === "inout")) {
    throw unsupported(
      "routine.inout",
      "BRAID_CALL_OUT_UNSUPPORTED",
      "The PostgreSQL adapter does not expose a verified INOUT carrier contract.",
    );
  }
}

function assertPgRoutineCallContext(rendered: RenderedStatement): void {
  if (
    rendered.resultKind !== "call" &&
    rendered.parameters.some((parameter) => parameter.direction !== undefined && parameter.direction !== "in")
  ) {
    throw unsupported(
      "routine.out",
      "BRAID_CALL_OUT_UNSUPPORTED",
      "PostgreSQL OUT parameters are only valid for routine calls.",
    );
  }
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();
const bindingContexts = new WeakMap<StatementBindingDescription, StatementBindingContext>();

function isRefcursor(parameter: RenderedStatement["parameters"][number]): boolean {
  return (
    parameter.direction !== undefined &&
    parameter.direction !== "in" &&
    parameter.hint?.databaseType.trim().toLowerCase() === "refcursor"
  );
}

function hasRefcursor(rendered: RenderedStatement): boolean {
  return rendered.parameters.some(isRefcursor);
}

export const pgStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "pg",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    if (hasRefcursor(statement) && context.transactionScoped !== true) {
      throw unsupported(
        "routine.out-cursor",
        "BRAID_CALL_CURSOR_TX_REQUIRED",
        "PostgreSQL refcursor calls require an existing transaction.",
      );
    }
    assertPgRoutineCallContext(statement);
    assertPgRoutineDirections(statement);
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
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    if (statement.resultKind !== "command")
      throw new Error("BRAID_BULK_SHAPE: PostgreSQL bulk requires command queries.");
    if (statement.parameters.some((parameter) => (parameter.direction ?? "in") !== "in")) {
      throw unsupported("routine.out", "BRAID_BULK_SHAPE", "PostgreSQL bulk does not support OUT or INOUT parameters.");
    }
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length)
        throw new Error("BRAID_BULK_SHAPE: PostgreSQL bulk parameter cardinality changed.");
    }
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "pg",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "reuse", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "postgres",
  requestedReuse: "auto",
});

const pgExecutionCapabilities: DriverEnvironment["capabilities"] = Object.freeze({
  "session.pinned": { status: "guaranteed" },
  transaction: { status: "guaranteed" },
  "transaction.savepoint": { status: "guaranteed" },
  "transaction.read-only": { status: "guaranteed" },
  "transaction.isolation.read-uncommitted": {
    status: "guarded",
    conditionCode: "pg.read-uncommitted-maps-to-read-committed",
  },
  "transaction.isolation.read-committed": { status: "guaranteed" },
  "transaction.isolation.repeatable-read": { status: "guaranteed" },
  "transaction.isolation.serializable": { status: "guaranteed" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": {
    status: "guarded",
    conditionCode: "pg.physical-connection-destroy",
  },
  "statement.stream": { status: "guaranteed" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "guaranteed" },
  "routine.out": { status: "guaranteed" },
  "routine.inout": { status: "unsupported" },
  "routine.return-value": { status: "unsupported" },
  "routine.result-sets": { status: "guaranteed" },
  "routine.out-cursor": { status: "guaranteed" },
});

function pgEnvironmentFor(
  profile: { readonly json: PgJsonProfile; readonly temporal: PgTemporalProfile },
  policy: TypePolicy = typePolicyForProfile(profile),
): DriverEnvironment {
  const profileId =
    profile.json === "text" && profile.temporal === "text"
      ? "pg-lossless-text"
      : profile.json === "native" && profile.temporal === "native"
        ? "pg-native"
        : profile.json === "native"
          ? "pg-json-native-temporal-text"
          : "pg-json-text-temporal-native";
  return Object.freeze<DriverEnvironment>({
    database: { product: "postgres" },
    driver: { id: "pg", profile: profileId },
    typePolicy: { id: policy.id, hash: policy.hash },
    capabilities: {
      ...pgExecutionCapabilities,
      "sql.native-transparency": { status: "guaranteed" },
      "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
      "numeric.exact-decimal": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
      "numeric.approximate-float": {
        status: "guarded",
        canonical: "number",
        rawRepresentations: ["number"],
        conditionCode: "pg.extra-float-digits",
      },
      "data.json-lossless-text": {
        status: profile.json === "text" ? "guaranteed" : "unsupported",
        canonical: "string",
        rawRepresentations: ["string"],
        ...(profile.json === "text" ? {} : { conditionCode: "pg.json-parser-profile" }),
      },
      "data.json-parsed": {
        status: profile.json === "native" ? "guarded" : "unsupported",
        rawRepresentations: ["unknown"],
        conditionCode: "pg.json-parser-profile",
      },
      "data.temporal-lossless": {
        status: profile.temporal === "text" ? "guaranteed" : "unsupported",
        canonical: "string",
        rawRepresentations: ["string"],
        ...(profile.temporal === "text" ? {} : { conditionCode: "pg.temporal-parser-profile" }),
      },
      "data.temporal-native": {
        status: profile.temporal === "native" ? "guarded" : "unsupported",
        rawRepresentations: ["Date", "string", "unknown"],
        conditionCode: "pg.temporal-parser-profile",
      },
    },
    probe: {
      statement: createRenderedStatement({
        segments: [
          "SELECT current_setting('server_version') AS server_version, current_setting('extra_float_digits') AS extra_float_digits, current_setting('TimeZone') AS timezone",
        ],
        parameters: [],
        resultKind: "rows",
        dialectId: "postgres",
      }),
      read: (rows) => {
        const row = rows[0];
        if (!row || typeof row !== "object" || Array.isArray(row)) return {};
        const record = row as Record<string, unknown>;
        const version = typeof record.server_version === "string" ? record.server_version : undefined;
        const extraFloatDigits =
          typeof record.extra_float_digits === "string" ? Number(record.extra_float_digits) : undefined;
        const approximateFloat =
          extraFloatDigits !== undefined && extraFloatDigits > 0
            ? { status: "guaranteed" as const, canonical: "number" as const, rawRepresentations: ["number"] as const }
            : {
                status: "guarded" as const,
                canonical: "number" as const,
                rawRepresentations: ["number"] as const,
                conditionCode: "pg.extra-float-digits",
              };
        return {
          ...(version === undefined ? {} : { version }),
          capabilities: { "numeric.approximate-float": approximateFloat },
        };
      },
    },
  });
}

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
  types?: PgTypeOverrides,
): { readonly text: string; readonly values: readonly unknown[]; readonly types?: PgTypeOverrides } {
  statement = createRenderedStatement(statement);
  const description =
    binding ??
    pgStatementBinding.describe(statement, {
      dialectId: statement.dialectId,
      requestedReuse: defaultBindingContext.requestedReuse,
    });
  if (describedStatements.get(description) !== statement)
    throw new TypeError("BRAID_BINDING_IDENTITY: PostgreSQL description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: PostgreSQL binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
    ...(types === undefined ? {} : { types }),
  };
}

function outputRow(
  result: PgResultLike,
  rendered: RenderedStatement,
  policy: TypePolicy,
): Readonly<Record<string, unknown>> {
  const outputParameters = rendered.parameters.filter(
    (parameter) => parameter.direction !== undefined && parameter.direction !== "in",
  );
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
    const source =
      field === undefined
        ? (values ??= Object.values(row))[positional]
        : Object.hasOwn(row, field.name)
          ? (row as Record<string, unknown>)[field.name]
          : undefined;
    positional += 1;
    const databaseType =
      field?.dataType ?? (field?.dataTypeID === undefined ? undefined : pgOidTypes[field.dataTypeID]);
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

type PgPreparedStatementMap = Record<string, string>;

interface PgPreparedStatementRegistry {
  readonly parsedStatements: PgPreparedStatementMap;
  readonly submittedNamedStatements: PgPreparedStatementMap;
}

interface PgBulkCache {
  name: string;
  text?: string;
  readonly registry?: PgPreparedStatementRegistry;
  reusable: boolean;
  tail: Promise<void>;
}

// node-postgres 8.23 keeps these private maps on Client.connection. They are
// needed only to make a public DEALLOCATE coherent with node-postgres' own
// named-query bookkeeping; clients without this exact native boundary fall
// back to unnamed execution after the first SQL shape.
const pgBulkCaches = new WeakMap<PgClientLike, PgBulkCache>();
let nextPreparedBulkName = 0;

function nativePreparedStatementRegistry(client: PgClientLike): PgPreparedStatementRegistry | undefined {
  const connection = (client as unknown as { readonly connection?: unknown }).connection;
  if (!connection || typeof connection !== "object") return undefined;
  const candidate = connection as {
    readonly parsedStatements?: unknown;
    readonly submittedNamedStatements?: unknown;
  };
  if (!candidate.parsedStatements || typeof candidate.parsedStatements !== "object") {
    return undefined;
  }
  const submittedNamedStatements = candidate.submittedNamedStatements;
  return {
    parsedStatements: candidate.parsedStatements as PgPreparedStatementMap,
    submittedNamedStatements:
      submittedNamedStatements && typeof submittedNamedStatements === "object"
        ? (submittedNamedStatements as PgPreparedStatementMap)
        : (Object.create(null) as PgPreparedStatementMap),
  };
}

function preparedStatementText(statements: PgPreparedStatementMap, name: string): string | undefined {
  return Object.hasOwn(statements, name) ? statements[name] : undefined;
}

function preparedBulkName(registry: PgPreparedStatementRegistry | undefined): string {
  while (true) {
    const name = `sqlbraid_bulk_${(nextPreparedBulkName++).toString(36)}`;
    if (
      registry === undefined ||
      (preparedStatementText(registry.parsedStatements, name) === undefined &&
        preparedStatementText(registry.submittedNamedStatements, name) === undefined)
    ) {
      return name;
    }
  }
}

function pgBulkCacheFor(client: PgClientLike): PgBulkCache {
  const existing = pgBulkCaches.get(client);
  if (existing !== undefined) return existing;
  const registry = nativePreparedStatementRegistry(client);
  const cache: PgBulkCache = {
    name: preparedBulkName(registry),
    ...(registry === undefined ? {} : { registry }),
    reusable: true,
    tail: Promise.resolve(),
  };
  pgBulkCaches.set(client, cache);
  return cache;
}

function hasUnrelatedPreparedStatement(registry: PgPreparedStatementRegistry, name: string, text: string): boolean {
  const parsed = preparedStatementText(registry.parsedStatements, name);
  const submitted = preparedStatementText(registry.submittedNamedStatements, name);
  return (parsed !== undefined && parsed !== text) || (submitted !== undefined && submitted !== text);
}

function forgetPreparedStatement(registry: PgPreparedStatementRegistry, name: string, text: string): void {
  if (preparedStatementText(registry.parsedStatements, name) === text) delete registry.parsedStatements[name];
  if (preparedStatementText(registry.submittedNamedStatements, name) === text)
    delete registry.submittedNamedStatements[name];
}

async function evictPgBulkStatement(client: PgClientLike, cache: PgBulkCache): Promise<void> {
  const text = cache.text;
  if (text === undefined) return;
  const registry = cache.registry;
  if (registry === undefined) {
    cache.reusable = false;
    cache.text = undefined;
    return;
  }
  if (hasUnrelatedPreparedStatement(registry, cache.name, text)) {
    cache.name = preparedBulkName(registry);
    cache.text = undefined;
    return;
  }
  await client.query({ text: `DEALLOCATE ${quotePortal(cache.name)}`, values: [] });
  forgetPreparedStatement(registry, cache.name, text);
  cache.text = undefined;
}

async function acquirePgBulkName(client: PgClientLike, cache: PgBulkCache, text: string): Promise<string | undefined> {
  if (!cache.reusable) return undefined;
  if (cache.text !== text) await evictPgBulkStatement(client, cache);
  if (!cache.reusable) return undefined;
  const registry = cache.registry;
  if (registry !== undefined && hasUnrelatedPreparedStatement(registry, cache.name, text)) {
    cache.name = preparedBulkName(registry);
  }
  return cache.name;
}

function markPgBulkPrepared(cache: PgBulkCache, name: string, text: string): void {
  cache.text = text;
  const registry = cache.registry;
  if (registry === undefined) return;
  registry.parsedStatements[name] = text;
  delete registry.submittedNamedStatements[name];
}

function enqueuePgBulk<T>(cache: PgBulkCache, operation: () => Promise<T>): Promise<T> {
  const run = cache.tail.then(operation, operation);
  cache.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function postgresIsolationLevel(isolation: TransactionIsolation): string {
  switch (isolation) {
    case "read-uncommitted":
      return "READ UNCOMMITTED";
    case "read-committed":
      return "READ COMMITTED";
    case "repeatable-read":
      return "REPEATABLE READ";
    case "serializable":
      return "SERIALIZABLE";
    default:
      throw invalidTransactionOptions(`Unsupported PostgreSQL transaction isolation level: ${String(isolation)}.`);
  }
}

function postgresBeginSql(options: TransactionOptions | undefined): string {
  if (options === undefined) return "BEGIN";
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidTransactionOptions("PostgreSQL transaction options must be an object.");
  }
  const unexpected = Object.keys(options).find((key) => key !== "isolation" && key !== "readOnly");
  if (unexpected !== undefined)
    throw invalidTransactionOptions(`Unknown PostgreSQL transaction option: ${unexpected}.`);
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") {
    throw invalidTransactionOptions("PostgreSQL transaction readOnly must be a boolean.");
  }
  const clauses: string[] = [];
  if (options.isolation !== undefined) clauses.push(`ISOLATION LEVEL ${postgresIsolationLevel(options.isolation)}`);
  if (options.readOnly === true) clauses.push("READ ONLY");
  else if (options.readOnly === false) clauses.push("READ WRITE");
  return clauses.length === 0 ? "BEGIN" : `BEGIN ${clauses.join(" ")}`;
}

function resolveStreamBatchSize(value: number | undefined): number {
  const size = value ?? 100;
  if (!Number.isSafeInteger(size) || size < 1)
    throw new RangeError("PostgreSQL streamBatchSize must be a positive safe integer.");
  return size;
}

/** Wrap one connected `pg` client. SQLBraid owns query serialization but not client shutdown. */
export function createPgExecutor(client: PgClientLike, options: PgExecutorOptions = {}): QueryExecutor {
  assertPgClient(client);
  const profile = resolveParserProfile(options.parserProfile, options.profile);
  const profilePolicy = options.profile?.typePolicy ?? typePolicyForProfile(profile);
  const policy = options.typePolicy ?? profilePolicy;
  const firstPartyProfile =
    options.profile === undefined || representationProfiles.some((entry) => entry === options.profile);
  const types = queryTypeOverrides(client, profile);
  const batchSize = resolveStreamBatchSize(options.streamBatchSize);
  const runControl = async (text: string): Promise<void> => {
    const result = await client.query({ text, values: [] });
    if (text === "COMMIT" && result.command !== undefined && result.command !== "COMMIT") {
      throw new AdapterError(
        "BRAID_TX_NOT_COMMITTED",
        `PostgreSQL COMMIT completed with ${result.command}, not COMMIT.`,
      );
    }
  };
  return {
    ownershipKey: client,
    statementBinding: pgStatementBinding,
    environment:
      policy === profilePolicy && firstPartyProfile
        ? pgEnvironmentFor(profile, policy)
        : {
            ...pgEnvironmentFor(profile, profilePolicy),
            driver: { id: "pg", profile: "custom-type-policy" },
            typePolicy: { id: policy.id, hash: policy.hash },
            capabilities: pgExecutionCapabilities,
          },
    async query<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      executionOptions?.signal?.throwIfAborted();
      assertParameterHintsUnsupported(rendered);
      const result = await withPgCancellation(client, executionOptions?.signal, () =>
        client.query(materialize(rendered, binding, types)),
      );
      assertUniqueFields(result.fields ?? []);
      const rows = result.rows.map((row) => plainRow(row, result.fields ?? [], policy));
      const rowCount =
        result.rowCount === null || result.rowCount === undefined ? undefined : safeDatabaseCount(result.rowCount);
      const rowBearing = (result.fields?.length ?? 0) > 0 || result.rows.length > 0 || result.command === "SELECT";
      return rowBearing
        ? { rows: rows as readonly Row[], rowCount, kind: "rows" }
        : { rows: [], rowCount, kind: "command", command: { affectedRows: rowCount } };
    },
    async bulk(
      bulk: RenderedBulk,
      binding: BulkBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<BulkExecutionResult> {
      executionOptions?.signal?.throwIfAborted();
      if (executionOptions?.signal !== undefined && typeof client.end !== "function") {
        throw unsupported(
          "statement.cancel",
          "BRAID_CANCEL_UNSUPPORTED",
          "PostgreSQL cancellation requires the physical client's documented end() method.",
        );
      }
      const described = describedBulks.get(binding);
      if (described !== bulk)
        throw new TypeError("BRAID_BINDING_IDENTITY: PostgreSQL bulk description belongs to another bulk or adapter.");
      if (binding.adapterId !== pgStatementBinding.id || binding.dialectId !== bulk.statement.dialectId) {
        throw new TypeError("BRAID_BINDING_IDENTITY: PostgreSQL bulk description belongs to another adapter.");
      }
      if (binding.parameterizedSql === undefined)
        throw new Error("BRAID_BIND_TRANSPORT: PostgreSQL bulk binding did not provide parameterized SQL.");
      const cache = pgBulkCacheFor(client);
      return enqueuePgBulk(cache, async () => {
        let name: string | undefined;
        let nameReady = false;
        let affectedRows = 0;
        let affectedKnown = true;
        for (let index = 0; index < binding.itemCount; index += 1) {
          if (!nameReady) {
            name = await acquirePgBulkName(client, cache, binding.parameterizedSql!);
            nameReady = true;
          }
          const values = binding.valuesAt(index);
          let result: PgResultLike;
          try {
            result =
              name === undefined
                ? await withPgCancellation(client, executionOptions?.signal, () =>
                    client.query({ text: binding.parameterizedSql!, values }),
                  )
                : await withPgCancellation(client, executionOptions?.signal, () =>
                    client.query({ name, text: binding.parameterizedSql!, values }),
                  );
          } catch (error) {
            const registry = cache.registry;
            if (
              name !== undefined &&
              registry !== undefined &&
              (preparedStatementText(registry.parsedStatements, name) === binding.parameterizedSql ||
                preparedStatementText(registry.submittedNamedStatements, name) === binding.parameterizedSql)
            ) {
              cache.text = binding.parameterizedSql;
            }
            throw error;
          }
          if (name !== undefined) markPgBulkPrepared(cache, name, binding.parameterizedSql!);
          if ((result.fields?.length ?? 0) > 0 || result.rows.length > 0) {
            throw new Error("BRAID_BULK_RESULT_KIND: PostgreSQL bulk command returned rows.");
          }
          if (typeof result.rowCount === "number") affectedRows += safeDatabaseCount(result.rowCount);
          else affectedKnown = false;
        }
        return {
          inputCount: binding.itemCount,
          ...(affectedKnown ? { affectedRows: safeDatabaseCount(affectedRows) } : {}),
          executionMode: "prepared-loop",
        };
      });
    },
    async *stream<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): AsyncGenerator<Row> {
      const signal = executionOptions?.signal;
      assertParameterHintsUnsupported(rendered);
      signal?.throwIfAborted();
      if (signal && typeof client.end !== "function") {
        throw unsupported(
          "statement.cancel",
          "BRAID_CANCEL_UNSUPPORTED",
          "Abortable PostgreSQL streams require the physical client's documented end() method.",
        );
      }
      const prepared = materialize(rendered, binding);
      const Cursor = options.cursor ?? (await optionalCursorFactory());
      signal?.throwIfAborted();
      const cursor = new Cursor(prepared.text, prepared.values, types === undefined ? undefined : { types });
      let ending: Promise<void> | undefined;
      const abort = (): void => {
        // Closing a portal cannot interrupt an in-flight Execute. Disconnect instead.
        ending ??= Promise.resolve().then(() => client.end!());
        void ending.catch(() => undefined); // Observed by the cleanup path below.
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let streamError: unknown;
      try {
        // pg's optional Submittable overload is used only by the cursor capability.
        (client.query as unknown as (cursor: PgCursorLike) => PgCursorLike).call(client, cursor);
        while (true) {
          signal?.throwIfAborted();
          const result = await readCursor(cursor, batchSize, signal);
          const fields = result.fields ?? [];
          assertUniqueFields(fields);
          if (result.fields !== undefined && fields.length === 0) {
            throw new DatabaseResultKindError("rows", "command");
          }
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
          if (streamError !== undefined)
            throw cleanupAggregate([streamError, cleanup], "PostgreSQL cursor cleanup failed.", streamError);
          throw cleanup;
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
      assertPgRoutineDirections(rendered);
      assertParameterHintsUnsupported(rendered);
      const transactionScoped =
        binding === undefined ? false : bindingContexts.get(binding)?.transactionScoped === true;
      if (hasRefcursor(rendered) && !transactionScoped) {
        throw unsupported(
          "routine.out-cursor",
          "BRAID_CALL_CURSOR_TX_REQUIRED",
          "PostgreSQL refcursor calls require an existing transaction.",
        );
      }
      const result = await withPgCancellation(client, executionOptions?.signal, () =>
        client.query(materialize(rendered, binding, types)),
      );
      assertUniqueFields(result.fields ?? []);
      const output = outputRow(result, rendered, policy);
      const cursorParameters = rendered.parameters.filter(isRefcursor);
      if (cursorParameters.length === 0) {
        const rows = rendered.parameters.some(
          (parameter) => parameter.direction !== undefined && parameter.direction !== "in",
        )
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
          throw unsupported(
            "routine.out-cursor",
            "BRAID_CALL_CURSOR_UNSUPPORTED",
            `PostgreSQL refcursor output ${name ?? "<unnamed>"} did not return a portal name.`,
          );
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
          const fetched = await withPgCancellation(client, executionOptions?.signal, () =>
            client.query({ text: `FETCH ALL FROM ${quotePortal(entry.portal)}`, values: [], types }),
          );
          assertUniqueFields(fetched.fields ?? []);
          resultSets.push({
            rows: fetched.rows.map((row) => plainRow(row, fetched.fields ?? [], policy)),
            source: {
              kind: "out-cursor",
              name: entry.outputName,
              parameterIndex: rendered.parameters.findIndex((parameter) => parameter.outputName === entry.outputName),
            },
          });
          await withPgCancellation(client, executionOptions?.signal, () =>
            client.query({ text: `CLOSE ${quotePortal(entry.portal)}`, values: [] }),
          );
          live.shift();
        }
      } catch (error) {
        failure = error;
      }
      const cleanupErrors: unknown[] = [];
      for (const entry of live) {
        try {
          await withPgCancellation(client, executionOptions?.signal, () =>
            client.query({ text: `CLOSE ${quotePortal(entry.portal)}`, values: [] }),
          );
        } catch (error) {
          cleanupErrors.push(cleanupFailure(`PostgreSQL refcursor ${entry.outputName} close failed.`, error));
        }
      }
      if (failure !== undefined) {
        if (cleanupErrors.length > 0)
          throw cleanupAggregate([failure, ...cleanupErrors], "PostgreSQL refcursor cleanup failed.", failure);
        throw failure;
      }
      if (cleanupErrors.length > 0) throw cleanupAggregate(cleanupErrors, "PostgreSQL refcursor cleanup failed.");
      return { output: normalizedOutput, resultSets };
    },
    begin: async (transactionOptions) => {
      await runControl(postgresBeginSql(transactionOptions));
    },
    commit: () => runControl("COMMIT"),
    rollback: () => runControl("ROLLBACK"),
    savepoint: (name) => runControl(`SAVEPOINT ${assertSavepointName(name)}`),
    rollbackTo: (name) => runControl(`ROLLBACK TO SAVEPOINT ${assertSavepointName(name)}`),
    releaseSavepoint: (name) => runControl(`RELEASE SAVEPOINT ${assertSavepointName(name)}`),
  };
}

/** Wrap one connected `pg` client as an application database. */
export function createPgDatabase(client: PgClientLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, profile, cursor, streamBatchSize, parserProfile, ...databaseOptions } = options;
  return createDatabase(
    createPgExecutor(client, { typePolicy, profile, cursor, streamBatchSize, parserProfile }),
    databaseOptions,
  );
}

/** Create a lease provider from a `pg` pool; discarded leases call `client.release(true)`. */
export function createPgPoolProvider(pool: PgPoolLike, options: PgExecutorOptions = {}): ConnectionProvider {
  resolveStreamBatchSize(options.streamBatchSize);
  const profile = resolveParserProfile(options.parserProfile, options.profile);
  const profilePolicy = options.profile?.typePolicy ?? typePolicyForProfile(profile);
  const policy = options.typePolicy ?? profilePolicy;
  const firstPartyProfile =
    options.profile === undefined || representationProfiles.some((entry) => entry === options.profile);
  return {
    statementBinding: pgStatementBinding,
    environment:
      policy === profilePolicy && firstPartyProfile
        ? pgEnvironmentFor(profile, policy)
        : {
            ...pgEnvironmentFor(profile, profilePolicy),
            driver: { id: "pg", profile: "custom-type-policy" },
            typePolicy: { id: policy.id, hash: policy.hash },
            capabilities: pgExecutionCapabilities,
          },
    async acquire(): Promise<ConnectionLease> {
      const client = await pool.connect();
      try {
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
      } catch (error) {
        try {
          await client.release();
        } catch (cleanup) {
          throw cleanupAggregate([error, cleanup], "PostgreSQL pool initialization cleanup failed.", error);
        }
        throw error;
      }
    },
  };
}

/** Wrap a `pg` pool as a pooled application database with one lease per root operation. */
export function createPgPoolDatabase(pool: PgPoolLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, profile, cursor, streamBatchSize, parserProfile, ...databaseOptions } = options;
  return createPooledDatabase(
    createPgPoolProvider(pool, { typePolicy, profile, cursor, streamBatchSize, parserProfile }),
    databaseOptions,
  );
}

export { representationProfiles, typePolicyForProfile } from "./type-policy.js";
export type { PgRepresentationProfile, PgRepresentationProfileOptions } from "./type-policy.js";
