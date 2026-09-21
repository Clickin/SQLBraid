import type { StandardSchemaV1 } from "@standard-schema/spec";

export type { StandardSchemaV1 } from "@standard-schema/spec";

export const SQL_FRAGMENT = Symbol.for("sqlbraid.fragment");

const SQL_BOUND_PARAMETER = Symbol.for("sqlbraid.bound-parameter");
const knownBoundParameters = new WeakSet<object>();
declare const boundParameterBrand: unique symbol;
const SQL_ROUTINE_PARAMETER = Symbol.for("sqlbraid.routine-parameter");
const knownRoutineParameters = new WeakSet<object>();

/** Half-open source range in the cooked template text, used for diagnostics and source mapping. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** Safety bounds applied while parsing and rendering dynamic SQL. */
export interface RenderLimits {
  readonly maxSqlBytes?: number;
  readonly maxBindCount?: number;
  readonly maxStructuralItems?: number;
  readonly maxNestingDepth?: number;
}

/** Declared logical result channel; runtime checks the driver's actual result kind against it. */
export type QueryResultKind = "rows" | "command" | "call" | "unknown";
export { AUTHORING_MODULE_CATALOG, type AuthoringModuleCatalogEntry } from "./authoring-modules.js";
export {
  isWellKnownCapabilityId,
  WELL_KNOWN_CAPABILITIES,
  WELL_KNOWN_CAPABILITY_IDS,
  type CapabilityFamily,
  type WellKnownCapability,
  type WellKnownCapabilityId,
} from "./capabilities.js";

export type NumericSemantics = "exact-integer" | "exact-decimal" | "approximate-binary";

export type NumericRepresentation = "string" | "number";

export type TransportFidelity = "lossless" | "guarded" | "lossy" | "unsupported";

/** Database type semantics, JavaScript representation, and transport-fidelity claim for one mapping. */
export interface NumericTypeContract {
  readonly semantics: NumericSemantics;
  readonly representation: NumericRepresentation;
  readonly fidelity: TransportFidelity;
  readonly binaryPrecision?: 32 | 64;
}

export interface ExactIntegerRange {
  readonly min?: bigint;
  readonly max?: bigint;
}

/** Thrown when a driver value cannot be represented without losing database information. */
export class ResultExactnessError extends Error {
  static readonly code = "BRAID_RESULT_EXACTNESS" as const;
  readonly code = ResultExactnessError.code;

  constructor(message = "Result value does not have an exact representation.") {
    super(message);
    this.name = "ResultExactnessError";
  }
}

export type PublicErrorCategory = "runtime" | "adapter" | "compiler";

/** One deliberately public SQLBraid error code; an arbitrary `BRAID_` message is not automatically public. */
export interface PublicErrorDefinition {
  readonly code: string;
  readonly category: PublicErrorCategory;
  readonly owner: string;
  /**
   * UnsupportedFeatureError only: features for which this code is a public
   * contract. Other public errors intentionally omit this metadata.
   */
  readonly features?: readonly string[];
}

/**
 * The intentionally small compatibility boundary for SQLBraid-owned errors.
 *
 * Keep this registry explicit.  In particular, a BRAID_ token in a driver
 * message or an internal compiler fallback is not public merely because it
 * happens to use the project prefix.
 */
export const PUBLIC_ERROR_DEFINITIONS: readonly PublicErrorDefinition[] = Object.freeze([
  { code: "BRAID_RESULT_EXACTNESS", category: "runtime", owner: "ResultExactnessError" },
  { code: "BRAID_CALL_MAP", category: "runtime", owner: "RoutineMappingError" },
  { code: "BRAID_RESULT_KIND", category: "runtime", owner: "@sqlbraid/runtime:DatabaseResultKindError" },
  { code: "BRAID_RESULT_VALIDATION", category: "runtime", owner: "@sqlbraid/runtime:DatabaseResultValidationError" },
  { code: "BRAID_BATCH_ABORTED", category: "runtime", owner: "runtime batch lifecycle/synthetic observer error" },
  { code: "BRAID_TX_SCOPE", category: "runtime", owner: "@sqlbraid/runtime:DatabaseScopeError" },
  { code: "BRAID_TX_CLOSED", category: "runtime", owner: "@sqlbraid/runtime:DatabaseScopeError" },
  { code: "BRAID_SESSION_SCOPE", category: "runtime", owner: "@sqlbraid/runtime:DatabaseScopeError" },
  { code: "BRAID_SESSION_CLOSED", category: "runtime", owner: "@sqlbraid/runtime:DatabaseScopeError" },
  { code: "BRAID_CONNECTION_POISONED", category: "runtime", owner: "@sqlbraid/runtime:DatabaseScopeError" },
  { code: "BRAID_STREAM_SCOPE", category: "runtime", owner: "@sqlbraid/runtime:DatabaseScopeError" },
  { code: "BRAID_REENTRY", category: "runtime", owner: "@sqlbraid/runtime:DatabaseScopeError" },
  { code: "BRAID_TX_OPTIONS_NESTED", category: "runtime", owner: "@sqlbraid/runtime:DatabaseScopeError" },
  { code: "BRAID_CALL_UNSUPPORTED", category: "adapter", owner: "UnsupportedFeatureError", features: ["routine.call"] },
  {
    code: "BRAID_RESULT_SETS_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["routine.result-sets"],
  },
  {
    code: "BRAID_STREAM_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["statement.stream"],
  },
  {
    code: "BRAID_CANCEL_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["statement.cancel"],
  },
  {
    code: "BRAID_SESSION_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["session.pinned"],
  },
  {
    code: "BRAID_TX_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["transaction", "transaction.savepoint"],
  },
  { code: "BRAID_TX_OPTIONS_INVALID", category: "runtime", owner: "TypeError with code" },
  {
    code: "BRAID_TX_OPTION_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: [
      "transaction.read-only",
      "transaction.isolation.read-uncommitted",
      "transaction.isolation.read-committed",
      "transaction.isolation.repeatable-read",
      "transaction.isolation.serializable",
    ],
  },
  {
    code: "BRAID_CALL_RESULT_SETS",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["routine.result-sets"],
  },
  {
    code: "BRAID_CALL_CURSOR_TX_REQUIRED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["routine.out-cursor"],
  },
  {
    code: "BRAID_CALL_OUT_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["routine.out", "routine.inout"],
  },
  {
    code: "BRAID_CALL_RETURN_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["routine.call", "routine.return-value"],
  },
  {
    code: "BRAID_CALL_CURSOR_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["routine.out-cursor"],
  },
  {
    code: "BRAID_RESOURCE_CLEANUP",
    category: "adapter",
    owner: "adapter cleanup error with code",
    features: ["resource.cleanup", "resource.discard"],
  },
  {
    code: "BRAID_BIND_HINT_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["statement.bind-hint"],
  },
  { code: "BRAID_BIND_VALUE_UNSUPPORTED", category: "adapter", owner: "AdapterError" },
  {
    code: "BRAID_INTEGER_MODE_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["result.exact-integer"],
  },
  {
    code: "BRAID_CALL_LOB_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["routine.out"],
  },
  {
    code: "BRAID_BULK_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["statement.bulk"],
  },
  {
    code: "BRAID_PREPARE_UNSUPPORTED",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["statement.prepare"],
  },
  { code: "BRAID_DIALECT_MISMATCH", category: "adapter", owner: "UnsupportedFeatureError", features: ["dialect"] },
  {
    code: "BRAID_RESULT_KIND_AMBIGUOUS",
    category: "adapter",
    owner: "UnsupportedFeatureError",
    features: ["result.rows", "result.command"],
  },
  { code: "BRAID_PREPARED_NAME", category: "runtime", owner: "prepared query validation" },
  { code: "BRAID_PREPARED_SHAPE", category: "runtime", owner: "prepared query validation" },
  { code: "BRAID_BIND_TYPE_REQUIRED", category: "adapter", owner: "AdapterError" },
  { code: "BRAID_EMPTY_LIST", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_EMPTY_SET", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_DIALECT", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_ASYNC_CONTEXT", category: "compiler", owner: "compiler diagnostic" },
  { code: "BRAID_DIRECTIVE_UNTERMINATED", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_DIRECTIVE", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_CONDITION", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_ATTRIBUTES", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_STRUCTURE", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_HOLE_CONTEXT", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_SQL_LEX", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_DEPTH", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_STRUCTURE_LIMIT", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_SQL_LIMIT", category: "runtime", owner: "SqlRenderError" },
  { code: "BRAID_BIND_LIMIT", category: "runtime", owner: "SqlRenderError" },
] as const);

function exactnessFailure(message: string): never {
  throw new ResultExactnessError(message);
}

/**
 * Decode an exact integer from driver output, optionally enforcing bigint bounds.
 *
 * @throws {ResultExactnessError} When the value is not an exact integer or violates the requested range.
 */
export function decodeExactInteger(value: unknown, range?: ExactIntegerRange): bigint {
  let result: bigint;
  if (typeof value === "bigint") {
    result = value;
  } else if (typeof value === "string" && /^[+-]?\d+$/u.test(value)) {
    try {
      result = BigInt(value);
    } catch {
      return exactnessFailure("Result value does not have an exact integer representation.");
    }
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    result = BigInt(value);
  } else {
    return exactnessFailure("Result value does not have an exact integer representation.");
  }

  if (range !== undefined) {
    if (
      (range.min !== undefined && typeof range.min !== "bigint") ||
      (range.max !== undefined && typeof range.max !== "bigint") ||
      (range.min !== undefined && range.max !== undefined && range.min > range.max)
    ) {
      throw new TypeError("Exact integer range bounds must be ordered bigint values.");
    }
    if (range.min !== undefined && result < range.min) {
      return exactnessFailure("Result exact integer is below the configured minimum.");
    }
    if (range.max !== undefined && result > range.max) {
      return exactnessFailure("Result exact integer is above the configured maximum.");
    }
  }
  return result;
}

/**
 * Normalize an exact integer at the raw SQLBraid boundary without changing
 * its textual spelling. This is intentionally not a bigint decoder: callers
 * that need arithmetic may opt in to decodeExactInteger().
 */
export function normalizeExactInteger(value: unknown): string {
  if (typeof value === "string" && /^[+-]?\d+$/u.test(value)) return value;
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return exactnessFailure("Result value does not have an exact integer representation.");
}

/**
 * Convert a database-reported count to a safe operational Number. Counts are
 * not application values, so unlike exact SQL numerics they remain numbers,
 * but narrowing an unsafe value is never implicit.
 */
export function safeDatabaseCount(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value === 0 ? 0 : value;
    return exactnessFailure("Database count is not a safe non-negative integer.");
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return exactnessFailure("Database count is not a safe non-negative integer.");
    }
    return Number(value);
  }
  if (typeof value === "string" && /^[+]?\d+$/u.test(value)) {
    try {
      const count = BigInt(value);
      if (count >= 0n && count <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(count);
    } catch {
      // Fall through to the common exactness error.
    }
  }
  return exactnessFailure("Database count is not a safe non-negative integer.");
}

