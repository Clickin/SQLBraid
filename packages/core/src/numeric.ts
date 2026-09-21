import { ResultExactnessError } from "./errors.js";

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
