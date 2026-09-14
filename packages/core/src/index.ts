import type { StandardSchemaV1 } from "@standard-schema/spec";

export type { StandardSchemaV1 } from "@standard-schema/spec";

export const SQL_FRAGMENT = Symbol.for("sqlbraid.fragment");

const SQL_BOUND_PARAMETER = Symbol.for("sqlbraid.bound-parameter");
const knownBoundParameters = new WeakSet<object>();
declare const boundParameterBrand: unique symbol;
const SQL_ROUTINE_PARAMETER = Symbol.for("sqlbraid.routine-parameter");
const knownRoutineParameters = new WeakSet<object>();

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface RenderLimits {
  readonly maxSqlBytes?: number;
  readonly maxBindCount?: number;
  readonly maxStructuralItems?: number;
  readonly maxNestingDepth?: number;
}

export type QueryResultKind = "rows" | "command" | "call" | "unknown";

export type NumericSemantics =
  | "exact-integer"
  | "exact-decimal"
  | "approximate-binary";

export type NumericRepresentation = "string" | "number";

export type TransportFidelity =
  | "lossless"
  | "guarded"
  | "lossy"
  | "unsupported";

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

export class ResultExactnessError extends Error {
  readonly code = "BRAID_RESULT_EXACTNESS";

  constructor(message = "Result value does not have an exact representation.") {
    super(message);
    this.name = "ResultExactnessError";
  }
}

function exactnessFailure(message: string): never {
  throw new ResultExactnessError(message);
}

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
      (range.min !== undefined && typeof range.min !== "bigint")
      || (range.max !== undefined && typeof range.max !== "bigint")
      || (range.min !== undefined && range.max !== undefined && range.min > range.max)
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

export function decodeExactDecimal(value: unknown, options?: { readonly allowBigInt?: boolean }): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint" && options?.allowBigInt === true) return value.toString();
  return exactnessFailure("Result value does not have an exact decimal representation.");
}

export type RoutineParameterDirection = "in" | "out" | "inout";

export interface RoutineProcedure {
  readonly name: string;
  readonly parameterNames: readonly string[];
}

export type RoutineSchema = StandardSchemaV1<any, any>;

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

export interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly dialectId: string;
  readonly resultKind: QueryResultKind;
  readonly routineProcedure?: RoutineProcedure;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}

export interface ParameterTypeHint<Input = unknown> {
  readonly databaseType: string;
  readonly length?: number | "max";
  readonly precision?: number;
  readonly scale?: number;
  readonly __input?: Input;
}

export interface BoundParameter<Input = unknown> {
  readonly value: Input;
  readonly hint: ParameterTypeHint<Input>;
  readonly [boundParameterBrand]: true;
}

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
  const candidate = value as { readonly databaseType?: unknown; readonly length?: unknown; readonly precision?: unknown; readonly scale?: unknown };
  return typeof candidate.databaseType === "string"
    && candidate.databaseType.trim().length > 0
    && (candidate.length === undefined || candidate.length === "max" || validHintNumber(candidate.length))
    && (candidate.precision === undefined || validHintNumber(candidate.precision))
    && (candidate.scale === undefined || validHintInteger(candidate.scale));
}

export function createParameterTypeHint<Input = unknown>(hint: ParameterTypeHint<Input>): ParameterTypeHint<Input> {
  if (!isParameterTypeHint(hint)) throw new TypeError("sql.bind hint must be an object with valid structural fields.");
  const candidate = hint as { readonly databaseType?: unknown; readonly length?: unknown; readonly precision?: unknown; readonly scale?: unknown };
  if (typeof candidate.databaseType !== "string" || !candidate.databaseType.trim()) throw new TypeError("sql.bind hint databaseType must be a non-empty string.");
  if (candidate.length !== undefined && candidate.length !== "max" && !validHintNumber(candidate.length)) throw new TypeError("sql.bind hint length must be a non-negative integer or \"max\".");
  if (candidate.precision !== undefined && !validHintNumber(candidate.precision)) throw new TypeError("sql.bind hint precision must be a non-negative integer.");
  if (candidate.scale !== undefined && !validHintInteger(candidate.scale)) throw new TypeError("sql.bind hint scale must be an integer.");
  const normalized = {
    databaseType: candidate.databaseType,
    ...(candidate.length === undefined ? {} : { length: candidate.length }),
    ...(candidate.precision === undefined ? {} : { precision: candidate.precision }),
    ...(candidate.scale === undefined ? {} : { scale: candidate.scale }),
  } as ParameterTypeHint<Input>;
  return Object.freeze(normalized);
}

