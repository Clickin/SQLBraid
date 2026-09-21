const SQL_BOUND_PARAMETER = Symbol.for("sqlbraid.bound-parameter");
const knownBoundParameters = new WeakSet<object>();
declare const boundParameterBrand: unique symbol;
const SQL_ROUTINE_PARAMETER = Symbol.for("sqlbraid.routine-parameter");
const knownRoutineParameters = new WeakSet<object>();

export type RoutineParameterDirection = "in" | "out" | "inout";

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