/**
 * Preserve an exact decimal as text; numeric JavaScript values are rejected because they may already be rounded.
 *
 * @throws {ResultExactnessError} When the value cannot prove exact decimal fidelity.
 */
export function decodeExactDecimal(value: unknown, options?: { readonly allowBigInt?: boolean }): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint" && options?.allowBigInt === true) return value.toString();
  return exactnessFailure("Result value does not have an exact decimal representation.");
}

export type RoutineParameterDirection = "in" | "out" | "inout";

/** Optional routine identity metadata used by procedure-aware adapters and prepared-shape checks. */
export interface RoutineProcedure {
  readonly name: string;
  readonly parameterNames: readonly string[];
}

export type RoutineSchema = StandardSchemaV1<any, any>;

/**
 * Application mapping contracts for routine OUT values, result sets, and return values.
 * Each channel is independent; an OUT cursor is represented as a result set, not as scalar output.
 */
export interface RoutineContract<
  Output extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
  Sets extends readonly RoutineSchema[] = readonly RoutineSchema[],
  ReturnValue = unknown,
> {
  readonly output?: StandardSchemaV1<any, Output>;
  readonly resultSets?: Sets;
  readonly returnValue?: StandardSchemaV1<any, ReturnValue>;
  readonly procedure?: RoutineProcedure;
}

/**
 * A rendered parameter is always a value. Adapters MUST NOT interpret it as
 * raw SQL, an identifier, a nested query, a driver-specific fragment, or a
 * structural tagged-template command.
 */
export interface RenderedParameter {
  readonly value: unknown;
  readonly interpolation?: number;
  readonly hint?: ParameterTypeHint;
  readonly direction?: RoutineParameterDirection;
  readonly outputName?: string;
}

/**
 * Immutable logical statement before driver materialization.
 * `segments.length` is always `parameters.length + 1`; structural SQL lives in segments and parameters remain values.
 */
export interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  /**
   * Optional native tagged-template carrier. This preserves the original
   * TemplateStringsArray when a driver can bind values through its native tag.
   * It is metadata only; segments/parameters remain the logical statement.
   */
  readonly nativeTemplate?: TemplateStringsArray;
  readonly dialectId: string;
  readonly resultKind: QueryResultKind;
  readonly routineProcedure?: RoutineProcedure;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}

/** Explicit database-type metadata for one bound value; this is not application validation or an input codec. */
export interface ParameterTypeHint<Input = unknown> {
  readonly databaseType: string;
  readonly length?: number | "max";
  readonly precision?: number;
  readonly scale?: number;
  readonly __input?: Input;
}

/** Value plus an explicit database type hint, created by `sql.bind()`. */
export interface BoundParameter<Input = unknown> {
  readonly value: Input;
  readonly hint: ParameterTypeHint<Input>;
  readonly [boundParameterBrand]: true;
}

/** Value-only routine OUT/INOUT marker; the direction and output name are interpreted by the adapter. */
export interface RoutineParameter<Input = unknown> {
  readonly value: Input;
  readonly hint?: ParameterTypeHint;
  readonly direction: Exclude<RoutineParameterDirection, "in">;
  readonly outputName: string;
}

function validHintNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function validHintInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isParameterTypeHint(value: unknown): value is ParameterTypeHint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as {
    readonly databaseType?: unknown;
    readonly length?: unknown;
    readonly precision?: unknown;
    readonly scale?: unknown;
  };
  return (
    typeof candidate.databaseType === "string" &&
    candidate.databaseType.trim().length > 0 &&
    (candidate.length === undefined || candidate.length === "max" || validHintNumber(candidate.length)) &&
    (candidate.precision === undefined || validHintNumber(candidate.precision)) &&
    (candidate.scale === undefined || validHintInteger(candidate.scale))
  );
}

/** Validate and freeze an explicit database parameter-type hint. */
export function createParameterTypeHint<Input = unknown>(hint: ParameterTypeHint<Input>): ParameterTypeHint<Input> {
  if (!isParameterTypeHint(hint)) throw new TypeError("sql.bind hint must be an object with valid structural fields.");
  const candidate = hint as {
    readonly databaseType?: unknown;
    readonly length?: unknown;
    readonly precision?: unknown;
    readonly scale?: unknown;
  };
  if (typeof candidate.databaseType !== "string" || !candidate.databaseType.trim())
    throw new TypeError("sql.bind hint databaseType must be a non-empty string.");
  if (candidate.length !== undefined && candidate.length !== "max" && !validHintNumber(candidate.length))
    throw new TypeError('sql.bind hint length must be a non-negative integer or "max".');
  if (candidate.precision !== undefined && !validHintNumber(candidate.precision))
    throw new TypeError("sql.bind hint precision must be a non-negative integer.");
  if (candidate.scale !== undefined && !validHintInteger(candidate.scale))
    throw new TypeError("sql.bind hint scale must be an integer.");
  const normalized = {
    databaseType: candidate.databaseType,
    ...(candidate.length === undefined ? {} : { length: candidate.length }),
    ...(candidate.precision === undefined ? {} : { precision: candidate.precision }),
    ...(candidate.scale === undefined ? {} : { scale: candidate.scale }),
  } as ParameterTypeHint<Input>;
  return Object.freeze(normalized);
}

/** Create the value-only marker consumed by adapter binding for an explicitly typed input. */
export function createBoundParameter<Input>(
  value: NoInfer<Input>,
  hint: ParameterTypeHint<Input>,
): BoundParameter<Input> {
  const normalizedHint = createParameterTypeHint(hint);
  const bound = Object.freeze({ value, hint: normalizedHint, [SQL_BOUND_PARAMETER]: true });
  knownBoundParameters.add(bound);
  return bound as unknown as BoundParameter<Input>;
}

/** Recognize only bound-parameter objects created by SQLBraid's own constructor. */
export function isBoundParameter(value: unknown): value is BoundParameter {
  if (
    typeof value !== "object" ||
    value === null ||
    !knownBoundParameters.has(value) ||
    !Object.hasOwn(value, SQL_BOUND_PARAMETER)
  )
    return false;
  const candidate = value as {
    readonly value?: unknown;
    readonly hint?: unknown;
    readonly [SQL_BOUND_PARAMETER]?: unknown;
  };
  return (
    candidate[SQL_BOUND_PARAMETER] === true && Object.hasOwn(candidate, "value") && isParameterTypeHint(candidate.hint)
  );
}

function normalizeOutputName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("Routine outputName must be a non-empty string.");
  return name;
}

/** Create a value-only OUT parameter descriptor; the adapter supplies the native carrier. */
export function createRoutineOutParameter(name: string, hint?: ParameterTypeHint): RoutineParameter<null> {
  const normalizedHint = hint === undefined ? undefined : createParameterTypeHint(hint);
  const parameter = Object.freeze({
    value: null,
    direction: "out" as const,
    outputName: normalizeOutputName(name),
    ...(normalizedHint === undefined ? {} : { hint: normalizedHint }),
    [SQL_ROUTINE_PARAMETER]: true as const,
  });
  knownRoutineParameters.add(parameter);
  return parameter;
}

