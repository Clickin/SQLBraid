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

/** Rendering/authoring failure with a stable diagnostic code, raised before driver execution. */
export class SqlRenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SqlRenderError";
    this.code = code;
  }
}