export function createBoundParameter<Input>(
  value: NoInfer<Input>,
  hint: ParameterTypeHint<Input>,
): BoundParameter<Input> {
  const normalizedHint = createParameterTypeHint(hint);
  const bound = Object.freeze({ value, hint: normalizedHint, [SQL_BOUND_PARAMETER]: true });
  knownBoundParameters.add(bound);
  return bound as unknown as BoundParameter<Input>;
}

export function isBoundParameter(value: unknown): value is BoundParameter {
  if (typeof value !== "object" || value === null || !knownBoundParameters.has(value) || !Object.hasOwn(value, SQL_BOUND_PARAMETER)) return false;
  const candidate = value as { readonly value?: unknown; readonly hint?: unknown; readonly [SQL_BOUND_PARAMETER]?: unknown };
  return candidate[SQL_BOUND_PARAMETER] === true
    && Object.hasOwn(candidate, "value")
    && isParameterTypeHint(candidate.hint);
}

function normalizeOutputName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("Routine outputName must be a non-empty string.");
  return name;
}

export function createRoutineOutParameter(
  name: string,
  hint?: ParameterTypeHint,
): RoutineParameter<null> {
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

export function isRoutineParameter(value: unknown): value is RoutineParameter {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !knownRoutineParameters.has(value)) return false;
  const candidate = value as {
    readonly value?: unknown;
    readonly direction?: unknown;
    readonly outputName?: unknown;
    readonly hint?: unknown;
    readonly [SQL_ROUTINE_PARAMETER]?: unknown;
  };
  return candidate[SQL_ROUTINE_PARAMETER] === true
    && Object.hasOwn(candidate, "value")
    && (candidate.direction === "out" || candidate.direction === "inout")
    && typeof candidate.outputName === "string"
    && Boolean(candidate.outputName.trim())
    && (candidate.hint === undefined || isParameterTypeHint(candidate.hint));
}

export type ParameterTransportKind =
  | "native-value-template"
  | "text-positional"
  | "text-named"
  | "typed-request";

export type RequestedReuse = "auto" | "simple" | "reuse";
export type EffectiveReuse = "simple" | "reuse";
export type ReuseOwner = "sqlbraid" | "driver" | "server";

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

export interface LiteralizeOptions {
  readonly values?: "inline" | "redacted";
  readonly maxValueLength?: number;
  readonly binary?: "summary" | "full";
  readonly redact?: (parameter: RenderedParameter, index: number) => boolean;
}

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
  readonly formatLiteral?: (parameter: RenderedParameter, index: number, options: LiteralizeOptions) => string | undefined;
}

export interface RenderedBulk {
  readonly statement: RenderedStatement;
  readonly parameterSets: readonly (readonly unknown[])[];
}

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
  const parameterSets = Object.freeze(bulk.parameterSets.map((values) => {
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
  }));
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
  if (typeof procedure !== "object" || procedure === null || typeof procedure.name !== "string" || !procedure.name.trim()) {
    throw new TypeError("Routine procedure name must be a non-empty string.");
  }
  if (!Array.isArray(procedure.parameterNames)) throw new TypeError("Routine procedure parameterNames must be an array.");
  const parameterNames = procedure.parameterNames.map((name) => {
    if (typeof name !== "string" || !name.trim()) throw new TypeError("Routine procedure parameterNames must contain non-empty strings.");
    return name;
  });
  if (new Set(parameterNames).size !== parameterNames.length) throw new TypeError("Routine procedure parameterNames must be unique.");
  return Object.freeze({ name: procedure.name, parameterNames: Object.freeze(parameterNames) });
}

