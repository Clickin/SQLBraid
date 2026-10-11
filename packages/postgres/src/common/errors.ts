import { UnsupportedFeatureError } from "@sqlbraid/core";

export function unsupported(
  feature: string,
  code: `BRAID_${string}`,
  message: string,
  cause?: unknown,
): UnsupportedFeatureError {
  return new UnsupportedFeatureError(feature, code, message, cause === undefined ? undefined : { cause });
}

export function invalidTransactionOptions(message: string): TypeError & { readonly code: string } {
  const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: ${message}`) as TypeError & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
  return error;
}

export function cleanupFailure(message: string, cause?: unknown): Error & { readonly code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

export function cleanupAggregate(
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