/** Create a value-only INOUT parameter descriptor; input value and output channel stay distinct. */
export function createRoutineInOutParameter<Input>(
  name: string,
  value: NoInfer<Input>,
  hint?: ParameterTypeHint<Input>,
): RoutineParameter<Input> {
  const normalizedHint = hint === undefined ? undefined : createParameterTypeHint(hint);
  const parameter = Object.freeze({
    value,
    direction: "inout" as const,
    outputName: normalizeOutputName(name),
    ...(normalizedHint === undefined ? {} : { hint: normalizedHint }),
    [SQL_ROUTINE_PARAMETER]: true as const,
  });
  knownRoutineParameters.add(parameter);
  return parameter as RoutineParameter<Input>;
}

/** Recognize only routine OUT/INOUT descriptors created by SQLBraid's own constructor. */
export function isRoutineParameter(value: unknown): value is RoutineParameter {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !knownRoutineParameters.has(value))
    return false;
  const candidate = value as {
    readonly value?: unknown;
    readonly direction?: unknown;
    readonly outputName?: unknown;
    readonly hint?: unknown;
    readonly [SQL_ROUTINE_PARAMETER]?: unknown;
  };
  return (
    candidate[SQL_ROUTINE_PARAMETER] === true &&
    Object.hasOwn(candidate, "value") &&
    (candidate.direction === "out" || candidate.direction === "inout") &&
    typeof candidate.outputName === "string" &&
    Boolean(candidate.outputName.trim()) &&
    (candidate.hint === undefined || isParameterTypeHint(candidate.hint))
  );
}

export type ParameterTransportKind = "native-value-template" | "text-positional" | "text-named" | "typed-request";

export type RequestedReuse = "auto" | "simple" | "reuse";
export type EffectiveReuse = "simple" | "reuse";
export type ReuseOwner = "sqlbraid" | "driver" | "server";

/** Inputs to pure binding description. Placeholder syntax and prepared reuse remain adapter-owned. */
export interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: RequestedReuse;
  readonly preparedName?: string;
  readonly transactionScoped?: boolean;
}

export interface BindingDescription {
  readonly index: number;
  readonly name?: string;
  readonly interpolation?: number;
  readonly hint?: ParameterTypeHint;
  readonly direction?: RoutineParameterDirection;
  readonly outputName?: string;
}

/** Diagnostic-only literalization controls; the result must never be sent to a database. */
export interface LiteralizeOptions {
  readonly values?: "inline" | "redacted";
  readonly maxValueLength?: number;
  readonly binary?: "summary" | "full";
  readonly redact?: (parameter: RenderedParameter, index: number) => boolean;
}

/** Diagnostic SQL reconstruction with explicit redaction/truncation evidence. */
export interface LiteralizedSqlResult {
  readonly text: string;
  /**
   * True when no diagnostic parameter representation was truncated. Redaction,
   * unsupported literal markers, and divergence from wire SQL do not make it
   * incomplete.
   */
  readonly complete: boolean;
  readonly redactedParameters: number;
  readonly truncatedParameters: number;
}

/**
 * Immutable transport description derived from one logical statement.
 * `literalizedSql()` reconstructs diagnostics from segments and values; it is never execution input.
 */
export interface StatementBindingDescription {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: ParameterTransportKind;
  readonly parameterizedSql?: string;
  readonly bindings: readonly BindingDescription[];
  readonly reuse: {
    readonly requested: RequestedReuse;
    readonly effective: EffectiveReuse;
    readonly owner: ReuseOwner;
    readonly capacity?: number;
  };
  /** Diagnostic reconstruction only; never use this text as execution input. */
  readonly literalizedSql: (options?: LiteralizeOptions) => LiteralizedSqlResult;
}

/**
 * Driver-owned binding policy. Implementations choose transport, placeholders, type encoding, and reuse ownership.
 * `describe` must be pure and safe to run before connection acquisition.
 */
