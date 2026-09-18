export type CleanupAction = () => void | PromiseLike<void>;

export interface CleanupScope {
  add(action: CleanupAction): void;
  disarm(): void;
  /**
   * Runs cleanup once. Calls made again while asynchronous cleanup is pending
   * return the same Promise; cleanup actions must not await this scope's run.
   */
  run(primary?: unknown): void | Promise<void>;
}

const NO_PRIMARY = Symbol("sqlbraid.no-primary");
const RESOURCE_CLEANUP_CODE = "BRAID_RESOURCE_CLEANUP" as const;
const SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function resourceCleanupError(primary: unknown | typeof NO_PRIMARY, failures: readonly unknown[]): Error {
  const hasPrimary = primary !== NO_PRIMARY;
  const values = hasPrimary ? [primary, ...failures] : failures;
  const error =
    values.length === 1 && !hasPrimary
      ? new Error("BRAID_RESOURCE_CLEANUP: resource cleanup failed.", { cause: failures[0] })
      : new AggregateError(values, "BRAID_RESOURCE_CLEANUP: resource cleanup failed.", {
          cause: hasPrimary ? primary : failures[0],
        });
  Object.defineProperty(error, "code", {
    configurable: false,
    enumerable: true,
    value: RESOURCE_CLEANUP_CODE,
    writable: false,
  });
  return error;
}

function finish(primary: unknown | typeof NO_PRIMARY, failures: readonly unknown[]): void {
  if (failures.length === 0) {
    if (primary !== NO_PRIMARY) throw primary;
    return;
  }
  throw resourceCleanupError(primary, failures);
}

function isThenable(value: unknown): value is PromiseLike<void> {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { readonly then?: unknown }).then === "function"
    : false;
}

async function finishAsync(
  current: PromiseLike<void>,
  pending: readonly CleanupAction[],
  nextIndex: number,
  primary: unknown | typeof NO_PRIMARY,
  failures: unknown[],
): Promise<void> {
  try {
    await current;
  } catch (error) {
    failures.push(error);
  }
  for (let index = nextIndex; index < pending.length; index += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Cleanup must complete sequentially in LIFO order.
      await pending[index]!();
    } catch (error) {
      failures.push(error);
    }
  }
  finish(primary, failures);
}

export function createCleanupScope(): CleanupScope {
  let actions: CleanupAction[] = [];
  let state: "open" | "running" | "closed" | "disarmed" = "open";
  let inFlight: Promise<void> | undefined;

  return {
    add(action: CleanupAction): void {
      if (state !== "open") throw new Error("Cannot register cleanup after scope closure.");
      if (typeof action !== "function") throw new TypeError("Cleanup action must be a function.");
      actions.push(action);
    },

    disarm(): void {
      if (state !== "open") return;
      state = "disarmed";
      actions = [];
    },

    run(primary?: unknown): void | Promise<void> {
      if (inFlight !== undefined) return inFlight;
      if (state !== "open") return;
      state = "running";
      // oxlint-disable-next-line unicorn/no-array-reverse -- Consume this owned action array in LIFO order without copying.
      const pending = actions.reverse();
      actions = [];
      const failures: unknown[] = [];
      const primaryValue = arguments.length === 0 ? NO_PRIMARY : primary;

      for (let index = 0; index < pending.length; index += 1) {
        try {
          const result = pending[index]!();
          if (isThenable(result)) {
            state = "closed";
            inFlight = finishAsync(result, pending, index + 1, primaryValue, failures);
            return inFlight;
          }
        } catch (error) {
          failures.push(error);
        }
      }
      state = "closed";
      finish(primaryValue, failures);
    },
  };
}

export function defineResultProperty(row: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(row, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function assertSavepointName(name: string): string {
  if (typeof name !== "string" || !SAVEPOINT_NAME.test(name)) {
    throw new TypeError("Invalid SQLBraid savepoint name.");
  }
  return name;
}
