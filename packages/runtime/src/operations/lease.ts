import { DatabaseScopeError } from "../errors.js";
import {
  assertHealthy,
  assertRootAllowed,
  scopeStateFor,
  acquireDirectRoot,
  acquireTransactionTurn,
  physicalContext,
  type RuntimeOptions,
  type ScopeState,
  type Use,
} from "../state.js";
import { assertExecutionOptions, assertSessionCapability } from "../capabilities.js";
import { bindingIdentityMismatch } from "../binding.js";
import type { ConnectionProvider, ExecutionOptions, QueryExecutor, StatementBindingAdapter } from "@sqlbraid/core";

export interface LeaseRuntime {
  readonly executor: QueryExecutor | ConnectionProvider;
  readonly state: ScopeState;
  readonly options: RuntimeOptions;
  readonly statementBinding: StatementBindingAdapter;
  readonly assertOpen: () => void;
}

export function createLeaseOperations(runtime: LeaseRuntime): {
  readonly leaseForUse: (
    stream: boolean,
    expectedBinding: StatementBindingAdapter,
    executionOptions?: ExecutionOptions,
    reservedRootScope?: symbol,
  ) => Promise<Use>;
  readonly acquireSessionResource: (reservedRootSession?: symbol) => Promise<Use>;
  readonly pinnedResource: () => Use | undefined;
} {
  const { executor, state, options, statementBinding, assertOpen } = runtime;
  const leaseForUse = async (
    stream: boolean,
    expectedBinding: StatementBindingAdapter,
    executionOptions?: ExecutionOptions,
    reservedRootScope?: symbol,
  ): Promise<Use> => {
    assertOpen();
    assertHealthy(state);
    assertExecutionOptions(executor, executionOptions, options.capabilities);
    if (options.pinned) {
      const pinned = options.pinned;
      assertHealthy(pinned.physicalState);
      const active = physicalContext.getStore();
      const hasStream =
        pinned.physicalState.streamUsers > 0 || (pinned.physicalState.pendingStreams ?? 0) > (stream ? 1 : 0);
      if (hasStream || (active?.rootState === options.rootState && active.direct)) {
        if (hasStream) {
          throw new DatabaseScopeError(
            "BRAID_STREAM_SCOPE",
            "A pinned stream cannot re-enter its physical execution resource.",
          );
        }
        throw new DatabaseScopeError(
          "BRAID_REENTRY",
          "A pinned execution resource cannot execute concurrent physical work.",
        );
      }
      const releaseTurn = await acquireTransactionTurn(pinned.physicalState);
      try {
        assertOpen();
        assertHealthy(pinned.physicalState);
      } catch (error) {
        releaseTurn();
        throw error;
      }
      if (pinned.executor.statementBinding !== expectedBinding) {
        releaseTurn();
        throw bindingIdentityMismatch();
      }
      return {
        executor: pinned.executor,
        physicalState: pinned.physicalState,
        direct: pinned.direct,
        ownsLease: false,
        release: async () => {
          releaseTurn();
        },
      };
    }
    if (options.transaction) {
      const lease = options.lease;
      if (!lease || !options.leaseState)
        throw new DatabaseScopeError("BRAID_TX_CLOSED", "Transaction database is no longer usable.");
      const active = physicalContext.getStore();
      const hasStream =
        options.leaseState.streamUsers > 0 || (options.leaseState.pendingStreams ?? 0) > (stream ? 1 : 0);
      if (hasStream || (active?.rootState === options.rootState && active.direct)) {
        if (hasStream) {
          throw new DatabaseScopeError(
            "BRAID_STREAM_SCOPE",
            "A transaction stream cannot re-enter its pinned physical execution resource.",
          );
        }
        throw new DatabaseScopeError(
          "BRAID_REENTRY",
          "A transaction connection cannot execute concurrent physical work.",
        );
      }
      assertHealthy(options.leaseState);
      const releaseTurn = await acquireTransactionTurn(options.leaseState);
      try {
        assertOpen();
        assertHealthy(options.leaseState);
      } catch (error) {
        releaseTurn();
        throw error;
      }
      if (lease.statementBinding !== expectedBinding) {
        releaseTurn();
        throw bindingIdentityMismatch();
      }
      return {
        executor: lease,
        physicalState: options.leaseState,
        direct: true,
        ownsLease: false,
        release: async () => {
          releaseTurn();
        },
      };
    }
    if (reservedRootScope === undefined) assertRootAllowed(options.rootState, stream);
    else if (
      options.rootState.activeScope !== reservedRootScope &&
      options.rootState.activeSession !== reservedRootScope
    ) {
      throw new DatabaseScopeError(
        "BRAID_TX_SCOPE",
        "The root database handle cannot acquire its reserved physical resource.",
      );
    }
    if (!options.pooled) {
      const release = await acquireDirectRoot(state, stream, reservedRootScope);
      return {
        executor: executor as QueryExecutor,
        physicalState: state,
        direct: true,
        ownsLease: false,
        release: async () => {
          release();
        },
      };
    }
    const lease = await (executor as ConnectionProvider).acquire();
    if (
      !lease ||
      typeof lease !== "object" ||
      typeof lease.release !== "function" ||
      typeof lease.query !== "function"
    ) {
      throw new TypeError("Connection provider returned an invalid lease.");
    }
    if (lease.statementBinding !== expectedBinding) {
      let releaseError: unknown;
      let releaseFailed = false;
      try {
        await lease.release({ discard: true });
      } catch (error) {
        releaseFailed = true;
        releaseError = error;
      }
      const mismatch = bindingIdentityMismatch();
      if (releaseFailed)
        throw new AggregateError([mismatch, releaseError], "Binding identity mismatch and lease cleanup failed.", {
          cause: mismatch,
        });
      throw mismatch;
    }
    const leaseState = scopeStateFor(lease);
    try {
      assertHealthy(leaseState);
    } catch (error) {
      try {
        await lease.release({ discard: true });
      } catch (releaseError) {
        // oxlint-disable-next-line preserve-caught-error -- Both errors are retained; the poisoned lease remains the primary cause.
        throw new AggregateError([error, releaseError], "Poisoned lease cleanup failed.", { cause: error });
      }
      throw error;
    }
    return {
      executor: lease,
      physicalState: leaseState,
      direct: false,
      ownsLease: true,
      release: async (discard = false) => {
        await lease.release(discard ? { discard: true } : undefined);
      },
    };
  };
  const acquireSessionResource = async (reservedRootSession?: symbol): Promise<Use> => {
    assertOpen();
    assertHealthy(state);
    if (reservedRootSession === undefined) assertRootAllowed(options.rootState, false);
    else if (options.rootState.activeSession !== reservedRootSession) {
      throw new DatabaseScopeError(
        "BRAID_SESSION_SCOPE",
        "The root database handle cannot acquire its reserved session resource.",
      );
    }
    assertSessionCapability(executor, options.capabilities);
    if (!options.pooled) {
      const release = await acquireDirectRoot(state, false, reservedRootSession);
      return {
        executor: executor as QueryExecutor,
        physicalState: state,
        direct: true,
        ownsLease: true,
        release: async () => {
          release();
        },
      };
    }
    const lease = await (executor as ConnectionProvider).acquire();
    if (
      !lease ||
      typeof lease !== "object" ||
      typeof lease.release !== "function" ||
      typeof lease.query !== "function"
    ) {
      throw new TypeError("Connection provider returned an invalid lease.");
    }
    if (lease.statementBinding !== statementBinding) {
      let releaseError: unknown;
      try {
        await lease.release({ discard: true });
      } catch (error) {
        releaseError = error;
      }
      const mismatch = bindingIdentityMismatch();
      if (releaseError !== undefined)
        throw new AggregateError([mismatch, releaseError], "Binding identity mismatch and lease cleanup failed.", {
          cause: mismatch,
        });
      throw mismatch;
    }
    try {
      assertSessionCapability(lease, options.capabilities);
    } catch (error) {
      try {
        await lease.release({ discard: true });
      } catch (releaseError) {
        // oxlint-disable-next-line preserve-caught-error -- Both errors are retained; the capability failure remains the primary cause.
        throw new AggregateError([error, releaseError], "Session capability check and lease cleanup failed.", {
          cause: error,
        });
      }
      throw error;
    }
    const leaseState = scopeStateFor(lease);
    try {
      assertHealthy(leaseState);
    } catch (error) {
      try {
        await lease.release({ discard: true });
      } catch (releaseError) {
        // oxlint-disable-next-line preserve-caught-error -- Both errors are retained; the poisoned lease remains the primary cause.
        throw new AggregateError([error, releaseError], "Poisoned lease cleanup failed.", { cause: error });
      }
      throw error;
    }
    return {
      executor: lease,
      physicalState: leaseState,
      direct: false,
      ownsLease: true,
      release: async (discard = false) => {
        await lease.release(discard ? { discard: true } : undefined);
      },
    };
  };
  const pinnedResource = (): Use | undefined => {
    if (options.pinned) return options.pinned;
    if (options.transaction && options.lease && options.leaseState) {
      return {
        executor: options.lease,
        physicalState: options.leaseState,
        direct: true,
        ownsLease: false,
        release: async () => {},
      };
    }
    return undefined;
  };
  return { leaseForUse, acquireSessionResource, pinnedResource };
}