export interface StatementBindingAdapter {
  readonly id: string;
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription;
  describeBulk?(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription;
}

export interface StatementBindingDescriptionOptions {
  readonly adapterId: string;
  readonly transport: ParameterTransportKind;
  readonly placeholder?: (index: number) => string;
  readonly reuse: {
    readonly effective: EffectiveReuse;
    readonly owner: ReuseOwner;
    readonly capacity?: number;
  };
  readonly formatLiteral?: (
    parameter: RenderedParameter,
    index: number,
    options: LiteralizeOptions,
  ) => string | undefined;
}

/** One logical command shape plus its value matrix; all rows must remain homogeneous. */
export interface RenderedBulk {
  readonly statement: RenderedStatement;
  readonly parameterSets: readonly (readonly unknown[])[];
}

/** Binding metadata for a homogeneous bulk operation; values are fetched by item index. */
export interface BulkBindingDescription {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: ParameterTransportKind;
  readonly parameterizedSql?: string;
  readonly bindings: readonly BindingDescription[];
  readonly itemCount: number;
  valuesAt(index: number): readonly unknown[];
  literalizedSql(index: number, options?: LiteralizeOptions): LiteralizedSqlResult;
}

/**
 * Normalize and snapshot a homogeneous bulk's logical statement and value
 * matrix. Values themselves are application-owned and are not cloned.
 */
export function createRenderedBulk(bulk: RenderedBulk): RenderedBulk {
  if (bulk === null || typeof bulk !== "object" || Array.isArray(bulk)) {
    throw new TypeError("RenderedBulk must be an object.");
  }
  const statement = createRenderedStatement(bulk.statement);
  if (!Array.isArray(bulk.parameterSets)) {
    throw new TypeError("RenderedBulk parameterSets must be an array.");
  }
  const parameterCount = statement.parameters.length;
  const parameterSets = Object.freeze(
    bulk.parameterSets.map((values) => {
      if (!Array.isArray(values) || values.length !== parameterCount) {
        throw new TypeError("RenderedBulk parameter sets must match the rendered parameter count.");
      }
      for (let index = 0; index < values.length; index += 1) {
        if (values[index] === undefined && statement.parameters[index]?.direction !== "out") {
          throw new SqlRenderError(
            "BRAID_BIND_VALUE_UNSUPPORTED",
            "Undefined bind values are unsupported; use null for SQL NULL.",
          );
        }
      }
      return Object.isFrozen(values) ? values : Object.freeze([...values]);
    }),
  );
  return Object.freeze({ statement, parameterSets });
}

const knownRenderedStatements = new WeakSet<object>();

function copyRenderedParameter(parameter: RenderedParameter): RenderedParameter {
  if (typeof parameter !== "object" || parameter === null || Array.isArray(parameter)) {
    throw new TypeError("RenderedStatement parameters must be parameter records.");
  }
  const candidate = parameter as {
    readonly value?: unknown;
    readonly interpolation?: unknown;
    readonly hint?: unknown;
    readonly direction?: unknown;
    readonly outputName?: unknown;
  };
  if (!Object.hasOwn(candidate, "value")) throw new TypeError("RenderedStatement parameters must contain a value.");
  const interpolation = candidate.interpolation;
  if (interpolation !== undefined && !validHintNumber(interpolation)) {
    throw new TypeError("RenderedStatement parameter interpolation must be a non-negative integer.");
  }
  const hint = candidate.hint === undefined ? undefined : createParameterTypeHint(candidate.hint as ParameterTypeHint);
  const direction = candidate.direction;
  if (direction !== undefined && direction !== "in" && direction !== "out" && direction !== "inout") {
    throw new TypeError("RenderedStatement parameter direction is unsupported.");
  }
  const outputName = candidate.outputName;
  if (outputName !== undefined && (typeof outputName !== "string" || !outputName.trim())) {
    throw new TypeError("RenderedStatement parameter outputName must be a non-empty string.");
  }
  if ((direction === "out" || direction === "inout") && outputName === undefined) {
    throw new TypeError("RenderedStatement OUT and INOUT parameters require an outputName.");
  }
  if (outputName !== undefined && (direction === undefined || direction === "in")) {
    throw new TypeError("RenderedStatement parameter outputName requires an OUT or INOUT direction.");
  }
  if (candidate.value === undefined && direction !== "out") {
    throw new SqlRenderError(
      "BRAID_BIND_VALUE_UNSUPPORTED",
      "Undefined bind values are unsupported; use null for SQL NULL.",
    );
  }
  return Object.freeze({
    value: candidate.value,
    ...(interpolation === undefined ? {} : { interpolation }),
    ...(hint === undefined ? {} : { hint }),
    ...(direction === undefined ? {} : { direction }),
    ...(outputName === undefined ? {} : { outputName }),
  });
}

function copyRoutineProcedure(procedure: RoutineProcedure | undefined): RoutineProcedure | undefined {
  if (procedure === undefined) return undefined;
  if (
    typeof procedure !== "object" ||
    procedure === null ||
    typeof procedure.name !== "string" ||
    !procedure.name.trim()
  ) {
    throw new TypeError("Routine procedure name must be a non-empty string.");
  }
  if (!Array.isArray(procedure.parameterNames))
    throw new TypeError("Routine procedure parameterNames must be an array.");
  const parameterNames = procedure.parameterNames.map((name) => {
    if (typeof name !== "string" || !name.trim())
      throw new TypeError("Routine procedure parameterNames must contain non-empty strings.");
    return name;
  });
  if (new Set(parameterNames).size !== parameterNames.length)
    throw new TypeError("Routine procedure parameterNames must be unique.");
  return Object.freeze({ name: procedure.name, parameterNames: Object.freeze(parameterNames) });
}

function copyNativeTemplate(value: unknown, segments: readonly string[]): TemplateStringsArray {
  if (!Array.isArray(value) || value.length !== segments.length) {
    throw new TypeError("RenderedStatement nativeTemplate must have one string per segment boundary.");
  }
  if (value.some((segment) => typeof segment !== "string")) {
    throw new TypeError("RenderedStatement nativeTemplate must contain cooked strings.");
  }
  if (value.some((segment, index) => segment !== segments[index])) {
    throw new TypeError("RenderedStatement nativeTemplate cooked strings must match logical segments.");
  }
  const raw = (value as { readonly raw?: unknown }).raw;
  if (!Array.isArray(raw) || raw.length !== value.length || raw.some((segment) => typeof segment !== "string")) {
    throw new TypeError("RenderedStatement nativeTemplate.raw must contain one raw string per segment boundary.");
  }
  if (Object.isFrozen(value) && Object.isFrozen(raw)) return value as unknown as TemplateStringsArray;
  const cooked = [...value] as string[] & { raw: readonly string[] };
  const frozenRaw = Object.freeze([...raw]);
  Object.defineProperty(cooked, "raw", {
    configurable: false,
    enumerable: false,
    value: frozenRaw,
    writable: false,
  });
  return Object.freeze(cooked) as unknown as TemplateStringsArray;
}

/** Validate and freeze one logical statement without creating a second mutable SQL/value source of truth. */
/** @throws {TypeError|SqlRenderError} For broken segment/parameter invariants or unsupported bind values. */
export function createRenderedStatement(statement: {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly nativeTemplate?: TemplateStringsArray;
  readonly resultKind: QueryResultKind;
  readonly routineProcedure?: RoutineProcedure;
  readonly dialectId: string;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}): RenderedStatement {
  if (typeof statement !== "object" || statement === null) throw new TypeError("RenderedStatement must be an object.");
  if (knownRenderedStatements.has(statement)) return statement as RenderedStatement;
  if (!Array.isArray(statement.segments)) {
    throw new TypeError("RenderedStatement segments must be an array of strings.");
  }
  if (!Array.isArray(statement.parameters)) throw new TypeError("RenderedStatement parameters must be an array.");
  if (statement.segments.length !== statement.parameters.length + 1) {
    throw new TypeError("RenderedStatement invariant violated: segments.length must equal parameters.length + 1.");
  }
  if (statement.resultKind !== "call" && statement.routineProcedure !== undefined) {
    throw new TypeError("Routine procedure metadata is only valid for call statements.");
  }
  if (typeof statement.dialectId !== "string" || !statement.dialectId)
    throw new TypeError("RenderedStatement dialectId must be a non-empty string.");
  const segments = Object.freeze([...statement.segments]);
  if (segments.some((segment) => typeof segment !== "string"))
    throw new TypeError("RenderedStatement segments must be an array of strings.");
  const nativeTemplate =
    statement.nativeTemplate === undefined ? undefined : copyNativeTemplate(statement.nativeTemplate, segments);
  const parameters = Object.freeze(Array.from(statement.parameters, copyRenderedParameter));
  if (parameters.some((parameter) => parameter.direction === "inout" && statement.resultKind !== "call")) {
    throw new TypeError("INOUT parameters are only valid for call statements.");
  }
  if (
    parameters.some(
      (parameter) =>
        parameter.direction === "out" && statement.resultKind !== "call" && statement.resultKind !== "rows",
    )
  ) {
    throw new TypeError("OUT parameters are only valid for call and rows statements.");
  }
  const outputNames = new Set<string>();
  for (const parameter of parameters) {
    if (parameter.outputName !== undefined) {
      if (outputNames.has(parameter.outputName))
        throw new TypeError(`Duplicate routine outputName: ${parameter.outputName}`);
      outputNames.add(parameter.outputName);
    }
  }
  const routineProcedure = copyRoutineProcedure(statement.routineProcedure);
  if (routineProcedure !== undefined && routineProcedure.parameterNames.length !== parameters.length) {
    throw new TypeError("Routine procedure parameterNames must match the rendered parameter count.");
  }
  const rendered = Object.freeze({
    segments,
    parameters,
    ...(nativeTemplate === undefined ? {} : { nativeTemplate }),
    dialectId: statement.dialectId,
    resultKind: statement.resultKind,
    ...(routineProcedure === undefined ? {} : { routineProcedure }),
    ...(statement.fingerprint === undefined ? {} : { fingerprint: statement.fingerprint }),
    ...(statement.variantFingerprint === undefined ? {} : { variantFingerprint: statement.variantFingerprint }),
  });
  knownRenderedStatements.add(rendered);
  return rendered;
}

/** Materialize placeholder text as a derived view; this helper does not own reuse or driver transport policy. */
export function parameterizedSql(statement: RenderedStatement, placeholder: (index: number) => string): string {
  const parts: string[] = [statement.segments[0] ?? ""];
  for (let index = 0; index < statement.parameters.length; index += 1) {
    parts.push(placeholder(index + 1), statement.segments[index + 1] ?? "");
  }
  return parts.join("");
}

function genericLiteral(parameter: RenderedParameter, dialectId: string, binary: "summary" | "full"): string {
  const value = parameter.value;
  if (value === null) return "NULL";
  if (value === undefined) return "[undefined]";
  if (typeof value === "string") {
    // Session SQL modes and character sets are unknown; this is not executable SQL.
    if (/^(?:mysql|mariadb)/i.test(dialectId)) return `[string ${JSON.stringify(value)}]`;
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === "boolean") {
    if (/^(?:mysql|sqlite)/i.test(dialectId) || /^(?:oracle|mssql|sqlserver)/i.test(dialectId))
      return value ? "1" : "0";
    if (/^(?:postgres|postgresql|cockroach|redshift)/i.test(dialectId)) return value ? "TRUE" : "FALSE";
    return `[boolean ${value ? "true" : "false"}]`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `[unsupported ${String(value)}]`;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) {
    try {
      const timestamp = Date.prototype.getTime.call(value);
      return Number.isNaN(timestamp) ? "[unsupported date]" : `[date ${Date.prototype.toISOString.call(value)}]`;
    } catch {
      return "[unsupported date]";
    }
  }
  if (value instanceof Uint8Array) {
    try {
      if (binary === "full") {
        let hex = "";
        for (const byte of value) hex += byte.toString(16).padStart(2, "0");
        return `X'${hex}'`;
      }
      return `[binary ${value.byteLength} bytes]`;
    } catch {
      return "[unsupported binary]";
    }
  }
  if (typeof value === "object") return "[unsupported object]";
  return `[unsupported ${typeof value}]`;
}

function literalized(
  statement: RenderedStatement,
  dialectId: string,
  formatLiteral: StatementBindingDescriptionOptions["formatLiteral"],
  options: LiteralizeOptions | undefined,
): LiteralizedSqlResult {
  const resolved: LiteralizeOptions = options ?? {};
  const valuesMode = resolved.values ?? "redacted";
  const maxLength = resolved.maxValueLength;
  if (valuesMode !== "inline" && valuesMode !== "redacted")
    throw new TypeError('literalizedSql values must be "inline" or "redacted".');
  if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 0)) {
    throw new TypeError("literalizedSql maxValueLength must be a non-negative integer.");
  }
  const binary = resolved.binary ?? "summary";
  if (binary !== "summary" && binary !== "full")
    throw new TypeError('literalizedSql binary must be "summary" or "full".');
  if (resolved.redact !== undefined && typeof resolved.redact !== "function")
    throw new TypeError("literalizedSql redact must be a function.");
  const parts: string[] = [statement.segments[0] ?? ""];
  let redactedParameters = 0;
  let truncatedParameters = 0;
  for (let index = 0; index < statement.parameters.length; index += 1) {
    const parameter = statement.parameters[index];
    const redact = valuesMode === "redacted" || resolved.redact?.(parameter, index) === true;
    let valueText: string;
    if (redact) {
      valueText = "[REDACTED]";
      redactedParameters += 1;
    } else {
      valueText = formatLiteral?.(parameter, index, resolved) ?? genericLiteral(parameter, dialectId, binary);
    }
    if (maxLength !== undefined && valueText.length > maxLength) {
      valueText = maxLength === 0 ? "" : valueText.slice(0, maxLength);
      truncatedParameters += 1;
    }
    parts.push(valueText, statement.segments[index + 1] ?? "");
  }
  return Object.freeze({
    text: parts.join(""),
    complete: truncatedParameters === 0,
    redactedParameters,
    truncatedParameters,
  });
}

