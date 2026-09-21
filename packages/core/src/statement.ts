import { SqlRenderError } from "./errors.js";
import { createParameterTypeHint, type ParameterTypeHint, type RoutineParameterDirection } from "./parameter.js";
import type { RoutineProcedure } from "./routine.js";
import type { QueryResultKind } from "./template-ir.js";

function validHintNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
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

/** One logical command shape plus its value matrix; all rows must remain homogeneous. */
export interface RenderedBulk {
  readonly statement: RenderedStatement;
  readonly parameterSets: readonly (readonly unknown[])[];
}

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