export function createRenderedStatement(statement: {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
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
  if (typeof statement.dialectId !== "string" || !statement.dialectId) throw new TypeError("RenderedStatement dialectId must be a non-empty string.");
  const segments = Object.freeze([...statement.segments]);
  if (segments.some((segment) => typeof segment !== "string")) throw new TypeError("RenderedStatement segments must be an array of strings.");
  const parameters = Object.freeze(Array.from(statement.parameters, copyRenderedParameter));
  if (parameters.some((parameter) => parameter.direction === "inout" && statement.resultKind !== "call")) {
    throw new TypeError("INOUT parameters are only valid for call statements.");
  }
  if (parameters.some((parameter) => parameter.direction === "out"
    && statement.resultKind !== "call"
    && statement.resultKind !== "rows")) {
    throw new TypeError("OUT parameters are only valid for call and rows statements.");
  }
  const outputNames = new Set<string>();
  for (const parameter of parameters) {
    if (parameter.outputName !== undefined) {
      if (outputNames.has(parameter.outputName)) throw new TypeError(`Duplicate routine outputName: ${parameter.outputName}`);
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
    dialectId: statement.dialectId,
    resultKind: statement.resultKind,
    ...(routineProcedure === undefined ? {} : { routineProcedure }),
    ...(statement.fingerprint === undefined ? {} : { fingerprint: statement.fingerprint }),
    ...(statement.variantFingerprint === undefined ? {} : { variantFingerprint: statement.variantFingerprint }),
  });
  knownRenderedStatements.add(rendered);
  return rendered;
}

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
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "boolean") {
    if (/^(?:mysql|sqlite)/i.test(dialectId) || /^(?:oracle|mssql|sqlserver)/i.test(dialectId)) return value ? "1" : "0";
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
  if (valuesMode !== "inline" && valuesMode !== "redacted") throw new TypeError("literalizedSql values must be \"inline\" or \"redacted\".");
  if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 0)) {
    throw new TypeError("literalizedSql maxValueLength must be a non-negative integer.");
  }
  const binary = resolved.binary ?? "summary";
  if (binary !== "summary" && binary !== "full") throw new TypeError("literalizedSql binary must be \"summary\" or \"full\".");
  if (resolved.redact !== undefined && typeof resolved.redact !== "function") throw new TypeError("literalizedSql redact must be a function.");
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
    throw new TypeError(`BRAID_DIALECT: statement binding dialect ${dialectId} does not match rendered statement dialect ${logical.dialectId}.`);
  }
  if (typeof adapterId !== "string" || !adapterId) throw new TypeError("Statement binding adapterId must be a non-empty string.");
  if (typeof dialectId !== "string" || !dialectId) throw new TypeError("Statement binding dialectId must be a non-empty string.");
  if (!["native-value-template", "text-positional", "text-named", "typed-request"].includes(transport)) {
    throw new TypeError("Statement binding transport is unsupported.");
  }
  if (transport !== "native-value-template" && placeholder === undefined) {
    throw new TypeError("Text and typed statement transports require a placeholder function.");
  }
  if (!["auto", "simple", "reuse"].includes(requestedReuse)) throw new TypeError("Statement binding requestedReuse is unsupported.");
  if (!["simple", "reuse"].includes(effective) || !["sqlbraid", "driver", "server"].includes(owner)) {
    throw new TypeError("Statement binding reuse policy is unsupported.");
  }
  if (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 0)) {
    throw new TypeError("Statement binding reuse capacity must be a non-negative safe integer.");
  }
  if (placeholder !== undefined && typeof placeholder !== "function") {
    throw new TypeError("Statement binding placeholder must be a function.");
  }
  const bindings = Object.freeze(logical.parameters.map((parameter, offset) => Object.freeze({
    index: offset + 1,
    ...(parameter.outputName === undefined ? {} : { name: parameter.outputName, outputName: parameter.outputName }),
    ...(parameter.interpolation === undefined ? {} : { interpolation: parameter.interpolation }),
    ...(parameter.hint === undefined ? {} : { hint: createParameterTypeHint(parameter.hint) }),
    ...(parameter.direction === undefined ? {} : { direction: parameter.direction }),
  })));
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
        if (defaultLiteralized === undefined) defaultLiteralized = literalized(logical, dialectId, formatLiteral, undefined);
        return defaultLiteralized;
      }
      if (typeof literalOptions !== "object" || literalOptions === null) throw new TypeError("literalizedSql options must be an object.");
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
      const cacheKey = redact === undefined
        ? `${values ?? ""}\u0000${binary ?? ""}\u0000${maxValueLength ?? ""}`
        : undefined;
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
 * Build one binding description for a logical bulk statement. The statement
 * metadata is shared by every parameter set; values and diagnostics are
 * addressed only when requested for a particular item.
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
    const optionsSnapshot = literalOptions === undefined ? undefined : {
      ...(literalOptions.values === undefined ? {} : { values: literalOptions.values }),
      ...(literalOptions.binary === undefined ? {} : { binary: literalOptions.binary }),
      ...(literalOptions.maxValueLength === undefined ? {} : { maxValueLength: literalOptions.maxValueLength }),
      ...(literalOptions.redact === undefined ? {} : { redact: literalOptions.redact }),
    };
    const statement = {
      ...logical.statement,
      parameters: logical.statement.parameters.map((parameter, parameterIndex) => ({
        ...parameter,
        value: values[parameterIndex],
      })),
    };
    const result = createStatementBindingDescription(
      statement,
      context,
      options,
    ).literalizedSql(optionsSnapshot);
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