/** Build an immutable binding description before I/O, including adapter reuse policy and diagnostic literalization. */
export function createStatementBindingDescription(
  statement: RenderedStatement,
  context: StatementBindingContext,
  options: StatementBindingDescriptionOptions,
): StatementBindingDescription {
  const logical = createRenderedStatement(statement);
  const adapterId = options.adapterId;
  const transport = options.transport;
  const placeholder = options.placeholder;
  const formatLiteral = options.formatLiteral;
  const effective = options.reuse.effective;
  const owner = options.reuse.owner;
  const capacity = options.reuse.capacity;
  const dialectId = context.dialectId;
  const requestedReuse = context.requestedReuse;
  if (logical.dialectId !== dialectId) {
    throw new TypeError(
      `BRAID_DIALECT: statement binding dialect ${dialectId} does not match rendered statement dialect ${logical.dialectId}.`,
    );
  }
  if (typeof adapterId !== "string" || !adapterId)
    throw new TypeError("Statement binding adapterId must be a non-empty string.");
  if (typeof dialectId !== "string" || !dialectId)
    throw new TypeError("Statement binding dialectId must be a non-empty string.");
  if (!["native-value-template", "text-positional", "text-named", "typed-request"].includes(transport)) {
    throw new TypeError("Statement binding transport is unsupported.");
  }
  if (transport !== "native-value-template" && placeholder === undefined) {
    throw new TypeError("Text and typed statement transports require a placeholder function.");
  }
  if (!["auto", "simple", "reuse"].includes(requestedReuse))
    throw new TypeError("Statement binding requestedReuse is unsupported.");
  if (!["simple", "reuse"].includes(effective) || !["sqlbraid", "driver", "server"].includes(owner)) {
    throw new TypeError("Statement binding reuse policy is unsupported.");
  }
  if (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 0)) {
    throw new TypeError("Statement binding reuse capacity must be a non-negative safe integer.");
  }
  if (placeholder !== undefined && typeof placeholder !== "function") {
    throw new TypeError("Statement binding placeholder must be a function.");
  }
  const bindings = Object.freeze(
    logical.parameters.map((parameter, offset) =>
      Object.freeze({
        index: offset + 1,
        ...(parameter.outputName === undefined ? {} : { name: parameter.outputName, outputName: parameter.outputName }),
        ...(parameter.interpolation === undefined ? {} : { interpolation: parameter.interpolation }),
        ...(parameter.hint === undefined ? {} : { hint: createParameterTypeHint(parameter.hint) }),
        ...(parameter.direction === undefined ? {} : { direction: parameter.direction }),
      }),
    ),
  );
  const reuse = Object.freeze({
    requested: requestedReuse,
    effective,
    owner,
    ...(capacity === undefined ? {} : { capacity }),
  });
  let parameterizedReady = false;
  let parameterized: string | undefined;
  const literalCache = new Map<string, LiteralizedSqlResult>();
  let defaultLiteralized: LiteralizedSqlResult | undefined;
  const description = {
    adapterId,
    dialectId,
    transport,
    bindings,
    reuse,
    literalizedSql: (literalOptions?: LiteralizeOptions): LiteralizedSqlResult => {
      if (literalOptions === undefined) {
        if (defaultLiteralized === undefined)
          defaultLiteralized = literalized(logical, dialectId, formatLiteral, undefined);
        return defaultLiteralized;
      }
      if (typeof literalOptions !== "object" || literalOptions === null)
        throw new TypeError("literalizedSql options must be an object.");
      const values = literalOptions.values;
      const binary = literalOptions.binary;
      const maxValueLength = literalOptions.maxValueLength;
      const redact = literalOptions.redact;
      const snapshot = Object.freeze({
        ...(values === undefined ? {} : { values }),
        ...(binary === undefined ? {} : { binary }),
        ...(maxValueLength === undefined ? {} : { maxValueLength }),
        ...(redact === undefined ? {} : { redact }),
      });
      const cacheKey =
        redact === undefined ? `${values ?? ""}\u0000${binary ?? ""}\u0000${maxValueLength ?? ""}` : undefined;
      if (cacheKey !== undefined) {
        const cached = literalCache.get(cacheKey);
        if (cached) return cached;
      }
      const result = literalized(logical, dialectId, formatLiteral, snapshot);
      if (cacheKey !== undefined) literalCache.set(cacheKey, result);
      return result;
    },
  } as StatementBindingDescription;
  if (placeholder !== undefined) {
    Object.defineProperty(description, "parameterizedSql", {
      enumerable: true,
      configurable: false,
      get: () => {
        if (!parameterizedReady) {
          parameterized = parameterizedSql(logical, placeholder);
          parameterizedReady = true;
        }
        return parameterized;
      },
    });
  }
  return Object.freeze(description);
}

/**
 * Build one binding description for a homogeneous bulk statement without cloning application-owned values.
 * Statement metadata is shared by every parameter set; values and diagnostics are addressed by item index.
 */
export function createBulkBindingDescription(
  bulk: RenderedBulk,
  context: StatementBindingContext,
  options: StatementBindingDescriptionOptions,
): BulkBindingDescription {
  const logical = createRenderedBulk(bulk);
  const statementBinding = createStatementBindingDescription(logical.statement, context, options);
  const parameterSets = logical.parameterSets;
  const itemCount = parameterSets.length;
  const valuesAt = (index: number): readonly unknown[] => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= itemCount) {
      throw new RangeError(`Bulk item index ${String(index)} is outside [0, ${itemCount}).`);
    }
    return parameterSets[index]!;
  };
  const literalizedSqlFor = (index: number, literalOptions?: LiteralizeOptions): LiteralizedSqlResult => {
    const values = valuesAt(index);
    const optionsSnapshot =
      literalOptions === undefined
        ? undefined
        : {
            ...(literalOptions.values === undefined ? {} : { values: literalOptions.values }),
            ...(literalOptions.binary === undefined ? {} : { binary: literalOptions.binary }),
            ...(literalOptions.maxValueLength === undefined ? {} : { maxValueLength: literalOptions.maxValueLength }),
            ...(literalOptions.redact === undefined ? {} : { redact: literalOptions.redact }),
          };
    const statement = {
      ...logical.statement,
      // oxlint-disable-next-line oxc/no-map-spread -- Each bulk item needs its own values without mutating shared readonly parameters.
      parameters: logical.statement.parameters.map((parameter, parameterIndex) => ({
        ...parameter,
        value: values[parameterIndex],
      })),
    };
    const result = createStatementBindingDescription(statement, context, options).literalizedSql(optionsSnapshot);
    return result;
  };
  const description = {
    adapterId: statementBinding.adapterId,
    dialectId: statementBinding.dialectId,
    transport: statementBinding.transport,
    bindings: statementBinding.bindings,
    itemCount,
    valuesAt,
    literalizedSql: literalizedSqlFor,
  } as BulkBindingDescription;
  if ("parameterizedSql" in statementBinding) {
    Object.defineProperty(description, "parameterizedSql", {
      enumerable: true,
      configurable: false,
      get: () => statementBinding.parameterizedSql,
    });
  }
  return Object.freeze(description);
}

/** Lexical features the template parser must know to avoid treating SQL text inside comments/quotes as directives. */
export interface DialectLexicalProfile {
  readonly lineCommentPrefixes: readonly string[];
  /** Require whitespace/control after -- (MySQL/MariaDB). Defaults to false. */
  readonly doubleDashRequiresWhitespace?: boolean;
  /** Characters that terminate a line comment. Defaults to CR and LF. */
  readonly lineCommentTerminators?: string;
  readonly supportsNestedBlockComments?: boolean;
  readonly supportsDollarQuotes?: boolean;
  readonly supportsBacktickIdentifiers?: boolean;
  readonly supportsBracketIdentifiers?: boolean;
  readonly supportsOracleQQuotes?: boolean;
  readonly backslashEscapes?: boolean;
}

/** SQL dialect boundary: identifier quoting plus lexical behavior used by template parsing and trimming. */
export interface Dialect {
  readonly id: string;
  quoteIdentifier(identifier: string): string;
  readonly lexicalProfile?: DialectLexicalProfile;
}

/** One database type's input/output representation and numeric fidelity claim. */
export interface TypeMapping {
  readonly databaseType: string;
  readonly inputType: string;
  readonly outputType: string;
  readonly nullable: boolean;
  readonly numeric?: NumericTypeContract;
}

/** Adapter type policy; it normalizes driver values and encodes inputs without becoming a schema validator. */
export interface TypePolicy {
  readonly id: string;
  readonly hash: string;
  readonly mappings: readonly TypeMapping[];
  decode(databaseType: string, value: unknown): unknown;
  encode(databaseType: string, value: unknown): unknown;
}

export interface TextNode {
  readonly kind: "text";
  readonly text: string;
  readonly range: SourceRange;
}

export interface BindNode {
  readonly kind: "bind";
  readonly interpolation: number;
  readonly range: SourceRange;
}

export interface FragmentNode {
  readonly kind: "fragment";
  readonly fragment: SqlFragment;
  readonly range: SourceRange;
}

export interface IdentifierNode {
  readonly kind: "identifier";
  readonly value: string | readonly string[];
  readonly range: SourceRange;
}

export interface RawNode {
  readonly kind: "raw";
  readonly text: string;
  readonly range: SourceRange;
}

export interface ListNode {
  readonly kind: "list";
  readonly values: readonly unknown[];
  readonly range: SourceRange;
}

