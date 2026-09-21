import { DatabaseScopeError } from "./errors.js";
import { createAsyncContextStorage } from "#async-context";
import type {
  ConnectionLease,
  DatabaseEnvironment,
  DatabaseOptions,
  Query,
  QueryResultKind,
  QueryExecutor,
  QueryExecutionResult,
  RenderedStatement,
  StatementBindingDescription,
} from "@sqlbraid/core";

// `tail` serializes ordinary physical work; `transactionTail` also gates transaction-control transitions.
// Scope/session markers reject callback escape and synchronous nested-scope races before async setup completes.
// A poisoned resource is never reused: cleanup failure can make the underlying connection unsafe to return.
export interface ScopeState {
  tail: Promise<void>;
  transactionTail: Promise<void>;
  streamUsers: number;
  pendingStreams?: number;
  directBusy?: boolean;
  activeScope?: symbol;
  activeSession?: symbol;
  poisoned?: unknown;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export type ScopeKind = "root" | "session" | "transaction";

export interface RuntimeOptions extends DatabaseOptions {
  readonly transaction: boolean;
  readonly scopeKind: ScopeKind;
  readonly preparedNames: Set<string>;
  readonly rootState: ScopeState;
  readonly capabilities?: DatabaseEnvironment["capabilities"];
  readonly pooled: boolean;
  readonly lease?: ConnectionLease;
  readonly leaseState?: ScopeState;
  readonly pinned?: Use;
  readonly transactionId?: string;
  readonly depth: number;
  readonly scope?: symbol;
  readonly transactionScope?: symbol;
}

export interface TransactionContext {
  readonly rootState: ScopeState;
  readonly activity: { active: boolean };
  readonly parent?: TransactionContext;
}

export interface SessionContext {
  readonly rootState: ScopeState;
  readonly activity: { active: boolean };
  readonly parent?: SessionContext;
}

export interface PhysicalContext {
  readonly rootState: ScopeState;
  readonly direct: boolean;
  readonly stream: boolean;
}

export interface OperationMeta {
  readonly operationId: string;
  readonly purpose?: "environment";
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
  readonly preparedName?: string;
  readonly batchId?: string;
}

export interface PreparedOperation<Q extends Query<unknown, QueryResultKind>> {
  readonly query: Q;
  readonly rendered: RenderedStatement;
  readonly binding: StatementBindingDescription;
  readonly meta: OperationMeta;
}

export interface RawOperation<Q extends Query<unknown, QueryResultKind>> extends PreparedOperation<Q> {
  readonly result?: QueryExecutionResult<unknown>;
  readonly durationMs: number;
  readonly driverError?: unknown;
  readonly driverFailed: boolean;
}

export interface Use {
  readonly executor: QueryExecutor;
  readonly physicalState: ScopeState;
  readonly direct: boolean;
  readonly ownsLease: boolean;
  readonly release: (discard?: boolean) => Promise<void>;
}

export class PreparationFailure extends Error {
  declare readonly cause?: unknown;
  readonly stage: "render" | "prepared" | "materialize";

  constructor(stage: "render" | "prepared" | "materialize", cause: unknown) {
    super(
      stage === "render"
        ? "Query rendering failed."
        : stage === "prepared"
          ? "Prepared query failed."
          : "Statement materialization failed.",
      { cause },
    );
    this.name = "PreparationFailure";
    this.stage = stage;
  }
}

export class BatchAbortedError extends Error {
  readonly code = "BRAID_BATCH_ABORTED" as const;
  readonly batchId: string;
  declare readonly cause?: unknown;

  constructor(batchId: string, cause: unknown) {
    super("Batch operation was abandoned after an earlier batch operation failed.", { cause });
    this.name = "BatchAbortedError";
    this.batchId = batchId;
  }
}

export const transactionContext = createAsyncContextStorage<TransactionContext>();
export const sessionContext = createAsyncContextStorage<SessionContext>();
export const physicalContext = createAsyncContextStorage<PhysicalContext>();
export const scopeStates = new WeakMap<object, ScopeState>();

let operationSequence = 0;
let transactionSequence = 0;

export function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value as T | PromiseLike<T>);
    reject = (reason) => rejectPromise(reason);
  });
  return { promise, resolve, reject };
}

export function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function nextOperationId(): string {
  operationSequence += 1;
  return `braid_op_${operationSequence}`;
}

export function nextTransactionId(): string {
  transactionSequence += 1;
  return `braid_tx_${transactionSequence}`;
}

