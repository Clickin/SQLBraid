import { UnsupportedFeatureError } from "@sqlbraid/core";
import type {
  ConnectionProvider,
  DatabaseEnvironment,
  ExecutionOptions,
  QueryExecutor,
  TransactionOptions,
} from "@sqlbraid/core";

export function signalReason(signal: AbortSignal): unknown {
  return signal.reason;
}

export function capabilityStatus(
  resource: QueryExecutor | ConnectionProvider,
  key: string,
  fallback?: DatabaseEnvironment["capabilities"],
): "guaranteed" | "guarded" | "unsupported" | undefined {
  return resource.environment?.capabilities[key]?.status ?? fallback?.[key]?.status;
}

export function assertExecutionOptions(
  resource: QueryExecutor | ConnectionProvider,
  executionOptions: ExecutionOptions | undefined,
  fallback?: DatabaseEnvironment["capabilities"],
): void {
  const signal = executionOptions?.signal;
  if (signal === undefined) return;
  if (signal.aborted) throw signalReason(signal);
  const status = capabilityStatus(resource, "statement.cancel", fallback);
  if (status !== "guaranteed" && status !== "guarded") {
    throw new UnsupportedFeatureError(
      "statement.cancel",
      "BRAID_CANCEL_UNSUPPORTED",
      "The selected execution resource does not expose a safe statement cancellation mechanism.",
    );
  }
}

export function assertTransactionOptions(value: unknown): asserts value is TransactionOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const error = new TypeError("BRAID_TX_OPTIONS_INVALID: transaction options must be an object.");
    Object.defineProperty(error, "code", { configurable: false, enumerable: true, value: "BRAID_TX_OPTIONS_INVALID" });
    throw error;
  }
  const options = value as { readonly isolation?: unknown; readonly readOnly?: unknown };
  for (const key of Object.keys(options)) {
    if (key !== "isolation" && key !== "readOnly") {
      const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: unknown transaction option ${key}.`);
      Object.defineProperty(error, "code", {
        configurable: false,
        enumerable: true,
        value: "BRAID_TX_OPTIONS_INVALID",
      });
      throw error;
    }
  }
  if (
    options.isolation !== undefined &&
    options.isolation !== "read-uncommitted" &&
    options.isolation !== "read-committed" &&
    options.isolation !== "repeatable-read" &&
    options.isolation !== "serializable"
  ) {
    const error = new TypeError(
      "BRAID_TX_OPTIONS_INVALID: transaction isolation is not a supported SQLBraid isolation level.",
    );
    Object.defineProperty(error, "code", { configurable: false, enumerable: true, value: "BRAID_TX_OPTIONS_INVALID" });
    throw error;
  }
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") {
    const error = new TypeError("BRAID_TX_OPTIONS_INVALID: transaction readOnly must be a boolean.");
    Object.defineProperty(error, "code", { configurable: false, enumerable: true, value: "BRAID_TX_OPTIONS_INVALID" });
    throw error;
  }
}

export function assertSessionCapability(
  resource: QueryExecutor | ConnectionProvider,
  fallback?: DatabaseEnvironment["capabilities"],
): void {
  if (capabilityStatus(resource, "session.pinned", fallback) === "unsupported") {
    throw new UnsupportedFeatureError(
      "session.pinned",
      "BRAID_SESSION_UNSUPPORTED",
      "The selected execution resource cannot pin a session.",
    );
  }
}

export function assertFeatureCapability(
  resource: QueryExecutor | ConnectionProvider,
  feature: string,
  code: `BRAID_${string}`,
  message: string,
  fallback?: DatabaseEnvironment["capabilities"],
): void {
  if (capabilityStatus(resource, feature, fallback) === "unsupported") {
    throw new UnsupportedFeatureError(feature, code, message);
  }
}

export function assertTransactionCapability(
  resource: QueryExecutor | ConnectionProvider,
  transactionOptions: TransactionOptions | undefined,
  fallback?: DatabaseEnvironment["capabilities"],
): void {
  if (transactionOptions === undefined) return;
  const checks: readonly [keyof TransactionOptions, string][] = [
    ["isolation", `transaction.isolation.${transactionOptions.isolation ?? ""}`],
    ["readOnly", "transaction.read-only"],
  ];
  for (const [field, feature] of checks) {
    if (transactionOptions[field] === undefined) continue;
    const status = capabilityStatus(resource, feature, fallback);
    if (status !== "guaranteed" && status !== "guarded") {
      throw new UnsupportedFeatureError(
        feature,
        "BRAID_TX_OPTION_UNSUPPORTED",
        `The selected execution resource does not support transaction option ${String(field)}.`,
      );
    }
  }
}

export function validateTransactionOptionSupport(
  resource: QueryExecutor | ConnectionProvider,
  transactionOptions: TransactionOptions,
  fallback: DatabaseEnvironment["capabilities"] | undefined,
  inherited?: QueryExecutor | ConnectionProvider,
): void {
  const validator = resource.validateTransactionOptions;
  const owner = validator === undefined ? inherited : resource;
  const validate = validator ?? inherited?.validateTransactionOptions;
  if (validate !== undefined && owner !== undefined) {
    const result = validate.call(owner, transactionOptions) as unknown;
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { readonly then?: unknown }).then === "function"
    ) {
      try {
        // Only genuine Promises pass this intrinsic brand check, so custom thenables are never invoked.
        Promise.prototype.then.call(result, undefined, () => undefined);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      throw new TypeError("validateTransactionOptions() must be synchronous.");
    }
    return;
  }
  assertTransactionCapability(resource, transactionOptions, fallback);
}