export interface IfNode {
  readonly kind: "if";
  readonly condition: number;
  readonly children: readonly TemplateNode[];
  readonly range: SourceRange;
}

export interface ChooseWhen {
  readonly condition: number;
  readonly children: readonly TemplateNode[];
  readonly range: SourceRange;
}

export interface ChooseNode {
  readonly kind: "choose";
  readonly whens: readonly ChooseWhen[];
  readonly otherwise?: readonly TemplateNode[];
  readonly range: SourceRange;
}

export interface TrimAttributes {
  readonly prefix: string;
  readonly prefixOverrides: readonly string[];
  readonly suffix: string;
  readonly suffixOverrides: readonly string[];
}

export interface TrimNode {
  readonly kind: "trim";
  readonly attributes: TrimAttributes;
  readonly children: readonly TemplateNode[];
  readonly range: SourceRange;
}

export type TemplateNode =
  | TextNode
  | BindNode
  | FragmentNode
  | IdentifierNode
  | RawNode
  | ListNode
  | IfNode
  | ChooseNode
  | TrimNode;

/** Frozen template intermediate representation with source ranges and optional raw-text parallel nodes. */
export interface TemplateIr {
  readonly version: 1;
  readonly nodes: readonly TemplateNode[];
  readonly sourceLength: number;
  /**
   * Optional parallel node tree preserving raw JavaScript template text for
   * native tagged-template transports. The logical node tree remains cooked.
   */
  readonly rawNodes?: readonly TemplateNode[];
}

/** Explicit structural SQL fragment. Ordinary interpolations are values; fragments opt into SQL structure. */
export interface SqlFragment {
  readonly [SQL_FRAGMENT]: true;
  readonly ir: TemplateIr;
  readonly values: readonly unknown[];
  readonly dialectId: string;
}

/**
 * SQLBraid query value. It retains template IR and application mapping metadata until runtime rendering.
 * `resultSchema` is applied after driver materialization and is never forwarded to the driver.
 */
export interface Query<Row = unknown, Kind extends QueryResultKind = "unknown"> {
  readonly ir: TemplateIr;
  readonly values: readonly unknown[];
  readonly resultKind: Kind;
  /**
   * Application result mapper. Never forwarded to a DB driver.
   */
  readonly resultSchema?: StandardSchemaV1<unknown, Row>;
  readonly routineContract?: RoutineContract;
  render(): RenderedStatement;
  readonly __row?: Row;
}

export type RowQuery<Row = unknown> = Query<Row, "rows">;
export type CommandQuery = Query<CommandResult, "command">;
export type CallQuery<Result extends RoutineCallResult = RoutineCallResult> = Query<Result, "call">;

/** Driver-normalized command metadata; adapters may expose additional native fields without changing the kind. */
export interface CommandResult {
  readonly affectedRows?: number;
  readonly insertId?: string;
  readonly [key: string]: unknown;
}

/** Materialized row result. Runtime validates that it matches a rows query declaration. */
export interface RowsExecutionResult<Row = unknown> {
  readonly kind: "rows";
  readonly rows: readonly Row[];
  readonly rowCount?: number;
  readonly command?: never;
}

/** Materialized command result. Command executions intentionally expose no row payload. */
export interface CommandExecutionResult {
  readonly kind: "command";
  readonly rows: readonly [];
  readonly rowCount?: number;
  readonly command: CommandResult;
}

export type QueryExecutionResult<Row = unknown> = RowsExecutionResult<Row> | CommandExecutionResult;

/** Execution controls shared by materialized, routine, batch, and stream operations. */
export interface ExecutionOptions {
  readonly signal?: AbortSignal;
}

/** Physical SPI may complete synchronously; the public database surface remains asynchronous. */
export type Awaitable<T> = T | PromiseLike<T>;

/** Optional Standard Schema mapping applied after query-bound mapping and driver materialization. */
export interface RowValidationOptions<Row> extends ExecutionOptions {
  readonly schema?: StandardSchemaV1<unknown, NoInfer<Row>>;
}

export interface StreamOptions<Row> extends RowValidationOptions<Row> {}

/** Portable transaction isolation vocabulary; adapters reject levels they cannot provide. */
export type TransactionIsolation = "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";

/** Options for the outer physical transaction. Nested `db.tx()` calls are savepoints and accept no second option set. */
export interface TransactionOptions {
  readonly isolation?: TransactionIsolation;
  readonly readOnly?: boolean;
}

/** Public adapter capability failure. Unsupported features reject explicitly rather than being buffered or simulated. */
export class UnsupportedFeatureError extends Error {
  constructor(
    readonly feature: string,
    readonly code: `BRAID_${string}`,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "UnsupportedFeatureError";
  }
}

/** Return true only for a registered, semantically valid feature/code pair. */
export function isPublicUnsupportedFeatureError(error: unknown): error is UnsupportedFeatureError {
  if (!(error instanceof UnsupportedFeatureError)) return false;
  const definition = PUBLIC_ERROR_DEFINITIONS.find(
    (candidate) => candidate.owner === "UnsupportedFeatureError" && candidate.code === error.code,
  );
  return definition?.features?.includes(error.feature) === true;
}

/** An adapter-owned input/transport failure that retains TypeError semantics. */
export class AdapterError extends TypeError {
  constructor(
    readonly code: `BRAID_${string}`,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "AdapterError";
  }
}

/** One materialized routine result set, kept separate from scalar OUT and return-value channels. */
export interface RoutineResultSet<Row = unknown> {
  readonly rows: readonly Row[];
}

export type RoutineResultSetTuple<Sets extends readonly unknown[]> = {
  readonly [K in keyof Sets]: RoutineResultSet<Sets[K]>;
};

/** Application-facing routine result with independent output, result-set, and return-value channels. */
export interface RoutineCallResult<
  Output extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
  Sets extends readonly unknown[] = readonly unknown[],
  ReturnValue = unknown,
> {
  readonly output: Output;
  readonly resultSets: RoutineResultSetTuple<Sets>;
  readonly returnValue?: ReturnValue;
}

export type RoutineSchemaOutput<Schema> = Schema extends StandardSchemaV1<any, infer Output> ? Output : never;

type RoutineRowsFromSchemas<Schemas extends readonly RoutineSchema[]> = {
  readonly [K in keyof Schemas]: RoutineSchemaOutput<Schemas[K]>;
};

export type RoutineResultFromContract<Contract extends RoutineContract> = RoutineCallResult<
  Contract["output"] extends RoutineSchema
    ? RoutineSchemaOutput<Contract["output"]> extends Readonly<Record<string, unknown>>
      ? RoutineSchemaOutput<Contract["output"]>
      : Readonly<Record<string, unknown>>
    : Readonly<Record<string, unknown>>,
  Contract["resultSets"] extends infer Schemas extends readonly RoutineSchema[]
    ? RoutineRowsFromSchemas<Schemas>
    : readonly unknown[],
  Contract["returnValue"] extends RoutineSchema ? RoutineSchemaOutput<Contract["returnValue"]> : unknown
> &
  (Contract extends { readonly returnValue: RoutineSchema }
    ? { readonly returnValue: RoutineSchemaOutput<Contract["returnValue"]> }
    : {});

export type RoutineResultSource =
  | {
      readonly kind: "out-cursor";
      readonly name?: string;
      readonly parameterIndex?: number;
    }
  | {
      readonly kind: "implicit";
      readonly index: number;
    }
  | {
      readonly kind: "emitted";
      readonly index: number;
    };

/** Driver result-set payload with provenance for OUT cursors and emitted/implicit sets. */
export interface DriverRoutineResultSet {
  readonly rows: readonly unknown[];
  readonly source: RoutineResultSource;
}

/** Fully materialized routine result; native cursors, requests, and LOB handles must not escape this boundary. */
export interface DriverRoutineResult {
  readonly output: Readonly<Record<string, unknown>>;
  readonly returnValue?: unknown;
  readonly resultSets: readonly DriverRoutineResultSet[];
}

export type RoutineMappingLocation =
  | { readonly kind: "output" }
  | { readonly kind: "return-value" }
  | {
      readonly kind: "result-set";
      readonly resultSetIndex: number;
      readonly rowIndex: number;
    };

export type DriverCapabilityErrorCode =
  | "BRAID_STREAM_UNSUPPORTED"
  | "BRAID_CALL_UNSUPPORTED"
  | "BRAID_CALL_RESULT_SETS"
  | "BRAID_CALL_CURSOR_TX_REQUIRED"
  | "BRAID_CALL_OUT_UNSUPPORTED"
  | "BRAID_CALL_RETURN_UNSUPPORTED"
  | "BRAID_CALL_CURSOR_UNSUPPORTED"
  | "BRAID_RESOURCE_CLEANUP";

/** Identifies which routine channel or row failed during Standard Schema mapping. */
export class RoutineMappingError extends Error {
  static readonly code = "BRAID_CALL_MAP" as const;
  readonly code = RoutineMappingError.code;
  readonly location: RoutineMappingLocation;

  constructor(message: string, location: RoutineMappingLocation, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RoutineMappingError";
    this.location = Object.freeze(location);
  }
}

/** Native or adapter execution strategy reported for a bulk operation; the label does not imply atomicity. */
export type BulkExecutionMode = "native-bulk" | "pipeline" | "prepared-loop" | "remote-batch";