export interface DialectLexicalProfile {
  readonly lineCommentPrefixes: readonly string[];
  readonly supportsNestedBlockComments?: boolean;
  readonly supportsDollarQuotes?: boolean;
  readonly supportsBacktickIdentifiers?: boolean;
  readonly supportsBracketIdentifiers?: boolean;
  readonly supportsOracleQQuotes?: boolean;
  readonly backslashEscapes?: boolean;
}

export interface Dialect {
  readonly id: string;
  quoteIdentifier(identifier: string): string;
  readonly lexicalProfile?: DialectLexicalProfile;
}

export interface TypeMapping {
  readonly databaseType: string;
  readonly inputType: string;
  readonly outputType: string;
  readonly nullable: boolean;
  readonly numeric?: NumericTypeContract;
}

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

export interface TemplateIr {
  readonly version: 1;
  readonly nodes: readonly TemplateNode[];
  readonly sourceLength: number;
}

export interface SqlFragment {
  readonly [SQL_FRAGMENT]: true;
  readonly ir: TemplateIr;
  readonly values: readonly unknown[];
  readonly dialectId: string;
}

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

export interface CommandResult {
  readonly affectedRows?: number;
  readonly insertId?: number | bigint | string;
  readonly [key: string]: unknown;
}

export interface RowsExecutionResult<Row = unknown> {
  readonly kind: "rows";
  readonly rows: readonly Row[];
  readonly rowCount?: number;
  readonly command?: never;
}

export interface CommandExecutionResult {
  readonly kind: "command";
  readonly rows: readonly [];
  readonly rowCount?: number;
  readonly command: CommandResult;
}

export type QueryExecutionResult<Row = unknown> =
  | RowsExecutionResult<Row>
  | CommandExecutionResult;

export interface RowValidationOptions<Row> {
  readonly schema?: StandardSchemaV1<unknown, NoInfer<Row>>;
}

export interface StreamOptions<Row> extends RowValidationOptions<Row> {
  readonly signal?: AbortSignal;
}

export interface RoutineResultSet<Row = unknown> {
  readonly rows: readonly Row[];
}

export type RoutineResultSetTuple<Sets extends readonly unknown[]> = {
  readonly [K in keyof Sets]: RoutineResultSet<Sets[K]>;
};

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
> & (Contract extends { readonly returnValue: RoutineSchema }
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

export interface DriverRoutineResultSet {
  readonly rows: readonly unknown[];
  readonly source: RoutineResultSource;
}

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

export class RoutineMappingError extends Error {
  readonly code = "BRAID_CALL_MAP";
  readonly location: RoutineMappingLocation;

  constructor(message: string, location: RoutineMappingLocation, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RoutineMappingError";
    this.location = Object.freeze(location);
  }
}

export type BulkExecutionMode = "native-bulk" | "pipeline" | "prepared-loop" | "remote-batch";

export interface BulkExecutionResult {
  readonly inputCount: number;
  readonly affectedRows?: number;
  readonly executionMode: BulkExecutionMode;
}

export interface QueryExecutor {
  /** Stable identity for the physical execution resource shared by wrappers; pools must use a leased resource. */
  readonly ownershipKey?: object;
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
  query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>>;
  stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncIterable<Row>;
  call(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<DriverRoutineResult>;
  bulk?(bulk: RenderedBulk, binding: BulkBindingDescription): Promise<BulkExecutionResult>;
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  savepoint?(name: string): Promise<void>;
  rollbackTo?(name: string): Promise<void>;
  releaseSavepoint?(name: string): Promise<void>;
}

export interface ConnectionLease extends QueryExecutor {
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}

export interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
  acquire(): Promise<ConnectionLease>;
}

export interface QueryExecutionPlan {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: ParameterTransportKind;
  readonly reuse: StatementBindingDescription["reuse"];
}

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

export interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}

export interface EnvironmentCapability {
  readonly status: "guaranteed" | "guarded" | "unsupported";
  readonly canonical?: "string" | "number";
  readonly rawRepresentations?: readonly string[];
  readonly conditionCode?: string;
}