// Share lifecycle state by physical ownership, not by wrapper identity; pooled providers create fresh state per lease.
export function scopeStateFor(executor: QueryExecutor): ScopeState {
  const key = executor.ownershipKey ?? executor;
  let state = scopeStates.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), transactionTail: Promise.resolve(), streamUsers: 0 };
    scopeStates.set(key, state);
  }
  return state;
}

// Transaction-control turns use a separate queue so begin/commit/savepoint transitions cannot overtake scoped work.
export function acquireTransactionTurn(state: ScopeState): Promise<() => void> {
  assertHealthy(state);
  const { promise: turn, resolve: release } = deferred<void>();
  const previous = state.transactionTail;
  state.transactionTail = previous.then(() => turn);
  return previous.then(() => release);
}

export function isPoisoned(state: ScopeState): boolean {
  return Object.hasOwn(state, "poisoned");
}

export function poison(state: ScopeState, reason: unknown): void {
  if (!isPoisoned(state)) state.poisoned = reason;
}

export function assertHealthy(state: ScopeState): void {
  if (isPoisoned(state)) {
    throw new DatabaseScopeError(
      "BRAID_CONNECTION_POISONED",
      "The physical execution resource is poisoned and cannot accept new SQLBraid work.",
      state.poisoned,
    );
  }
}

// Root escape checks run before acquisition: a callback must use its scoped handle, and an open stream owns the resource.
export function assertRootAllowed(rootState: ScopeState, stream: boolean): void {
  if (transactionContext.conservative && rootState.activeScope !== undefined) {
    throw new DatabaseScopeError(
      "BRAID_TX_SCOPE",
      "The root database handle cannot be used while its direct transaction owns the database.",
    );
  }
  if (sessionContext.conservative && rootState.activeSession !== undefined) {
    throw new DatabaseScopeError(
      "BRAID_SESSION_SCOPE",
      "The root database handle cannot be used while its session scope owns the database.",
    );
  }
  for (let transaction = transactionContext.getStore(); transaction; transaction = transaction.parent) {
    if (transaction.rootState === rootState && transaction.activity.active) {
      throw new DatabaseScopeError(
        "BRAID_TX_SCOPE",
        "The root database handle cannot be used from its own transaction callback.",
      );
    }
  }
  for (let session = sessionContext.getStore(); session; session = session.parent) {
    if (session.rootState === rootState && session.activity.active) {
      throw new DatabaseScopeError(
        "BRAID_SESSION_SCOPE",
        "The root database handle cannot be used from its own session callback.",
      );
    }
  }
  const active = physicalContext.getStore();
  if (active?.rootState === rootState && active.direct && active.stream) {
    throw new DatabaseScopeError(
      "BRAID_STREAM_SCOPE",
      "A direct database stream cannot re-enter its own physical execution resource.",
    );
  }
  if (rootState.streamUsers > 0 || (rootState.pendingStreams ?? 0) > (stream ? 1 : 0)) {
    throw new DatabaseScopeError(
      "BRAID_STREAM_SCOPE",
      "A direct database stream cannot re-enter its own physical execution resource.",
    );
  }
  if (!stream && active?.rootState === rootState && active.direct) {
    throw new DatabaseScopeError(
      "BRAID_REENTRY",
      "A direct database operation cannot re-enter its own physical execution resource.",
    );
  }
}

// Direct executors are serialized here; browser-style conservative resources reject overlap instead of queueing it.
export function acquireDirectRoot(
  rootState: ScopeState,
  stream: boolean,
  reservedRootScope?: symbol,
): Promise<() => void> {
  assertHealthy(rootState);
  if (reservedRootScope === undefined) assertRootAllowed(rootState, stream);
  else if (rootState.activeScope !== reservedRootScope && rootState.activeSession !== reservedRootScope) {
    throw new DatabaseScopeError(
      "BRAID_TX_SCOPE",
      "The root database handle cannot acquire its reserved physical resource.",
    );
  }
  if (physicalContext.conservative && rootState.directBusy) {
    throw new DatabaseScopeError(
      stream ? "BRAID_STREAM_SCOPE" : "BRAID_REENTRY",
      "A direct browser database operation cannot overlap another physical operation.",
    );
  }
  if (physicalContext.conservative) {
    rootState.directBusy = true;
    return Promise.resolve(() => {
      rootState.directBusy = false;
    });
  }
  const { promise: turn, resolve: release } = deferred<void>();
  // Release the tail only after the physical operation has completed so later work cannot overlap it.
  const previous = rootState.tail;
  rootState.tail = previous.then(() => turn);
  return previous.then(() => {
    if (isPoisoned(rootState)) {
      release();
      assertHealthy(rootState);
    }
    return release;
  });
}
