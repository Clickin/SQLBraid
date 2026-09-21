import {
  createRenderedBulk,
  createRenderedStatement,
  type RenderedBulk,
  type RenderedParameter,
  type RenderedStatement,
} from "./statement.js";
import { createParameterTypeHint, type ParameterTypeHint, type RoutineParameterDirection } from "./parameter.js";

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