export interface DatabaseEnvironment {
  readonly database: { readonly product: string; readonly version?: string; readonly edition?: string };
  readonly driver: { readonly id: string; readonly version?: string; readonly profile?: string };
  readonly runtime: { readonly id: string; readonly version?: string };
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
  readonly evidence: { readonly status: string };
}

export interface EnvironmentOptions {
  readonly targets?: readonly EnvironmentSupportTarget[];
  /** Re-probe the current lease instead of returning the cached observation. */
  readonly refresh?: boolean;
}

export interface DatabaseOptions {
  readonly observers?: readonly ExecutionObserver[];
  readonly reuse?: RequestedReuse;
}

export interface PreparedQuery<Row> {
  readonly name: string;
  execute(): Promise<RowsExecutionResult<Row>>;
  all(options?: RowValidationOptions<Row>): Promise<readonly Row[]>;
  one(options?: RowValidationOptions<Row>): Promise<Row>;
  maybeOne(options?: RowValidationOptions<Row>): Promise<Row | undefined>;
}

export type ExecutableQuery =
  | RowQuery<unknown>
  | Query<unknown, "command">
  | Query<unknown, "unknown">;

export type ExecutionResultOf<Q> =
  Q extends RowQuery<infer Row>
    ? RowsExecutionResult<Row>
    : Q extends Query<unknown, "command">
      ? CommandExecutionResult
      : Q extends Query<infer Row, "unknown">
        ? QueryExecutionResult<Row>
        : never;

export interface Database {
  environment(options?: EnvironmentOptions): Promise<DatabaseEnvironment>;
  all<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<readonly Row[]>;
  one<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row>;
  maybeOne<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row | undefined>;
  execute<Q extends ExecutableQuery>(query: Q): Promise<ExecutionResultOf<Q>>;
  call<Result extends RoutineCallResult>(query: CallQuery<Result>): Promise<Result>;
  batch<const Queries extends readonly ExecutableQuery[]>(queries: Queries): Promise<{ readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> }>;
  bulk<Input>(inputs: readonly Input[], factory: (input: Input, index: number) => CommandQuery): Promise<BulkResult>;
  prepare<Row>(name: string, factory: () => RowQuery<Row>): PreparedQuery<Row>;
  stream<Row>(query: RowQuery<Row>, options?: StreamOptions<Row>): AsyncIterable<Row>;
  tx<T>(callback: (database: Database) => Promise<T>): Promise<T>;
}

export interface BulkResult {
  readonly inputCount: number;
  readonly affectedRows?: number;
}

export type QueryRow<Q> = Q extends Query<infer Row, QueryResultKind> ? Row : never;

export interface SqlTagLike<Kind extends QueryResultKind = QueryResultKind, Row = unknown> {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Query<Row, Kind>;
}

export interface RoutineContractTag<Contract extends RoutineContract> {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): CallQuery<RoutineResultFromContract<Contract>>;
}

export interface RowsTag {
  // Two type parameters keep this overload out of the sql.rows<Row> instantiation expression.
  <Input, Output>(schema: StandardSchemaV1<Input, Output>): SqlTagLike<"rows", Output>;
  <Row = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): RowQuery<Row>;
}

export interface SqlTag extends SqlTagLike<"unknown"> {
  rows: RowsTag;
  command: (strings: TemplateStringsArray, ...values: readonly unknown[]) => CommandQuery;
  call: {
    <Result extends RoutineCallResult = RoutineCallResult>(strings: TemplateStringsArray, ...values: readonly unknown[]): CallQuery<Result>;
    <Contract extends RoutineContract>(contract: Contract): RoutineContractTag<Contract>;
  };
  bind<Input>(value: NoInfer<Input>, hint: ParameterTypeHint<Input>): BoundParameter<Input>;
  out(name: string, hint?: ParameterTypeHint): RoutineParameter<null>;
  inOut<Input>(name: string, value: NoInfer<Input>, hint?: ParameterTypeHint<Input>): RoutineParameter<Input>;
  fragment: (strings: TemplateStringsArray, ...values: readonly unknown[]) => SqlFragment;
  empty: SqlFragment;
  ident: (identifier: string | readonly string[]) => SqlFragment;
  raw: (text: string) => SqlFragment;
  join: (items: readonly SqlFragment[], separator?: SqlFragment) => SqlFragment;
  list: (values: readonly unknown[]) => SqlFragment;
}

export class SqlRenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SqlRenderError";
    this.code = code;
  }
}