/** Driver bulk result normalized for runtime accounting and observer events. */
export interface BulkExecutionResult {
  readonly inputCount: number;
  readonly affectedRows?: number;
  readonly executionMode: BulkExecutionMode;
}

/**
 * Physical execution SPI for one serialized resource.
 * Query/call/control methods may be synchronous at this boundary; streams remain async iterables and retain ownership until closed.
 */
export interface QueryExecutor {
  /** Stable identity for the physical execution resource shared by wrappers; pools must use a leased resource. */
  readonly ownershipKey?: object;
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
  /** Execute one materialized statement on this physical resource. */
  query<Row>(
    rendered: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<QueryExecutionResult<Row>>;
  /** Open a true driver stream; the physical resource remains owned until iteration closes. */
  stream<Row>(
    rendered: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): AsyncIterable<Row>;
  /** Execute a routine call and return normalized scalar/result-set channels. */
  call(
    rendered: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<DriverRoutineResult>;
  /** Optional homogeneous bulk protocol. The reported execution mode does not imply atomicity. */
  bulk?(
    bulk: RenderedBulk,
    binding: BulkBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<BulkExecutionResult>;
  /** Pure pre-acquire validation for adapter-specific transaction option support. */
  validateTransactionOptions?(options: TransactionOptions): void;
  /** Begin the outer transaction on this physical resource. */
  begin?(options?: TransactionOptions): Awaitable<void>;
  /** Commit the outer transaction on this physical resource. */
  commit?(): Awaitable<void>;
  /** Roll back the outer transaction on this physical resource. */
  rollback?(): Awaitable<void>;
  /** Create a nested transaction boundary on the current resource. */
  savepoint?(name: string): Awaitable<void>;
  /** Roll back the current resource to a previously created savepoint. */
  rollbackTo?(name: string): Awaitable<void>;
  /** End the logical savepoint boundary; adapters may implement this as a no-op when the database releases implicitly. */
  releaseSavepoint?(name: string): Awaitable<void>;
}

/** Acquired physical resource. The lease owns release/discard, while runtime owns operation serialization. */
export interface ConnectionLease extends QueryExecutor {
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}

/** Lease factory for pools; acquiring one lease is the boundary that establishes physical connection ownership. */
export interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
  validateTransactionOptions?(options: TransactionOptions): void;
  acquire(): Promise<ConnectionLease>;
}

/** Immutable observer projection of adapter transport and reuse decisions. */
export interface QueryExecutionPlan {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: ParameterTransportKind;
  readonly reuse: StatementBindingDescription["reuse"];
}

/** Observer event emitted after rendering and binding, before physical execution. */
export interface QueryReadyEvent {
  readonly type: "query:ready";
  readonly purpose?: "environment";
  readonly operationId: string;
  readonly batchId?: string;
  readonly sql?: string;
  readonly values: readonly unknown[];
  readonly bindingMap?: readonly {
    readonly placeholder: number;
    readonly interpolation?: number;
    readonly direction?: RoutineParameterDirection;
    readonly outputName?: string;
  }[];
  readonly parameterHints?: readonly (ParameterTypeHint | undefined)[];
  readonly execution: QueryExecutionPlan;
  readonly literalizedSql: (options?: LiteralizeOptions) => LiteralizedSqlResult;
  readonly declaredKind: QueryResultKind;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
  readonly preparedName?: string;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Observer event emitted after driver materialization and result-kind validation, before mapping. */
export interface QueryResultEvent {
  readonly type: "query:result";
  readonly purpose?: "environment";
  readonly operationId: string;
  readonly preparedName?: string;
  readonly batchId?: string;
  readonly durationMs: number;
  readonly actualKind: "rows" | "command" | "call";
  readonly rowCount?: number;
  readonly resultSetCount?: number;
  readonly outputKeys?: readonly string[];
  readonly hasReturnValue?: boolean;
  readonly command?: Readonly<Record<string, unknown>>;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Observer event emitted after query-bound and execution-level mapping completes. */
export interface QueryMappedEvent {
  readonly type: "query:mapped";
  readonly purpose?: "environment";
  readonly operationId: string;
  readonly preparedName?: string;
  readonly batchId?: string;
  readonly durationMs: number;
  readonly rowCount: number;
  readonly queryMapped: boolean;
  readonly executionMapped: boolean;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Observer event emitted after the complete homogeneous bulk is prepared, before physical execution. */
export interface BulkReadyEvent {
  readonly type: "bulk:ready";
  readonly operationId: string;
  readonly itemCount: number;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
  readonly sql?: string;
  readonly valuesAt: (index: number) => readonly unknown[];
  readonly literalizedSql: (index: number, options?: LiteralizeOptions) => LiteralizedSqlResult;
}

/** Observer event emitted after bulk execution and result normalization. */
export interface BulkResultEvent {
  readonly type: "bulk:result";
  readonly operationId: string;
  readonly itemCount: number;
  readonly affectedRows?: number;
  readonly executionMode: BulkExecutionMode;
  readonly durationMs: number;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export type QueryErrorStage =
  | "render"
  | "prepared"
  | "observer-before"
  | "materialize"
  | "acquire"
  | "driver"
  | "result-kind"
  | "cardinality"
  | "query-map"
  | "execution-map"
  | "observer-after"
  | "release"
  | "stream"
  | "transaction";

/** Observer event describing the stage and truthful execution flags for a failed operation. */
export interface QueryErrorEvent {
  readonly type: "query:error";
  readonly purpose?: "environment";
  readonly operationId: string;
  readonly preparedName?: string;
  readonly batchId?: string;
  readonly error: unknown;
  readonly stage: QueryErrorStage;
  readonly executionStarted: boolean;
  readonly executionCompleted: boolean;
  readonly durationMs?: number;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Observer event emitted when a stream is admitted and its lease is about to be retained. */
export interface StreamStartEvent {
  readonly type: "stream:start";
  readonly operationId: string;
  readonly sql?: string;
  readonly values: readonly unknown[];
  readonly bindingMap?: readonly {
    readonly placeholder: number;
    readonly interpolation?: number;
    readonly direction?: RoutineParameterDirection;
    readonly outputName?: string;
  }[];
  readonly parameterHints?: readonly (ParameterTypeHint | undefined)[];
  readonly execution: QueryExecutionPlan;
  readonly literalizedSql: (options?: LiteralizeOptions) => LiteralizedSqlResult;
  readonly declaredKind: "rows";
  readonly variantFingerprint?: string;
  readonly preparedName?: string;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Terminal stream event; delivery is attempted for every observer even if one observer fails. */
export interface StreamEndEvent {
  readonly type: "stream:end";
  readonly operationId: string;
  readonly status: "completed" | "error";
  readonly durationMs: number;
  readonly rowCount: number;
  readonly error?: unknown;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export type TransactionEventPhase =
  | "begin"
  | "commit"
  | "rollback"
  | "savepoint"
  | "rollback-to-savepoint"
  | "release-savepoint";

/** Transaction-control lifecycle event for outer transactions and nested savepoints. */
export interface TransactionEvent {
  readonly type: "transaction";
  readonly transactionId: string;
  readonly phase: TransactionEventPhase;
  readonly status: "requested" | "completed" | "failed";
  readonly depth: number;
  readonly savepointName?: string;
  readonly durationMs?: number;
  readonly error?: unknown;
}

export type ExecutionEvent =
  | QueryReadyEvent
  | QueryResultEvent
  | QueryMappedEvent
  | BulkReadyEvent
  | BulkResultEvent
  | QueryErrorEvent
  | StreamStartEvent
  | StreamEndEvent
  | TransactionEvent;

/** Readonly observer hook. Observers may fail execution, but cannot rewrite SQL, binds, routing, or results. */
export interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}

export interface EnvironmentCapability {
  readonly status: "guaranteed" | "guarded" | "unsupported";
  readonly canonical?: "string" | "number" | "Uint8Array";
  readonly rawRepresentations?: readonly string[];
  readonly conditionCode?: string;
}

/** Observed database/driver/runtime evidence plus exact support-target matching. */
export interface DatabaseEnvironment {
  readonly database: { readonly product: string; readonly version?: string; readonly edition?: string };
  readonly driver: { readonly id: string; readonly version?: string; readonly profile?: string };
  readonly runtime: { readonly id: string; readonly version?: string };
  readonly typePolicy?: { readonly id: string; readonly hash: string };
  readonly capabilities: Readonly<Record<string, EnvironmentCapability>>;
  readonly supportMatch: {
    readonly status: "official" | "conditional" | "compatible";
    readonly targetId?: string;
    readonly reason?: string;
  };
}

/** Adapter evidence only. Probes run through the ordinary observed, leased query path. */
export interface DriverEnvironment {
  readonly database: DatabaseEnvironment["database"];
  readonly driver: DatabaseEnvironment["driver"];
  readonly typePolicy?: { readonly id: string; readonly hash: string };
  readonly capabilities: DatabaseEnvironment["capabilities"];
  readonly probe?: {
    readonly statement: RenderedStatement;
    readonly read: (rows: readonly unknown[]) => {
      readonly version?: string;
      readonly edition?: string;
      readonly capabilities?: Readonly<Record<string, EnvironmentCapability>>;
    };
  };
}

/** Structural subset of a support manifest; importing support tooling is unnecessary. */
export interface EnvironmentSupportTarget {
  readonly id: string;
  readonly status: string;
  readonly database: { readonly product: string; readonly version: string; readonly edition: string };
  readonly driver: { readonly id: string; readonly version: string; readonly profile: string };
  readonly runtime: { readonly id: string; readonly version: string };
  readonly typePolicy: { readonly id: string; readonly hash: string };
  readonly evidence: { readonly status: string };
}

export interface EnvironmentOptions {
  readonly targets?: readonly EnvironmentSupportTarget[];
  /** Re-probe the current lease instead of returning the cached observation. */
  readonly refresh?: boolean;
}

/** Root database behavior: observers and default prepared-reuse preference. */
export interface DatabaseOptions {
  readonly observers?: readonly ExecutionObserver[];
  readonly reuse?: RequestedReuse;
}

export type PreparableQuery = ExecutableQuery | CallQuery;

export type PreparedFactoryOptions = { readonly input: "none" } | { readonly input: "required" };

export type PreparedArguments<Input, Options> = [Input] extends [never]
  ? [options?: Options]
  : [input: Input, options?: Options];

/** Prepared handle whose input arity and result helpers are fixed by the factory's query kind. */
export type PreparedQuery<Input, Q extends PreparableQuery> = {
  readonly name: string;
} & (Q extends CallQuery<infer Result>
  ? { call(...args: PreparedArguments<Input, ExecutionOptions>): Promise<Result> }
  : {
      execute(...args: PreparedArguments<Input, ExecutionOptions>): Promise<ExecutionResultOf<Q>>;
    } & (Q extends RowQuery<infer Row>
      ? {
          all(...args: PreparedArguments<Input, RowValidationOptions<Row>>): Promise<readonly Row[]>;
          one(...args: PreparedArguments<Input, RowValidationOptions<Row>>): Promise<Row>;
          maybeOne(...args: PreparedArguments<Input, RowValidationOptions<Row>>): Promise<Row | undefined>;
          stream(...args: PreparedArguments<Input, StreamOptions<Row>>): AsyncIterable<Row>;
        }
      : {}));

export type ExecutableQuery = RowQuery<unknown> | Query<unknown, "command"> | Query<unknown, "unknown">;

export type ExecutionResultOf<Q> =
  Q extends RowQuery<infer Row>
    ? RowsExecutionResult<Row>
    : Q extends Query<unknown, "command">
      ? CommandExecutionResult
      : Q extends Query<infer Row, "unknown">
        ? QueryExecutionResult<Row>
        : never;

/**
 * Async application database surface.
 * Root pooled operations acquire/release per operation; `session()` and `tx()` callbacks pin a scoped resource.
 * Scoped handles expire when their callback returns, and streams must close before a scope can finish.
 */
export interface Database {
  /** Observe database/driver/runtime evidence and optionally match it against exact support targets. */
  environment(options?: EnvironmentOptions): Promise<DatabaseEnvironment>;
  /** Materialize every row and apply query/execution mapping after the root lease is released. */
  all<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<readonly Row[]>;
  /** Require exactly one row; cardinality is checked before application mapping. */
  one<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row>;
  /** Return `undefined` for zero rows and reject when more than one row is returned. */
  maybeOne<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row | undefined>;
  /** Execute a row, command, or unknown query and preserve its normalized result kind. */
  execute<Q extends ExecutableQuery>(query: Q, options?: ExecutionOptions): Promise<ExecutionResultOf<Q>>;
  /** Execute a routine query and materialize all normalized routine channels before mapping. */
  call<Result extends RoutineCallResult>(query: CallQuery<Result>, options?: ExecutionOptions): Promise<Result>;
  /** Execute different queries sequentially on one physical use/lease. This is not an implicit transaction. */
  batch<const Queries extends readonly ExecutableQuery[]>(
    queries: Queries,
    options?: ExecutionOptions,
  ): Promise<{ readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> }>;
  /** Execute one homogeneous command shape for many inputs using the adapter's bulk strategy. */
  bulk<Input>(
    inputs: readonly Input[],
    factory: (input: Input, index: number) => CommandQuery,
    options?: ExecutionOptions,
  ): Promise<BulkResult>;
  /** Create a prepared handle whose first successful execution locks the logical SQLBraid shape. */
  prepare<Factory extends () => PreparableQuery>(
    name: string,
    factory: Factory & (Parameters<Factory> extends [] ? unknown : never),
    options: { readonly input: "none" },
  ): PreparedQuery<never, ReturnType<Factory>>;
  prepare<Factory extends (input: never) => PreparableQuery>(
    name: string,
    factory: Factory & (Parameters<Factory> extends [unknown] ? unknown : never),
  ): PreparedQuery<Parameters<Factory>[0], ReturnType<Factory>>;
  prepare<Factory extends (input: never) => PreparableQuery>(
    name: string,
    factory: Factory &
      (number extends Parameters<Factory>["length"]
        ? unknown
        : Parameters<Factory>["length"] extends 0 | 1
          ? unknown
          : never),
    options: { readonly input: "required" },
  ): PreparedQuery<Parameters<Factory>[0], ReturnType<Factory>>;
  /** Stream rows without full buffering; the physical resource remains pinned until iteration closes. */
  stream<Row>(query: RowQuery<Row>, options?: StreamOptions<Row>): AsyncIterable<Row>;
  /** Pin one physical resource for the callback without implicitly starting a transaction. */
  session<T>(callback: (database: Database) => Promise<T>): Promise<T>;
  /** Run the callback in one physical transaction; nested calls use savepoints on the same resource. */
  tx<T>(callback: (database: Database) => Promise<T>): Promise<T>;
  tx<T>(options: TransactionOptions, callback: (database: Database) => Promise<T>): Promise<T>;
}

/** Normalized bulk accounting; root bulk is not implicitly transactional. */
export interface BulkResult {
  readonly inputCount: number;
  readonly affectedRows?: number;
}

export type QueryRow<Q> = Q extends Query<infer Row, QueryResultKind> ? Row : never;

/** Generic SQL tag shape used by configured dialect/query-kind specializations. */
export interface SqlTagLike<Kind extends QueryResultKind = QueryResultKind, Row = unknown> {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Query<Row, Kind>;
}

export interface RoutineContractTag<Contract extends RoutineContract> {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): CallQuery<RoutineResultFromContract<Contract>>;
}

/** Row-specialized tag supporting either a TypeScript row type or a Standard Schema mapper. */
export interface RowsTag {
  // Two type parameters keep this overload out of the sql.rows<Row> instantiation expression.
  <Input, Output>(schema: StandardSchemaV1<Input, Output>): SqlTagLike<"rows", Output>;
  <Row = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): RowQuery<Row>;
}

/**
 * SQL authoring surface. Values are bound by default; `ident`, `fragment`, `list`, `join`, and `raw` are explicit structure.
 */
export interface SqlTag extends SqlTagLike<"unknown"> {
  /** Declare a row-producing query, optionally with query-bound Standard Schema mapping. */
  rows: RowsTag;
  /** Declare a command query that must normalize to command metadata. */
  command: (strings: TemplateStringsArray, ...values: readonly unknown[]) => CommandQuery;
  /** Declare a routine query, optionally with explicit output/result-set/return mapping contracts. */
  call: {
    <Result extends RoutineCallResult = RoutineCallResult>(
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ): CallQuery<Result>;
    <Contract extends RoutineContract>(contract: Contract): RoutineContractTag<Contract>;
  };
  /** Attach explicit database parameter metadata without turning the value into SQL structure. */
  bind<Input>(value: NoInfer<Input>, hint: ParameterTypeHint<Input>): BoundParameter<Input>;
  /** Declare a routine OUT parameter owned by the adapter. */
  out(name: string, hint?: ParameterTypeHint): RoutineParameter<null>;
  /** Declare a routine INOUT parameter owned by the adapter. */
  inOut<Input>(name: string, value: NoInfer<Input>, hint?: ParameterTypeHint<Input>): RoutineParameter<Input>;
  /** Create explicit SQL structure while preserving ordinary interpolations as values. */
  fragment: (strings: TemplateStringsArray, ...values: readonly unknown[]) => SqlFragment;
  /** Empty structural fragment for conditional composition. */
  empty: SqlFragment;
  /** Create a dialect-quoted identifier or qualified identifier path. */
  ident: (identifier: string | readonly string[]) => SqlFragment;
  /** Insert verbatim SQL structure. Never pass user-controlled or otherwise untrusted text. */
  raw: (text: string) => SqlFragment;
  /** Join already-structural fragments with a structural separator. */
  join: (items: readonly SqlFragment[], separator?: SqlFragment) => SqlFragment;
  /** Expand an array as a structural comma-separated list of value binds. */
  list: (values: readonly unknown[]) => SqlFragment;
}

/** Rendering/authoring failure with a stable diagnostic code, raised before driver execution. */
export class SqlRenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SqlRenderError";
    this.code = code;
  }
}
