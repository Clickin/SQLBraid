import { createRenderedBulk, createRenderedStatement, UnsupportedFeatureError } from "@sqlbraid/core";
import type {
  BulkBindingDescription,
  BulkExecutionResult,
  BulkResult,
  Awaitable,
  CallQuery,
  CommandQuery,
  ConnectionLease,
  ConnectionProvider,
  Database,
  DatabaseEnvironment,
  DatabaseOptions,
  ExecutableQuery,
  ExecutionEvent,
  ExecutionOptions,
  ExecutionResultOf,
  PreparedFactoryOptions,
  PreparedQuery,
  PreparableQuery,
  Query,
  QueryExecutionResult,
  QueryExecutor,
  QueryResultKind,
  QueryRow,
  DriverRoutineResult,
  StatementBindingAdapter,
  StatementBindingDescription,
  RenderedBulk,
  RenderedStatement,
  RoutineCallResult,
  RowQuery,
  RowValidationOptions,
  StandardSchemaV1,
  StreamOptions,
  TransactionOptions,
} from "@sqlbraid/core";
import { preparedShape } from "./prepared-shape.js";
import {
  acquireDirectRoot,
  acquireTransactionTurn,
  assertHealthy,
  assertRootAllowed,
  isPoisoned,
  nextOperationId,
  nextTransactionId,
  poison,
  scopeStateFor,
  transactionContext,
  sessionContext,
  physicalContext,
  type PreparedOperation,
  type RawOperation,
  type RuntimeOptions,
  type ScopeState,
  type Use,
  type PhysicalContext,
  PreparationFailure,
  BatchAbortedError,
  now,
} from "./state.js";
import { environmentQueries, runtimeEnvironment } from "./environment.js";
import {
  assertExecutionOptions,
  assertSessionCapability,
  assertFeatureCapability,
  assertTransactionOptions,
  validateTransactionOptionSupport,
} from "./capabilities.js";
import {
  assertBindingDescription,
  assertBulkBindingDescription,
  bindingAdapterFor,
  bindingIdentityMismatch,
  bulkShape,
  isBindingIdentityMismatch,
} from "./binding.js";
import {
  addSafeCount,
  assertBulkExecutionResult,
  assertExecutableQuery,
  assertRowsQuery,
  assertExecutionResult,
  standardSchemaFor,
  validateRow,
  malformedExecutionResult,
  resourceCleanupFailure,
} from "./validation.js";
import {
  assertDriverRoutineResult,
  callRequiresTransaction,
  codedError,
  mapRoutineResult,
  executablePreparedOperation,
  rowPreparedOperation,
  callPreparedOperation,
} from "./routine-mapping.js";
import {
  batchFailure,
  bulkReadyEvent,
  errorEvent,
  metadata,
  notify,
  notifyError,
  notifyTerminalObservers,
  queryMappedEvent,
  queryReadyEvent,
  queryResultEvent,
  streamStartEvent,
  transactionEvent,
  transactionFailure,
  type QueryErrorEventStage,
} from "./observers.js";
import { DatabaseCardinalityError, DatabaseScopeError } from "./errors.js";

export {
  DatabaseCardinalityError,
  DatabaseResultKindError,
  DatabaseResultValidationError,
  DatabaseScopeError,
} from "./errors.js";

type InternalDatabase = Omit<Database, "call" | "stream"> & {
  call<Result extends RoutineCallResult>(
    query: CallQuery<Result>,
    executionOptions?: ExecutionOptions,
    preparedOperation?: PreparedOperation<CallQuery<Result>>,
  ): Promise<Result>;
  stream<Row>(
    query: RowQuery<Row>,
    streamOptions?: StreamOptions<Row>,
    preparedOperation?: PreparedOperation<RowQuery<Row>>,
  ): AsyncIterable<Row>;
  close(): void;
  finish(): Promise<void>;
};

export function createDatabase(executor: QueryExecutor, options: DatabaseOptions = {}): Database {
  bindingAdapterFor(executor);
  const rootState = scopeStateFor(executor);
  return createScopedDatabase(executor, rootState, {
    ...options,
    observers: options.observers === undefined ? [] : Object.freeze([...options.observers]),
    transaction: false,
    scopeKind: "root",
    capabilities: executor.environment?.capabilities,
    preparedNames: new Set<string>(),
    rootState,
    pooled: false,
    depth: 0,
  });
}

/**
 * Wrap a lease-producing pool/provider as an async SQLBraid database.
 * Root materialized operations acquire and release one lease; `tx()` and `session()` retain one lease for the callback.
 */
export function createPooledDatabase(provider: ConnectionProvider, options: DatabaseOptions = {}): Database {
  bindingAdapterFor(provider);
  const rootState: ScopeState = { tail: Promise.resolve(), transactionTail: Promise.resolve(), streamUsers: 0 };
  return createScopedDatabase(provider, rootState, {
    ...options,
    observers: options.observers === undefined ? [] : Object.freeze([...options.observers]),
    transaction: false,
    scopeKind: "root",
    capabilities: provider.environment?.capabilities,
    preparedNames: new Set<string>(),
    rootState,
    pooled: true,
    depth: 0,
  });
}

function createScopedDatabase(
  executor: QueryExecutor | ConnectionProvider,
  state: ScopeState,
  options: RuntimeOptions,
): Database & { close(): void; finish(): Promise<void> } {
  let closed = false;
  let environmentSnapshot: Omit<DatabaseEnvironment, "supportMatch"> | undefined;
  const statementBinding = bindingAdapterFor(executor);
  const openStreams = new Set<AsyncGenerator<unknown>>();
  const assertOpen = (): void => {
    if (closed) {
      throw new DatabaseScopeError(
        options.scopeKind === "session" ? "BRAID_SESSION_CLOSED" : "BRAID_TX_CLOSED",
        options.scopeKind === "session"
          ? "Session database is no longer usable."
          : "Transaction database is no longer usable.",
      );
    }
    if (options.scopeKind === "transaction" && state.activeScope !== options.scope) {
      throw new DatabaseScopeError(
        "BRAID_TX_SCOPE",
        "Use the innermost transaction database while its savepoint is active.",
      );
    }
    if (options.scopeKind === "session" && options.transaction && options.transactionScope !== state.activeScope) {
      throw new DatabaseScopeError(
        "BRAID_TX_SCOPE",
        "Use the innermost transaction database while its savepoint is active.",
      );
    }
    if (options.scopeKind === "session" && !options.transaction && state.activeScope !== undefined) {
      throw new DatabaseScopeError(
        "BRAID_TX_SCOPE",
        "Use the innermost transaction database while its transaction is active.",
      );
    }
    if (options.scopeKind === "session" && state.activeSession !== options.scope) {
      throw new DatabaseScopeError(
        "BRAID_SESSION_SCOPE",
        "Use the innermost session database while its nested scope is active.",
      );
    }
  };
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
  const prepare = <Q extends Query<unknown, QueryResultKind>>(
    query: Q,
    preparedName?: string,
    batchId?: string,
    alreadyRendered?: RenderedStatement,
    operationId = nextOperationId(),
  ): PreparedOperation<Q> => {
    assertOpen();
    let rendered: RenderedStatement;
    try {
      rendered = alreadyRendered ?? createRenderedStatement(query.render());
    } catch (error) {
      throw new PreparationFailure("render", error);
    }
    const adapter = statementBinding;
    const requestedReuse =
      options.reuse === "simple" ? "simple" : preparedName === undefined ? (options.reuse ?? "auto") : "reuse";
    let binding: StatementBindingDescription;
    try {
      binding = assertBindingDescription(
        adapter.describe(rendered, {
          dialectId: rendered.dialectId,
          requestedReuse,
          preparedName,
          transactionScoped: options.transaction,
        }),
        adapter,
        rendered,
      );
      if ("parameterizedSql" in binding) {
        const parameterizedSql = binding.parameterizedSql;
        if (parameterizedSql !== undefined && typeof parameterizedSql !== "string") {
          throw new TypeError("BRAID_BIND_TRANSPORT: binding parameterized SQL must be a string.");
        }
        if (
          (binding.transport === "text-positional" || binding.transport === "text-named") &&
          parameterizedSql === undefined
        ) {
          throw new TypeError("BRAID_BIND_TRANSPORT: text binding descriptions must provide parameterized SQL.");
        }
      } else if (binding.transport === "text-positional" || binding.transport === "text-named") {
        throw new TypeError("BRAID_BIND_TRANSPORT: text binding descriptions must provide parameterized SQL.");
      }
    } catch (error) {
      throw new PreparationFailure("materialize", error);
    }
    return {
      query,
      rendered,
      binding,
      meta: {
        ...metadata(options, operationId, preparedName, batchId),
        ...(environmentQueries.has(query) ? { purpose: "environment" as const } : {}),
      },
    };
  };
  const observePrepared = async <Q extends Query<unknown, QueryResultKind>>(
    operation: PreparedOperation<Q>,
  ): Promise<void> => {
    try {
      await notify(options.observers ?? [], queryReadyEvent(operation));
    } catch (error) {
      await notifyError(options.observers ?? [], errorEvent(operation, error, "observer-before", false, false), error);
    }
  };
  const prepareObserved = async <Q extends Query<unknown, QueryResultKind>>(
    query: Q,
    preparedName?: string,
    batchId?: string,
  ): Promise<PreparedOperation<Q>> => {
    const operationId = nextOperationId();
    let operation: PreparedOperation<Q>;
    try {
      operation = prepare(query, preparedName, batchId, undefined, operationId);
    } catch (error) {
      const failure = error instanceof PreparationFailure ? error : undefined;
      const reported = failure === undefined ? error : failure.cause;
      await notifyError(
        options.observers ?? [],
        errorEvent(
          {
            meta: {
              ...metadata(options, operationId, preparedName, batchId),
              ...(environmentQueries.has(query) ? { purpose: "environment" as const } : {}),
            },
          },
          reported,
          failure?.stage ?? "render",
          false,
          false,
        ),
        reported,
      );
      throw reported;
    }
    await observePrepared(operation);
    return operation;
  };
  const prepareNamedFactoryObserved = async (
    factory: () => PreparableQuery,
    preparedName: string,
    shape: { value?: string },
  ): Promise<PreparedOperation<PreparableQuery>> => {
    const operationId = nextOperationId();
    let query: PreparableQuery;
    try {
      query = factory();
    } catch (error) {
      const operation = { meta: metadata(options, operationId, preparedName) };
      await notifyError(options.observers ?? [], errorEvent(operation, error, "prepared", false, false), error);
      throw error;
    }
    let rendered: RenderedStatement;
    try {
      rendered = createRenderedStatement(query.render());
    } catch (error) {
      const operation = { meta: metadata(options, operationId, preparedName) };
      await notifyError(options.observers ?? [], errorEvent(operation, error, "render", false, false), error);
      throw error;
    }
    const nextShape = preparedShape(query.resultKind, rendered);
    if (shape.value === undefined) shape.value = nextShape;
    else if (shape.value !== nextShape) {
      const error = codedError(
        "BRAID_PREPARED_SHAPE",
        `Prepared query ${preparedName} changed its rendered structure.`,
      );
      const operation = { meta: metadata(options, operationId, preparedName) };
      await notifyError(options.observers ?? [], errorEvent(operation, error, "prepared", false, false), error);
      throw error;
    }
    let operation: PreparedOperation<PreparableQuery>;
    try {
      operation = prepare(query, preparedName, undefined, rendered, operationId);
    } catch (error) {
      const failure = error instanceof PreparationFailure ? error : undefined;
      const reported = failure === undefined ? error : failure.cause;
      const preparedOperation = { meta: metadata(options, operationId, preparedName) };
      await notifyError(
        options.observers ?? [],
        errorEvent(preparedOperation, reported, failure?.stage ?? "materialize", false, false),
        reported,
      );
      throw reported;
    }
    await observePrepared(operation);
    return operation;
  };
  const physical = async <Q extends ExecutableQuery>(
    operation: PreparedOperation<Q>,
    use: Use,
    executionOptions?: ExecutionOptions,
  ): Promise<RawOperation<Q>> => {
    const started = now();
    try {
      const result = await physicalContext.run(
        { rootState: options.rootState, direct: use.direct, stream: false },
        () => use.executor.query<unknown>(operation.rendered, operation.binding, executionOptions),
      );
      return { ...operation, result, durationMs: now() - started, driverFailed: false };
    } catch (driverError) {
      if (resourceCleanupFailure(driverError)) poison(use.physicalState, driverError);
      return { ...operation, driverError, driverFailed: true, durationMs: now() - started };
    }
  };
  const finalizePhysical = async <Q extends ExecutableQuery>(
    operation: RawOperation<Q>,
  ): Promise<QueryExecutionResult<unknown>> => {
    if (operation.driverFailed) {
      await notifyError(
        options.observers ?? [],
        errorEvent(
          operation as RawOperation<ExecutableQuery>,
          operation.driverError,
          "driver",
          true,
          false,
          operation.durationMs,
        ),
        operation.driverError,
      );
    }
    let result: QueryExecutionResult<unknown>;
    try {
      result = assertExecutionResult(operation.query, operation.result as QueryExecutionResult<unknown>);
    } catch (error) {
      await notifyError(
        options.observers ?? [],
        errorEvent(operation as RawOperation<ExecutableQuery>, error, "result-kind", true, true, operation.durationMs),
        error,
      );
    }
    try {
      await notify(options.observers ?? [], queryResultEvent(operation as RawOperation<ExecutableQuery>, result!));
    } catch (error) {
      await notifyError(
        options.observers ?? [],
        errorEvent(
          operation as RawOperation<ExecutableQuery>,
          error,
          "observer-after",
          true,
          true,
          operation.durationMs,
        ),
        error,
      );
    }
    return result!;
  };
  const processRows = async <Q extends ExecutableQuery>(
    operation: RawOperation<Q>,
    result: QueryExecutionResult<unknown>,
    executionSchema?: StandardSchemaV1<unknown, QueryRow<Q>>,
  ): Promise<QueryExecutionResult<unknown>> => {
    const queryMapped = operation.query.resultSchema !== undefined;
    const executionMapped = executionSchema !== undefined;
    if (result.kind !== "rows" || (!queryMapped && !executionMapped)) {
      try {
        await notify(
          options.observers ?? [],
          queryMappedEvent(
            operation as RawOperation<ExecutableQuery>,
            result.kind === "rows" ? result.rows.length : (result.rowCount ?? 0),
            queryMapped,
            executionMapped,
            0,
          ),
        );
      } catch (error) {
        await notifyError(
          options.observers ?? [],
          errorEvent(
            operation as RawOperation<ExecutableQuery>,
            error,
            "observer-after",
            true,
            true,
            operation.durationMs,
          ),
          error,
        );
      }
      return result;
    }
    const mappingStarted = now();
    const rows: unknown[] = [];
    let queryStandard: StandardSchemaV1.Props<unknown, unknown> | undefined;
    let executionStandard: StandardSchemaV1.Props<unknown, unknown> | undefined;
    try {
      queryStandard = standardSchemaFor(operation.query.resultSchema) as
        | StandardSchemaV1.Props<unknown, unknown>
        | undefined;
    } catch (error) {
      await notifyError(
        options.observers ?? [],
        errorEvent(operation as RawOperation<ExecutableQuery>, error, "query-map", true, true, operation.durationMs),
        error,
      );
    }
    try {
      executionStandard = standardSchemaFor(executionSchema) as StandardSchemaV1.Props<unknown, unknown> | undefined;
    } catch (error) {
      await notifyError(
        options.observers ?? [],
        errorEvent(
          operation as RawOperation<ExecutableQuery>,
          error,
          "execution-map",
          true,
          true,
          operation.durationMs,
        ),
        error,
      );
    }
    for (let rowIndex = 0; rowIndex < result.rows.length; rowIndex += 1) {
      let mapped: unknown = result.rows[rowIndex];
      if (queryStandard !== undefined) {
        try {
          mapped = await validateRow(queryStandard, mapped, rowIndex, "query");
        } catch (error) {
          await notifyError(
            options.observers ?? [],
            errorEvent(
              operation as RawOperation<ExecutableQuery>,
              error,
              "query-map",
              true,
              true,
              operation.durationMs,
            ),
            error,
          );
        }
      }
      if (executionStandard !== undefined) {
        try {
          mapped = await validateRow(executionStandard, mapped, rowIndex, "execution");
        } catch (error) {
          await notifyError(
            options.observers ?? [],
            errorEvent(
              operation as RawOperation<ExecutableQuery>,
              error,
              "execution-map",
              true,
              true,
              operation.durationMs,
            ),
            error,
          );
        }
      }
      rows.push(mapped);
    }
    try {
      await notify(
        options.observers ?? [],
        queryMappedEvent(
          operation as RawOperation<ExecutableQuery>,
          result.rows.length,
          queryMapped,
          executionMapped,
          now() - mappingStarted,
        ),
      );
    } catch (error) {
      await notifyError(
        options.observers ?? [],
        errorEvent(
          operation as RawOperation<ExecutableQuery>,
          error,
          "observer-after",
          true,
          true,
          operation.durationMs,
        ),
        error,
      );
    }
    return { ...result, rows: rows! };
  };
  const processOne = async <Q extends ExecutableQuery>(
    operation: RawOperation<Q>,
    result: QueryExecutionResult<unknown>,
    executionSchema?: StandardSchemaV1<unknown, QueryRow<Q>>,
  ): Promise<unknown> => {
    if (result.kind !== "rows") return result;
    const mapped = await processRows(operation, result, executionSchema);
    return mapped.rows[0];
  };
  const runPrepared = async <Q extends ExecutableQuery>(
    operation: PreparedOperation<Q>,
    executionOptions?: ExecutionOptions,
  ): Promise<RawOperation<Q>> => {
    let use: Use;
    try {
      use = await leaseForUse(false, statementBinding, executionOptions);
    } catch (error) {
      const stage = isBindingIdentityMismatch(error) ? "materialize" : "acquire";
      await notifyError(options.observers ?? [], errorEvent(operation, error, stage, false, false), error);
      throw error;
    }
    // Materialize and release before Standard Schema mapping so pooled connections are not held during application code.
    const raw = await physical(operation, use!, executionOptions);
    let releaseError: unknown;
    let releaseFailed = false;
    try {
      await use!.release(isPoisoned(use!.physicalState));
    } catch (error) {
      releaseError = error;
      releaseFailed = true;
      poison(use!.physicalState, error);
    }
    if (raw.driverFailed) {
      const original = releaseFailed
        ? new AggregateError([raw.driverError, releaseError], "Execution and lease release failed.", {
            cause: raw.driverError,
          })
        : raw.driverError;
      const stage = releaseFailed ? "release" : "driver";
      await notifyError(
        options.observers ?? [],
        errorEvent(raw as RawOperation<ExecutableQuery>, original, stage, true, false, raw.durationMs),
        original,
      );
    }
    if (releaseFailed) {
      await notifyError(
        options.observers ?? [],
        errorEvent(raw as RawOperation<ExecutableQuery>, releaseError, "release", true, true, raw.durationMs),
        releaseError,
      );
    }
    return raw;
  };
  const runMaterialized = async <Q extends ExecutableQuery>(
    query: Q,
    preparedName?: string,
    batchId?: string,
    executionOptions?: ExecutionOptions,
  ): Promise<RawOperation<Q>> => {
    assertExecutableQuery(query);
    return runPrepared(await prepareObserved(query, preparedName, batchId), executionOptions);
  };
  const materializedPreparedResult = async <Q extends ExecutableQuery>(
    operation: PreparedOperation<Q>,
    executionSchema?: StandardSchemaV1<unknown, QueryRow<Q>>,
    executionOptions?: ExecutionOptions,
  ): Promise<QueryExecutionResult<unknown>> => {
    const raw = await runPrepared(operation, executionOptions);
    const result = await finalizePhysical(raw);
    return processRows(raw, result, executionSchema);
  };
  const materializedResult = async <Q extends ExecutableQuery>(
    query: Q,
    preparedName?: string,
    executionSchema?: StandardSchemaV1<unknown, QueryRow<Q>>,
    batchId?: string,
    executionOptions?: ExecutionOptions,
  ): Promise<QueryExecutionResult<unknown>> => {
    return materializedPreparedResult(
      await prepareObserved(query, preparedName, batchId),
      executionSchema,
      executionOptions,
    );
  };
  const executeNamed = async <Q extends ExecutableQuery>(
    query: Q,
    preparedName?: string,
    executionOptions?: ExecutionOptions,
  ): Promise<ExecutionResultOf<Q>> =>
    (await materializedResult(query, preparedName, undefined, undefined, executionOptions)) as ExecutionResultOf<Q>;
  const allNamed = async <Row>(
    query: RowQuery<Row>,
    validationOptions?: RowValidationOptions<Row>,
    preparedName?: string,
  ): Promise<readonly Row[]> => {
    const result = await materializedResult(
      query,
      preparedName,
      validationOptions?.schema,
      undefined,
      validationOptions,
    );
    if (result.kind !== "rows") malformedExecutionResult();
    return result.rows as readonly Row[];
  };
  const oneNamed = async <Row>(
    query: RowQuery<Row>,
    validationOptions?: RowValidationOptions<Row>,
    preparedName?: string,
  ): Promise<Row> => {
    const raw = await runMaterialized(query, preparedName, undefined, validationOptions);
    const result = await finalizePhysical(raw);
    if (result.kind !== "rows") malformedExecutionResult();
    if (result.rows.length !== 1) {
      const error = new DatabaseCardinalityError("one", result.rows.length);
      await notifyError(
        options.observers ?? [],
        errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs),
        error,
      );
    }
    return (await processOne(raw, result, validationOptions?.schema)) as Row;
  };
  const maybeOneNamed = async <Row>(
    query: RowQuery<Row>,
    validationOptions?: RowValidationOptions<Row>,
    preparedName?: string,
  ): Promise<Row | undefined> => {
    const raw = await runMaterialized(query, preparedName, undefined, validationOptions);
    const result = await finalizePhysical(raw);
    if (result.kind !== "rows") malformedExecutionResult();
    if (result.rows.length > 1) {
      const error = new DatabaseCardinalityError("maybeOne", result.rows.length);
      await notifyError(
        options.observers ?? [],
        errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs),
        error,
      );
    }
    if (result.rows.length === 0) {
      try {
        await notify(
          options.observers ?? [],
          queryMappedEvent(
            raw as RawOperation<ExecutableQuery>,
            0,
            query.resultSchema !== undefined,
            validationOptions?.schema !== undefined,
            0,
          ),
        );
      } catch (error) {
        await notifyError(
          options.observers ?? [],
          errorEvent(raw as RawOperation<ExecutableQuery>, error, "observer-after", true, true, raw.durationMs),
          error,
        );
      }
      return undefined;
    }
    return (await processOne(raw, result, validationOptions?.schema)) as Row;
  };
  const database: InternalDatabase = {
    async environment(environmentOptions = {}): Promise<DatabaseEnvironment> {
      assertOpen();
      assertHealthy(state);
      if (options.scopeKind === "root") assertRootAllowed(options.rootState, false);
      const refresh = environmentOptions.refresh === true;
      if (refresh || !environmentSnapshot) {
        const descriptor = executor.environment;
        let databaseInfo = descriptor?.database ?? { product: "unknown" };
        let capabilities = descriptor?.capabilities ?? {};
        if (descriptor?.probe) {
          const rendered = createRenderedStatement(descriptor.probe.statement);
          if (rendered.resultKind !== "rows" || rendered.parameters.length !== 0) {
            throw new TypeError("Environment probes must be parameter-free row statements.");
          }
          const query: RowQuery = {
            ir: { version: 1, nodes: [], sourceLength: rendered.segments[0]!.length },
            values: [],
            resultKind: "rows",
            render: () => rendered,
          };
          environmentQueries.add(query);
          const rows = await allNamed(query);
          const observed = descriptor.probe.read(rows);
          databaseInfo = {
            ...databaseInfo,
            ...(observed.version === undefined ? {} : { version: observed.version }),
            ...(observed.edition === undefined ? {} : { edition: observed.edition }),
          };
          if (observed.capabilities !== undefined) {
            const observedCapabilities =
              options.pooled && !options.transaction
                ? Object.fromEntries(
                    Object.entries(observed.capabilities).map(([id, capability]) => [
                      id,
                      capability.status === "guaranteed" ? { ...capability, status: "guarded" as const } : capability,
                    ]),
                  )
                : observed.capabilities;
            capabilities = { ...capabilities, ...observedCapabilities };
          }
        }
        environmentSnapshot = Object.freeze({
          database: Object.freeze({ ...databaseInfo }),
          driver: Object.freeze({ ...(descriptor?.driver ?? { id: statementBinding.id }) }),
          runtime: runtimeEnvironment(),
          ...(descriptor?.typePolicy === undefined ? {} : { typePolicy: Object.freeze({ ...descriptor.typePolicy }) }),
          capabilities: Object.freeze(
            Object.fromEntries(
              Object.entries(capabilities).map(([id, capability]) => [
                id,
                Object.freeze({
                  ...capability,
                  ...(capability.rawRepresentations
                    ? { rawRepresentations: Object.freeze([...capability.rawRepresentations]) }
                    : {}),
                }),
              ]),
            ),
          ),
        });
        // A pooled probe describes one acquired lease, not every future lease.
        // Refresh replaces this scope's snapshot, while observed guarantees are
        // guarded above so the snapshot cannot claim pool-wide certainty.
      }
      const evidence = environmentSnapshot!;
      const matches = (environmentOptions.targets ?? []).filter(
        (target) =>
          (target.status === "official" || target.status === "conditional") &&
          target.evidence.status === "verified" &&
          target.database.product === evidence.database.product &&
          target.database.version === evidence.database.version &&
          target.database.edition === evidence.database.edition &&
          target.driver.id === evidence.driver.id &&
          target.driver.version === evidence.driver.version &&
          target.driver.profile === evidence.driver.profile &&
          target.runtime.id === evidence.runtime.id &&
          target.runtime.version === evidence.runtime.version &&
          evidence.typePolicy !== undefined &&
          target.typePolicy?.id === evidence.typePolicy.id &&
          target.typePolicy?.hash === evidence.typePolicy.hash,
      );
      const target = matches.length === 1 ? matches[0] : undefined;
      const supportMatch: DatabaseEnvironment["supportMatch"] = target
        ? { status: target.status === "official" ? "official" : "conditional", targetId: target.id }
        : { status: "compatible", reason: matches.length > 1 ? "ambiguous-exact-target" : "no-verified-exact-target" };
      return Object.freeze({ ...evidence, supportMatch: Object.freeze(supportMatch) });
    },
    async execute<Q extends ExecutableQuery>(
      query: Q,
      executionOptions?: ExecutionOptions,
    ): Promise<ExecutionResultOf<Q>> {
      return await executeNamed(query, undefined, executionOptions);
    },
    async call<Result extends RoutineCallResult>(
      query: CallQuery<Result>,
      executionOptions?: ExecutionOptions,
      preparedOperation?: PreparedOperation<CallQuery<Result>>,
    ): Promise<Result> {
      assertOpen();
      if (query.resultKind !== "call") throw new TypeError("Only call queries may be executed with database.call().");
      const operation = preparedOperation ?? (await prepareObserved(query));
      try {
        assertExecutionOptions(executor, executionOptions, options.capabilities);
      } catch (error) {
        await notifyError(options.observers ?? [], errorEvent(operation, error, "materialize", false, false), error);
      }
      if (!options.transaction && callRequiresTransaction(operation.rendered)) {
        const error = codedError(
          "BRAID_CALL_CURSOR_TX_REQUIRED",
          "A PostgreSQL refcursor routine call requires an existing transaction-scoped database.",
        );
        await notifyError(options.observers ?? [], errorEvent(operation, error, "materialize", false, false), error);
      }
      try {
        assertFeatureCapability(
          executor,
          "routine.call",
          "BRAID_CALL_UNSUPPORTED",
          "The selected execution resource does not expose a routine-call protocol.",
          options.capabilities,
        );
        if (query.routineContract?.returnValue !== undefined) {
          assertFeatureCapability(
            executor,
            "routine.return-value",
            "BRAID_CALL_RETURN_UNSUPPORTED",
            "The selected execution resource does not expose a routine return/status channel.",
            options.capabilities,
          );
        }
        for (const parameter of operation.rendered.parameters) {
          if (parameter.direction === "out") {
            assertFeatureCapability(
              executor,
              "routine.out",
              "BRAID_CALL_OUT_UNSUPPORTED",
              "The selected execution resource does not expose a routine OUT parameter channel.",
              options.capabilities,
            );
          } else if (parameter.direction === "inout") {
            assertFeatureCapability(
              executor,
              "routine.inout",
              "BRAID_CALL_OUT_UNSUPPORTED",
              "The selected execution resource does not expose a routine INOUT parameter channel.",
              options.capabilities,
            );
          }
        }
      } catch (error) {
        await notifyError(options.observers ?? [], errorEvent(operation, error, "materialize", false, false), error);
      }
      let use: Use;
      try {
        use = await leaseForUse(false, statementBinding, executionOptions);
      } catch (error) {
        const stage = isBindingIdentityMismatch(error) ? "materialize" : "acquire";
        await notifyError(options.observers ?? [], errorEvent(operation, error, stage, false, false), error);
        throw error;
      }
      if (!use!.executor.call) {
        const error = new UnsupportedFeatureError(
          "routine.call",
          "BRAID_CALL_UNSUPPORTED",
          "The selected execution resource does not expose a routine-call protocol.",
        );
        let releaseError: unknown;
        try {
          await use!.release();
        } catch (failure) {
          releaseError = failure;
          poison(use!.physicalState, failure);
        }
        const reported =
          releaseError === undefined
            ? error
            : new AggregateError([error, releaseError], "Call and lease release failed.", { cause: error });
        await notifyError(
          options.observers ?? [],
          errorEvent(operation, reported, releaseError === undefined ? "driver" : "release", false, false),
          reported,
        );
      }
      const started = now();
      let value!: DriverRoutineResult;
      let released = false;
      try {
        value = await physicalContext.run({ rootState: options.rootState, direct: use!.direct, stream: false }, () =>
          use!.executor.call!(operation.rendered, operation.binding, executionOptions),
        );
      } catch (error) {
        if (resourceCleanupFailure(error)) poison(use!.physicalState, error);
        let releaseError: unknown;
        try {
          await use!.release(isPoisoned(use!.physicalState));
        } catch (failure) {
          releaseError = failure;
          poison(use!.physicalState, failure);
        }
        released = true;
        const original =
          releaseError === undefined
            ? error
            : new AggregateError([error, releaseError], "Execution and lease release failed.", { cause: error });
        await notifyError(
          options.observers ?? [],
          errorEvent(
            operation,
            original,
            releaseError === undefined ? "driver" : "release",
            true,
            false,
            now() - started,
          ),
          original,
        );
      }
      let releaseError: unknown;
      if (!released) {
        try {
          await use!.release(isPoisoned(use!.physicalState));
        } catch (error) {
          releaseError = error;
          poison(use!.physicalState, error);
        }
      }
      let resultValidationError: unknown;
      try {
        assertDriverRoutineResult(value!);
      } catch (error) {
        resultValidationError = error;
      }
      if (resultValidationError !== undefined || releaseError !== undefined) {
        const original = resultValidationError ?? releaseError;
        const reported =
          resultValidationError !== undefined && releaseError !== undefined
            ? new AggregateError([resultValidationError, releaseError], "Routine execution and lease release failed.", {
                cause: resultValidationError,
              })
            : original;
        await notifyError(
          options.observers ?? [],
          errorEvent(
            operation,
            reported,
            releaseError === undefined ? "result-kind" : "release",
            true,
            true,
            now() - started,
          ),
          reported,
        );
      }
      let rowCount = 0;
      for (const resultSet of value!.resultSets) rowCount = addSafeCount(rowCount, resultSet.rows.length);
      try {
        await notify(options.observers ?? [], {
          type: "query:result",
          operationId: operation.meta.operationId,
          preparedName: operation.meta.preparedName,
          batchId: operation.meta.batchId,
          durationMs: now() - started,
          actualKind: "call",
          rowCount,
          resultSetCount: value.resultSets.length,
          outputKeys: Object.freeze(Object.keys(value.output)),
          hasReturnValue: Object.hasOwn(value, "returnValue"),
          transactionDepth: options.depth,
          transactionScoped: options.transaction,
        });
      } catch (error) {
        await notifyError(
          options.observers ?? [],
          errorEvent(operation, error, "observer-after", true, true, now() - started),
          error,
        );
      }
      let mapped: { readonly value: RoutineCallResult; readonly rowCount: number; readonly mapped: boolean };
      try {
        mapped = await mapRoutineResult(value, query.routineContract);
      } catch (error) {
        await notifyError(
          options.observers ?? [],
          errorEvent(operation, error, "query-map", true, true, now() - started),
          error,
        );
      }
      try {
        await notify(options.observers ?? [], {
          type: "query:mapped",
          operationId: operation.meta.operationId,
          preparedName: operation.meta.preparedName,
          batchId: operation.meta.batchId,
          durationMs: 0,
          rowCount,
          queryMapped: mapped!.mapped,
          executionMapped: false,
          transactionDepth: options.depth,
          transactionScoped: options.transaction,
        });
      } catch (error) {
        await notifyError(
          options.observers ?? [],
          errorEvent(operation, error, "observer-after", true, true, now() - started),
          error,
        );
      }
      return mapped!.value as Result;
    },
    async all<Row>(query: RowQuery<Row>, validationOptions?: RowValidationOptions<Row>): Promise<readonly Row[]> {
      assertRowsQuery(query);
      return allNamed(query, validationOptions);
    },
    async one<Row>(query: RowQuery<Row>, validationOptions?: RowValidationOptions<Row>): Promise<Row> {
      assertRowsQuery(query);
      return oneNamed(query, validationOptions);
    },
    async maybeOne<Row>(query: RowQuery<Row>, validationOptions?: RowValidationOptions<Row>): Promise<Row | undefined> {
      assertRowsQuery(query);
      return maybeOneNamed(query, validationOptions);
    },
    async bulk<Input>(
      inputs: readonly Input[],
      factory: (input: Input, index: number) => CommandQuery,
      executionOptions?: ExecutionOptions,
    ): Promise<BulkResult> {
      assertOpen();
      assertHealthy(state);
      if (!Array.isArray(inputs)) throw new TypeError("Bulk inputs must be an array.");
      assertExecutionOptions(executor, executionOptions, options.capabilities);
      if (inputs.length === 0) return Object.freeze({ inputCount: 0, affectedRows: 0 });

      const operationId = nextOperationId();
      const bulkMeta = metadata(options, operationId);
      let canonicalRendered: RenderedStatement | undefined;
      let parameterSets: readonly (readonly unknown[])[] = [];
      let bulk: RenderedBulk | undefined;
      let binding: BulkBindingDescription | undefined;
      try {
        const snapshots: (readonly unknown[])[] = [];
        let canonicalShape: string | undefined;
        for (let index = 0; index < inputs.length; index += 1) {
          let query: CommandQuery;
          try {
            query = factory(inputs[index]!, index);
          } catch (error) {
            throw new PreparationFailure("render", error);
          }
          if (
            query === null ||
            typeof query !== "object" ||
            query.resultKind !== "command" ||
            typeof query.render !== "function"
          ) {
            throw codedError("BRAID_BULK_SHAPE", "db.bulk() factory must return a command query.");
          }
          let rendered: RenderedStatement;
          try {
            rendered = createRenderedStatement(query.render());
          } catch (error) {
            throw new PreparationFailure("render", error);
          }
          if (rendered.resultKind !== "command") {
            throw codedError(
              "BRAID_BULK_SHAPE",
              `Bulk input ${index} rendered a ${rendered.resultKind} statement instead of a command.`,
            );
          }
          const shape = bulkShape(rendered);
          if (canonicalShape === undefined) {
            canonicalShape = shape;
            canonicalRendered = rendered;
          } else if (shape !== canonicalShape) {
            throw codedError("BRAID_BULK_SHAPE", `Bulk input ${index} changed the canonical rendered statement shape.`);
          }
          snapshots.push(Object.freeze(rendered.parameters.map((parameter) => parameter.value)));
        }
        parameterSets = Object.freeze(snapshots);
        bulk = createRenderedBulk({ statement: canonicalRendered!, parameterSets });
        if (typeof statementBinding.describeBulk !== "function") {
          throw codedError("BRAID_BULK_UNSUPPORTED", "Statement binding adapter does not support bulk execution.");
        }
        binding = assertBulkBindingDescription(
          statementBinding.describeBulk(bulk, {
            dialectId: canonicalRendered!.dialectId,
            requestedReuse: options.reuse ?? "auto",
            transactionScoped: options.transaction,
          }),
          statementBinding,
          bulk,
        );
      } catch (error) {
        const failure = error instanceof PreparationFailure ? error : undefined;
        const reported = failure === undefined ? error : failure.cause;
        const stage =
          failure?.stage ??
          (reported instanceof Error && reported.message.startsWith("BRAID_BULK_SHAPE:") ? "prepared" : "materialize");
        await notifyError(
          options.observers ?? [],
          errorEvent({ meta: bulkMeta }, reported, stage, false, false),
          reported,
        );
        throw reported;
      }

      try {
        await notify(options.observers ?? [], bulkReadyEvent(operationId, bulk!, binding!, bulkMeta));
      } catch (error) {
        await notifyError(
          options.observers ?? [],
          errorEvent({ meta: bulkMeta }, error, "observer-before", false, false),
          error,
        );
      }

      try {
        assertFeatureCapability(
          executor,
          "statement.bulk",
          "BRAID_BULK_UNSUPPORTED",
          "The selected execution resource does not expose a bulk protocol.",
          options.capabilities,
        );
      } catch (error) {
        await notifyError(
          options.observers ?? [],
          errorEvent({ meta: bulkMeta }, error, "materialize", false, false),
          error,
        );
      }
      if (!options.pooled && typeof (executor as QueryExecutor).bulk !== "function") {
        const error = new UnsupportedFeatureError(
          "statement.bulk",
          "BRAID_BULK_UNSUPPORTED",
          "The selected execution resource does not expose a bulk protocol.",
        );
        await notifyError(
          options.observers ?? [],
          errorEvent({ meta: bulkMeta }, error, "materialize", false, false),
          error,
        );
        throw error;
      }

      let use: Use;
      try {
        use = await leaseForUse(false, statementBinding, executionOptions);
      } catch (error) {
        const stage = isBindingIdentityMismatch(error) ? "materialize" : "acquire";
        await notifyError(options.observers ?? [], errorEvent({ meta: bulkMeta }, error, stage, false, false), error);
        throw error;
      }
      if (typeof use.executor.bulk !== "function") {
        const unsupported = new UnsupportedFeatureError(
          "statement.bulk",
          "BRAID_BULK_UNSUPPORTED",
          "The leased execution resource does not expose a bulk protocol.",
        );
        let cleanupFailure: unknown;
        try {
          await use.release();
        } catch (error) {
          cleanupFailure = error;
          poison(use.physicalState, error);
        }
        const reported =
          cleanupFailure === undefined
            ? unsupported
            : new AggregateError([unsupported, cleanupFailure], "Bulk capability check and lease release failed.", {
                cause: unsupported,
              });
        await notifyError(
          options.observers ?? [],
          errorEvent(
            { meta: bulkMeta },
            reported,
            cleanupFailure === undefined ? "materialize" : "release",
            false,
            false,
          ),
          reported,
        );
        throw reported;
      }

      const started = now();
      let physicalResult: BulkExecutionResult | undefined;
      let driverError: unknown;
      let driverFailed = false;
      try {
        physicalResult = await physicalContext.run(
          { rootState: options.rootState, direct: use.direct, stream: false },
          () => use.executor.bulk!(bulk!, binding!, executionOptions),
        );
      } catch (error) {
        driverFailed = true;
        driverError = error;
        if (resourceCleanupFailure(error)) poison(use.physicalState, error);
      }
      let releaseError: unknown;
      let releaseFailed = false;
      try {
        await use.release(isPoisoned(use.physicalState));
      } catch (error) {
        releaseError = error;
        releaseFailed = true;
        poison(use.physicalState, error);
      }
      let reportedFailure: unknown;
      let hasReportedFailure = false;
      if (driverFailed) {
        hasReportedFailure = true;
        try {
          await notifyError(
            options.observers ?? [],
            errorEvent({ meta: bulkMeta }, driverError, "driver", true, false, now() - started),
            driverError,
          );
        } catch (error) {
          reportedFailure = error;
        }
      }
      if (releaseFailed) {
        hasReportedFailure = true;
        try {
          await notifyError(
            options.observers ?? [],
            errorEvent({ meta: bulkMeta }, releaseError, "release", true, !driverFailed, now() - started),
            releaseError,
          );
        } catch (error) {
          reportedFailure =
            reportedFailure === undefined
              ? error
              : new AggregateError([reportedFailure, error], "Bulk execution and lease release failed.", {
                  cause: reportedFailure,
                });
        }
      }
      if (hasReportedFailure) {
        throw reportedFailure;
      }
      let result: BulkExecutionResult;
      try {
        result = assertBulkExecutionResult(physicalResult, inputs.length);
      } catch (error) {
        await notifyError(
          options.observers ?? [],
          errorEvent({ meta: bulkMeta }, error, "result-kind", true, true, now() - started),
          error,
        );
      }
      try {
        await notify(options.observers ?? [], {
          type: "bulk:result",
          operationId,
          itemCount: result!.inputCount,
          affectedRows: result!.affectedRows,
          executionMode: result!.executionMode,
          durationMs: now() - started,
          transactionDepth: bulkMeta.transactionDepth,
          transactionScoped: bulkMeta.transactionScoped,
        });
      } catch (error) {
        await notifyError(
          options.observers ?? [],
          errorEvent({ meta: bulkMeta }, error, "observer-after", true, true, now() - started),
          error,
        );
      }
      return Object.freeze({
        inputCount: result!.inputCount,
        ...(result!.affectedRows === undefined ? {} : { affectedRows: result!.affectedRows }),
      });
    },
    async batch<const Queries extends readonly ExecutableQuery[]>(
      queries: Queries,
      executionOptions?: ExecutionOptions,
    ): Promise<{ readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> }> {
      assertOpen();
      for (const query of queries) assertExecutableQuery(query);
      assertExecutionOptions(executor, executionOptions, options.capabilities);
      if (queries.length === 0) return [] as { readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> };
      const batchId = `braid_batch_${nextOperationId()}`;
      type BatchEntry = {
        readonly operation: PreparedOperation<ExecutableQuery>;
        raw?: RawOperation<ExecutableQuery>;
        terminal: boolean;
      };
      const entries: BatchEntry[] = [];
      const observerFailures = async (
        entry: BatchEntry,
        error: unknown,
        stage: QueryErrorEventStage,
        executionStarted: boolean,
        executionCompleted: boolean,
        durationMs?: number,
      ): Promise<unknown[]> => {
        if (entry.terminal) return [];
        entry.terminal = true;
        return notifyTerminalObservers(
          options.observers ?? [],
          errorEvent(entry.operation, error, stage, executionStarted, executionCompleted, durationMs),
        );
      };
      const abortEntries = async (
        original: unknown,
        stage: QueryErrorEventStage,
        skip?: BatchEntry,
      ): Promise<readonly unknown[]> => {
        const failures: unknown[] = [];
        for (const entry of entries) {
          if (entry === skip || entry.terminal) continue;
          const error = new BatchAbortedError(batchId, original);
          const started = entry.raw !== undefined;
          const completed = started && !entry.raw!.driverFailed;
          failures.push(...(await observerFailures(entry, error, stage, started, completed, entry.raw?.durationMs)));
        }
        return failures;
      };

      for (const query of queries) {
        try {
          entries.push({ operation: await prepareObserved(query, undefined, batchId), terminal: false });
        } catch (error) {
          const failures = await abortEntries(error, "prepared");
          throw batchFailure(error, failures);
        }
      }
      let use: Use;
      try {
        use = await leaseForUse(false, statementBinding, executionOptions);
      } catch (error) {
        const first = entries[0];
        const stage = isBindingIdentityMismatch(error) ? "materialize" : "acquire";
        const failures = first === undefined ? [] : await observerFailures(first, error, stage, false, false);
        failures.push(...(await abortEntries(error, stage, first)));
        throw batchFailure(error, failures);
      }
      let driverFailure: { readonly entry: BatchEntry; readonly error: unknown } | undefined;
      let batchReleaseError: unknown;
      let batchReleaseFailed = false;
      try {
        for (const entry of entries) {
          const result = await physical(entry.operation, use, executionOptions);
          entry.raw = result;
          if (result.driverFailed) {
            driverFailure = { entry, error: result.driverError };
            break;
          }
        }
      } finally {
        try {
          await use.release(isPoisoned(use.physicalState));
        } catch (error) {
          batchReleaseError = error;
          batchReleaseFailed = true;
          poison(use.physicalState, error);
        }
      }

      const firstFailure = driverFailure;
      if (firstFailure !== undefined || batchReleaseFailed) {
        const target =
          // oxlint-disable-next-line unicorn/no-array-reverse -- Reverse only this owned copy; Node 16 lacks toReversed.
          firstFailure?.entry ?? [...entries].reverse().find((entry) => entry.raw !== undefined) ?? entries[0];
        if (target === undefined) {
          throw batchFailure(firstFailure?.error ?? batchReleaseError, []);
        }
        const raw = target.raw;
        const original =
          firstFailure === undefined
            ? batchReleaseError
            : batchReleaseFailed
              ? new AggregateError(
                  [firstFailure.error, batchReleaseError],
                  "Batch execution and lease release failed.",
                  { cause: firstFailure.error },
                )
              : firstFailure.error;
        const stage: QueryErrorEventStage =
          firstFailure === undefined ? "release" : batchReleaseFailed ? "release" : "driver";
        const failures = await observerFailures(
          target,
          original,
          stage,
          raw !== undefined,
          raw !== undefined && !raw.driverFailed,
          raw?.durationMs,
        );
        failures.push(...(await abortEntries(original, stage, target)));
        throw batchFailure(original, failures);
      }

      const output: QueryExecutionResult<unknown>[] = [];
      for (const entry of entries) {
        const raw = entry.raw;
        if (raw === undefined) {
          const original = new BatchAbortedError(
            batchId,
            new Error("Batch operation did not reach physical execution."),
          );
          const failures = await observerFailures(entry, original, "driver", false, false);
          failures.push(...(await abortEntries(original, "driver", entry)));
          throw batchFailure(original, failures);
        }
        let result: QueryExecutionResult<unknown>;
        try {
          result = await finalizePhysical(raw);
        } catch (error) {
          entry.terminal = true;
          const failures = await abortEntries(error, "result-kind", entry);
          throw batchFailure(error, failures);
        }
        try {
          output.push(await processRows(raw, result));
          entry.terminal = true;
        } catch (error) {
          entry.terminal = true;
          const failures = await abortEntries(error, "query-map", entry);
          throw batchFailure(error, failures);
        }
      }
      return output as { readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> };
    },
    prepare<Factory extends (...args: never[]) => PreparableQuery>(
      name: string,
      factory: Factory,
      prepareOptions?: PreparedFactoryOptions,
    ): PreparedQuery<Parameters<Factory> extends [] ? never : Parameters<Factory>[0], ReturnType<Factory>> {
      assertOpen();
      if (!name.trim()) throw codedError("BRAID_PREPARED_NAME", "prepared query name must not be empty.");
      if (options.preparedNames.has(name))
        throw codedError("BRAID_PREPARED_NAME", `duplicate prepared query name ${name}.`);
      const shape: { value?: string } = {};
      if (prepareOptions !== undefined && prepareOptions.input !== "none" && prepareOptions.input !== "required") {
        throw new TypeError('Prepared input mode must be either "none" or "required".');
      }
      options.preparedNames.add(name);
      const takesInput = prepareOptions?.input !== "none";
      const invocation = (
        args: readonly unknown[],
      ): {
        readonly options?: ExecutionOptions;
      } => ({
        options: (takesInput ? args[1] : args[0]) as ExecutionOptions | undefined,
      });
      const operation = async (args: readonly unknown[]): Promise<PreparedOperation<PreparableQuery>> => {
        assertOpen();
        const invoke = takesInput ? () => factory(args[0] as never) : () => factory();
        return prepareNamedFactoryObserved(invoke, name, shape);
      };
      const prepared: Record<string, unknown> = {
        name,
        execute: async (...args: unknown[]) => {
          const current = invocation(args);
          const preparedOperation = executablePreparedOperation(await operation(args));
          return await materializedPreparedResult(preparedOperation, undefined, current.options);
        },
        all: async (...args: unknown[]) => {
          const current = invocation(args);
          const preparedOperation = rowPreparedOperation(await operation(args));
          const result = await materializedPreparedResult(
            preparedOperation,
            (current.options as RowValidationOptions<unknown> | undefined)?.schema,
            current.options,
          );
          if (result.kind !== "rows") malformedExecutionResult();
          return result.rows;
        },
        one: async (...args: unknown[]) => {
          const current = invocation(args);
          const preparedOperation = rowPreparedOperation(await operation(args));
          const raw = await runPrepared(preparedOperation, current.options);
          const result = await finalizePhysical(raw);
          if (result.kind !== "rows") malformedExecutionResult();
          if (result.rows.length !== 1) {
            const error = new DatabaseCardinalityError("one", result.rows.length);
            await notifyError(
              options.observers ?? [],
              errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs),
              error,
            );
          }
          return await processOne(raw, result, (current.options as RowValidationOptions<unknown> | undefined)?.schema);
        },
        maybeOne: async (...args: unknown[]) => {
          const current = invocation(args);
          const preparedOperation = rowPreparedOperation(await operation(args));
          const raw = await runPrepared(preparedOperation, current.options);
          const result = await finalizePhysical(raw);
          if (result.kind !== "rows") malformedExecutionResult();
          if (result.rows.length > 1) {
            const error = new DatabaseCardinalityError("maybeOne", result.rows.length);
            await notifyError(
              options.observers ?? [],
              errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs),
              error,
            );
          }
          if (result.rows.length === 0) {
            try {
              await notify(
                options.observers ?? [],
                queryMappedEvent(
                  raw as RawOperation<ExecutableQuery>,
                  0,
                  raw.query.resultSchema !== undefined,
                  (current.options as RowValidationOptions<unknown> | undefined)?.schema !== undefined,
                  0,
                ),
              );
            } catch (error) {
              await notifyError(
                options.observers ?? [],
                errorEvent(raw as RawOperation<ExecutableQuery>, error, "observer-after", true, true, raw.durationMs),
                error,
              );
            }
            return undefined;
          }
          return await processOne(raw, result, (current.options as RowValidationOptions<unknown> | undefined)?.schema);
        },
        stream: (...args: unknown[]) => {
          const current = invocation(args);
          return (async function* (): AsyncGenerator<unknown> {
            const operationResult = await operation(args);
            let preparedOperation: PreparedOperation<RowQuery<unknown>>;
            try {
              preparedOperation = rowPreparedOperation(operationResult);
            } catch (error) {
              await notifyError(
                options.observers ?? [],
                errorEvent(operationResult, error, "prepared", false, false),
                error,
              );
            }
            let preparedStream: AsyncIterable<unknown>;
            try {
              preparedStream = database.stream(
                preparedOperation!.query,
                current.options as StreamOptions<unknown> | undefined,
                preparedOperation!,
              );
            } catch (error) {
              await notifyError(
                options.observers ?? [],
                errorEvent(operationResult, error, "stream", false, false),
                error,
              );
            }
            yield* preparedStream!;
          })();
        },
        call: async (...args: unknown[]) => {
          const current = invocation(args);
          const preparedOperation = callPreparedOperation(await operation(args));
          return database.call(preparedOperation.query, current.options, preparedOperation);
        },
      };
      return prepared as PreparedQuery<
        Parameters<Factory> extends [] ? never : Parameters<Factory>[0],
        ReturnType<Factory>
      >;
    },
    // The generator owns the lease until iterator.return()/completion; materialized streams must not release early.
    stream<Row>(
      query: RowQuery<Row>,
      streamOptions: StreamOptions<Row> = {},
      preparedOperation?: PreparedOperation<RowQuery<Row>>,
    ): AsyncIterable<Row> {
      assertOpen();
      assertHealthy(state);
      assertRowsQuery(query);
      const operationId = preparedOperation?.meta.operationId ?? nextOperationId();
      let stream!: AsyncGenerator<Row>;
      stream = (async function* (): AsyncGenerator<Row> {
        assertOpen();
        openStreams.add(stream);
        let operation: PreparedOperation<ExecutableQuery>;
        try {
          operation =
            preparedOperation === undefined
              ? (prepare(query, undefined, undefined, undefined, operationId) as PreparedOperation<ExecutableQuery>)
              : (preparedOperation as PreparedOperation<ExecutableQuery>);
        } catch (error) {
          openStreams.delete(stream);
          const failure = error instanceof PreparationFailure ? error : undefined;
          const reported = failure === undefined ? error : failure.cause;
          const fallback = {
            query,
            rendered: { segments: [""], parameters: [], resultKind: query.resultKind, dialectId: "" },
            binding: undefined,
            meta: metadata(options, operationId),
          } as unknown as PreparedOperation<ExecutableQuery>;
          await notifyError(
            options.observers ?? [],
            errorEvent(fallback, reported, failure?.stage ?? "render", false, false),
            reported,
          );
          throw reported;
        }
        try {
          assertExecutionOptions(executor, streamOptions, options.capabilities);
        } catch (error) {
          openStreams.delete(stream);
          await notifyError(options.observers ?? [], errorEvent(operation, error, "stream", false, false), error);
        }
        try {
          assertFeatureCapability(
            executor,
            "statement.stream",
            "BRAID_STREAM_UNSUPPORTED",
            "The selected execution resource does not expose a streaming protocol.",
            options.capabilities,
          );
        } catch (error) {
          openStreams.delete(stream);
          await notifyError(options.observers ?? [], errorEvent(operation, error, "materialize", false, false), error);
        }
        const admissionState =
          options.pinned?.physicalState ?? (options.transaction || !options.pooled ? state : undefined);
        if (admissionState) admissionState.pendingStreams = (admissionState.pendingStreams ?? 0) + 1;
        let use: Use;
        try {
          try {
            await notify(options.observers ?? [], streamStartEvent(operation));
          } catch (error) {
            openStreams.delete(stream);
            await notifyError(
              options.observers ?? [],
              errorEvent(operation, error, "observer-before", false, false),
              error,
            );
          }
          try {
            use = await leaseForUse(true, statementBinding, streamOptions);
          } catch (error) {
            openStreams.delete(stream);
            const stage = isBindingIdentityMismatch(error) ? "materialize" : "acquire";
            await notifyError(options.observers ?? [], errorEvent(operation, error, stage, false, false), error);
          }
          use!.physicalState.streamUsers += 1;
        } finally {
          if (admissionState) admissionState.pendingStreams! -= 1;
        }
        const started = now();
        let count = 0;
        let streamError: unknown;
        let streamFailed = false;
        let errorAlreadyReported = false;
        let iterator: AsyncIterator<unknown> | undefined;
        const activeContext: PhysicalContext = { rootState: options.rootState, direct: use!.direct, stream: true };
        try {
          if (!use!.executor.stream) {
            throw new UnsupportedFeatureError(
              "statement.stream",
              "BRAID_STREAM_UNSUPPORTED",
              "The selected execution resource does not expose a streaming protocol.",
            );
          }
          const source = physicalContext.run(activeContext, () =>
            use!.executor.stream!(operation.rendered, operation.binding, streamOptions),
          );
          iterator = source[Symbol.asyncIterator]();
          let queryStandard: StandardSchemaV1.Props<unknown, unknown> | undefined;
          let executionStandard: StandardSchemaV1.Props<unknown, unknown> | undefined;
          try {
            queryStandard = standardSchemaFor(query.resultSchema) as
              | StandardSchemaV1.Props<unknown, unknown>
              | undefined;
          } catch (error) {
            errorAlreadyReported = true;
            await notifyError(
              options.observers ?? [],
              errorEvent(operation, error, "query-map", true, true, now() - started),
              error,
            );
          }
          try {
            executionStandard = standardSchemaFor(streamOptions.schema) as
              | StandardSchemaV1.Props<unknown, unknown>
              | undefined;
          } catch (error) {
            errorAlreadyReported = true;
            await notifyError(
              options.observers ?? [],
              errorEvent(operation, error, "execution-map", true, true, now() - started),
              error,
            );
          }
          while (true) {
            const next = await physicalContext.run(activeContext, () => iterator!.next());
            if (next.done) {
              if (streamOptions.signal?.aborted) throw streamOptions.signal.reason;
              break;
            }
            const row = next.value;
            if (streamOptions.signal?.aborted) throw streamOptions.signal.reason;
            let mapped: unknown = row;
            if (queryStandard !== undefined) {
              try {
                mapped = await physicalContext.run(activeContext, () =>
                  validateRow(queryStandard!, row, count, "query"),
                );
              } catch (error) {
                errorAlreadyReported = true;
                await notifyError(
                  options.observers ?? [],
                  errorEvent(operation, error, "query-map", true, true, now() - started),
                  error,
                );
              }
            }
            if (executionStandard !== undefined) {
              try {
                mapped = await physicalContext.run(activeContext, () =>
                  validateRow(executionStandard!, mapped, count, "execution"),
                );
              } catch (error) {
                errorAlreadyReported = true;
                await notifyError(
                  options.observers ?? [],
                  errorEvent(operation, error, "execution-map", true, true, now() - started),
                  error,
                );
              }
            }
            if (streamOptions.signal?.aborted) throw streamOptions.signal.reason;
            count = addSafeCount(count, 1);
            yield mapped as Row;
          }
        } catch (error) {
          streamError = error;
          streamFailed = true;
          if (resourceCleanupFailure(error)) poison(use!.physicalState, error);
          // A failed iterator or release poisons the physical resource and forces discard on release.
          if (!errorAlreadyReported) {
            try {
              await notifyError(
                options.observers ?? [],
                errorEvent(operation, error, "stream", true, false, now() - started),
                error,
              );
            } catch (reported) {
              streamError = reported;
            }
          }
        } finally {
          // Iterator cleanup runs before lease release so driver cursors/portals still have their owning connection.
          if (iterator?.return) {
            try {
              await physicalContext.run(activeContext, () => iterator!.return!());
            } catch (error) {
              streamError = streamFailed
                ? new AggregateError([streamError, error], "Stream iterator cleanup failed.", { cause: streamError })
                : error;
              streamFailed = true;
              poison(use!.physicalState, streamError);
            }
          }
          let releaseError: unknown;
          let releaseFailed = false;
          try {
            await use!.release(isPoisoned(use!.physicalState));
          } catch (error) {
            releaseError = error;
            releaseFailed = true;
            poison(use!.physicalState, error);
          }
          // A failed iterator or release poisons the physical resource and forces discard on release.
          if (releaseFailed) {
            try {
              await notifyError(
                options.observers ?? [],
                errorEvent(operation, releaseError, "release", true, streamError === undefined, now() - started),
                releaseError,
              );
            } catch (reported) {
              releaseError = reported;
            }
          }
          if (releaseFailed) {
            streamError = streamFailed
              ? new AggregateError([streamError, releaseError], "Stream and lease release failed.", {
                  cause: streamError,
                })
              : releaseError;
            streamFailed = true;
          }
          use!.physicalState.streamUsers -= 1;
          openStreams.delete(stream);
          const endEvent: ExecutionEvent = {
            type: "stream:end",
            operationId: operation.meta.operationId,
            status: streamFailed ? "error" : "completed",
            durationMs: now() - started,
            rowCount: count,
            error: streamError,
            transactionDepth: options.depth,
            transactionScoped: options.transaction,
          };
          // Terminal delivery must close every observer's state, even when an earlier observer fails.
          const observerFailures = await notifyTerminalObservers(options.observers ?? [], endEvent);
          if (observerFailures.length > 0) {
            streamError = streamFailed
              ? new AggregateError([streamError, ...observerFailures], "Stream and observers failed.", {
                  cause: streamError,
                })
              : observerFailures.length === 1
                ? observerFailures[0]
                : new AggregateError(observerFailures, "Stream end observers failed.", { cause: observerFailures[0] });
            streamFailed = true;
          }
          if (streamFailed) throw streamError;
        }
      })();
      return stream;
    },
    async session<T>(callback: (database: Database) => Promise<T>): Promise<T> {
      assertOpen();
      assertHealthy(state);
      if (typeof callback !== "function") throw new TypeError("Session callback is required.");
      const nested = options.scopeKind !== "root";
      const scope = Symbol("session scope");
      const previousRootSession = options.scopeKind === "root" ? options.rootState.activeSession : undefined;
      const reservedRootSession = !nested && sessionContext.conservative ? scope : undefined;
      if (reservedRootSession !== undefined) {
        assertRootAllowed(options.rootState, false);
        options.rootState.activeSession = reservedRootSession;
      }
      let use: Use | undefined;
      try {
        use = nested ? pinnedResource() : await acquireSessionResource(reservedRootSession);
      } catch (error) {
        if (reservedRootSession !== undefined && options.rootState.activeSession === reservedRootSession) {
          options.rootState.activeSession = previousRootSession;
        }
        throw error;
      }
      if (!use) throw new DatabaseScopeError("BRAID_SESSION_CLOSED", "Session database is no longer usable.");
      const physicalState = use.physicalState;
      const previousSession = physicalState.activeSession;
      physicalState.activeSession = scope;
      if (!nested) options.rootState.activeSession = scope;
      const activity = { active: true };
      const parent = sessionContext.getStore();
      const scoped = createScopedDatabase(use.executor, physicalState, {
        ...options,
        transaction: options.transaction,
        scopeKind: "session",
        preparedNames: new Set<string>(),
        pooled: false,
        lease: use.executor as ConnectionLease,
        leaseState: physicalState,
        pinned: use,
        scope,
        transactionScope: options.transaction ? state.activeScope : undefined,
      });
      let result!: T;
      let failure: unknown;
      let failed = false;
      try {
        await sessionContext.run({ rootState: options.rootState, activity, parent }, async () => {
          try {
            result = await callback(scoped);
            await scoped.finish();
          } catch (error) {
            failed = true;
            failure = error;
            try {
              await scoped.finish();
            } catch (closing) {
              if (closing !== error) {
                failure = new AggregateError([error, closing], "Session failed and stream cleanup also failed.", {
                  cause: error,
                });
              }
            }
          }
        });
      } finally {
        scoped.close();
        activity.active = false;
        physicalState.activeSession = previousSession;
        if (!nested) options.rootState.activeSession = previousRootSession;
        if (!nested && use.ownsLease) {
          try {
            await use.release(isPoisoned(physicalState));
          } catch (error) {
            poison(physicalState, error);
            failed = true;
            failure =
              failure === undefined
                ? error
                : new AggregateError([failure, error], "Session failed and lease release also failed.", {
                    cause: failure,
                  });
          }
        }
      }
      if (failed) throw failure;
      return result;
    },
    async tx<T>(
      callbackOrOptions: ((database: Database) => Promise<T>) | TransactionOptions,
      maybeCallback?: (database: Database) => Promise<T>,
    ): Promise<T> {
      assertOpen();
      assertHealthy(state);
      const hasOptions = typeof callbackOrOptions !== "function";
      const transactionOptions = hasOptions ? callbackOrOptions : undefined;
      const callback = (hasOptions ? maybeCallback : callbackOrOptions) as
        | ((database: Database) => Promise<T>)
        | undefined;
      if (callback === undefined) throw new TypeError("Transaction callback is required.");
      const nested = options.transaction;
      if (nested && hasOptions) {
        throw new DatabaseScopeError(
          "BRAID_TX_OPTIONS_NESTED",
          "Transaction options are not valid for nested savepoint transactions.",
        );
      }
      if (hasOptions) {
        assertTransactionOptions(transactionOptions);
        validateTransactionOptionSupport(executor, transactionOptions, options.capabilities);
      }
      const pinnedStreamState = options.pinned?.physicalState ?? (nested ? state : undefined);
      if (pinnedStreamState && (pinnedStreamState.streamUsers > 0 || (pinnedStreamState.pendingStreams ?? 0) > 0)) {
        throw new DatabaseScopeError(
          "BRAID_STREAM_SCOPE",
          "Close the pinned stream before opening a transaction or savepoint.",
        );
      }
      assertFeatureCapability(
        executor,
        nested ? "transaction.savepoint" : "transaction",
        "BRAID_TX_UNSUPPORTED",
        nested
          ? "The selected execution resource does not expose savepoints."
          : "The selected execution resource does not expose callback transactions.",
        options.capabilities,
      );
      const transactionId = options.transactionId ?? nextTransactionId();
      const depth = options.depth + 1;
      const savepointName = nested ? `braid_sp_${nextTransactionId()}` : undefined;
      const scope = Symbol("transaction scope");
      const previousScope = state.activeScope;
      const previousRootScope = options.scopeKind === "root" ? options.rootState.activeScope : undefined;
      const reservedRootTransaction =
        !nested && options.scopeKind === "root" && transactionContext.conservative ? scope : undefined;
      if (reservedRootTransaction !== undefined) {
        assertRootAllowed(options.rootState, false);
        options.rootState.activeScope = reservedRootTransaction;
      }
      // Reserve the nested scope synchronously so sibling/parent work cannot enter it.
      if (nested) state.activeScope = scope;
      let use: Use | undefined;
      let scoped: ReturnType<typeof createScopedDatabase> | undefined;
      let physicalState = state;
      let started = false;
      let completed = false;
      let failed = false;
      let failure: unknown;
      let result!: T;
      const activity = { active: true };
      const parent = transactionContext.getStore();
      const observers = options.observers ?? [];
      try {
        if (nested) {
          const lease = options.lease!;
          if (!lease.savepoint || !lease.rollbackTo || !lease.releaseSavepoint) {
            throw new UnsupportedFeatureError(
              "transaction.savepoint",
              "BRAID_TX_UNSUPPORTED",
              "The selected execution resource does not expose savepoints.",
            );
          }
          use = { executor: lease, physicalState: state, direct: true, ownsLease: false, release: async () => {} };
        } else {
          await transactionEvent(observers, transactionId, "begin", "requested", depth);
          try {
            if (options.pinned) {
              use = {
                ...options.pinned,
                ownsLease: false,
                release: async () => {},
              };
            } else {
              use = await leaseForUse(false, statementBinding, undefined, reservedRootTransaction);
              if (!options.pooled) use = { ...use, ownsLease: true };
            }
          } catch (error) {
            try {
              await transactionEvent(observers, transactionId, "begin", "failed", depth, undefined, undefined, error);
            } catch (reporting) {
              throw transactionFailure(error, [reporting]);
            }
            throw error;
          }
          physicalState = use.physicalState;
          physicalState.activeScope = scope;
          if (options.scopeKind === "root") options.rootState.activeScope = scope;
        }
        const resource = use.executor;
        assertFeatureCapability(
          resource,
          nested ? "transaction.savepoint" : "transaction",
          "BRAID_TX_UNSUPPORTED",
          nested
            ? "The selected execution resource does not expose savepoints."
            : "The selected execution resource does not expose callback transactions.",
          options.capabilities,
        );
        if (hasOptions) validateTransactionOptionSupport(resource, transactionOptions!, options.capabilities, executor);
        if (!nested && (!resource.begin || !resource.commit || !resource.rollback)) {
          throw new UnsupportedFeatureError(
            "transaction",
            "BRAID_TX_UNSUPPORTED",
            "The selected execution resource does not expose callback transactions.",
          );
        }
        scoped = createScopedDatabase(resource, physicalState, {
          ...options,
          transaction: true,
          scopeKind: "transaction",
          preparedNames: new Set<string>(),
          lease: resource as ConnectionLease,
          leaseState: physicalState,
          pinned: use,
          transactionId,
          depth,
          scope,
        });
        await transactionContext.run({ rootState: options.rootState, activity, parent }, async () => {
          // Serialize control statements with ordinary work on the pinned resource.
          const control = async (
            phase: Extract<ExecutionEvent, { type: "transaction" }>["phase"],
            action: () => Awaitable<void>,
            cleanup = false,
            requested = true,
          ): Promise<void> => {
            const errors: unknown[] = [];
            const start = now();
            if (requested) {
              try {
                await transactionEvent(observers, transactionId, phase, "requested", depth, undefined, savepointName);
              } catch (error) {
                if (!cleanup) throw error;
                errors.push(error);
              }
            }
            if (
              !cleanup &&
              (phase === "begin" || phase === "savepoint") &&
              (physicalState.streamUsers > 0 || (physicalState.pendingStreams ?? 0) > 0)
            ) {
              throw new DatabaseScopeError(
                "BRAID_STREAM_SCOPE",
                "Close the pinned stream before opening a transaction or savepoint.",
              );
            }
            const release = await acquireTransactionTurn(physicalState);
            let driverFailed = false;
            try {
              await physicalContext.run({ rootState: options.rootState, direct: true, stream: false }, action);
            } catch (error) {
              driverFailed = true;
              errors.push(error);
              poison(physicalState, error);
            } finally {
              release();
            }
            try {
              await transactionEvent(
                observers,
                transactionId,
                phase,
                driverFailed ? "failed" : "completed",
                depth,
                start,
                savepointName,
                driverFailed ? errors.at(-1) : undefined,
              );
            } catch (error) {
              errors.push(error);
            }
            if (errors.length > 0) throw transactionFailure(errors[0], errors.slice(1));
          };
          try {
            await control(
              nested ? "savepoint" : "begin",
              async () => {
                if (nested) await resource.savepoint!(savepointName!);
                else if (transactionOptions === undefined) await resource.begin!();
                else await resource.begin!(transactionOptions);
                started = true;
              },
              false,
              nested,
            );
            result = await callback(scoped!);
            await scoped!.finish();
            assertHealthy(physicalState);
            await control(nested ? "release-savepoint" : "commit", async () => {
              if (nested) await resource.releaseSavepoint!(savepointName!);
              else await resource.commit!();
              completed = true;
            });
          } catch (error) {
            const cleanup: unknown[] = [];
            try {
              await scoped!.finish();
            } catch (closing) {
              if (closing !== error) cleanup.push(closing);
            }
            // Roll back before releasing a nested savepoint; release is skipped after poisoning because the resource is unsafe.
            if (started && !completed && !isPoisoned(physicalState)) {
              try {
                await control(
                  nested ? "rollback-to-savepoint" : "rollback",
                  () => (nested ? resource.rollbackTo!(savepointName!) : resource.rollback!()),
                  true,
                );
              } catch (rollback) {
                cleanup.push(rollback);
              }
              if (nested && !isPoisoned(physicalState)) {
                try {
                  await control("release-savepoint", () => resource.releaseSavepoint!(savepointName!), true);
                } catch (release) {
                  cleanup.push(release);
                }
              }
            }
            const combined = transactionFailure(error, cleanup);
            if (isPoisoned(physicalState)) physicalState.poisoned = combined;
            throw combined;
          }
        });
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        scoped?.close();
        activity.active = false;
        physicalState.activeScope = nested ? previousScope : undefined;
        if (!nested && options.scopeKind === "root") options.rootState.activeScope = previousRootScope;
        if (use && !nested && use.ownsLease) {
          try {
            await use.release(isPoisoned(physicalState));
          } catch (error) {
            poison(physicalState, error);
            failure = failed ? transactionFailure(failure, [error]) : error;
            failed = true;
          }
        }
      }
      if (failed) throw failure;
      return result;
    },
    async finish(): Promise<void> {
      const active = [...openStreams];
      closed = true;
      const failures: unknown[] = [];
      for (const stream of active) {
        try {
          await stream.return(undefined);
        } catch (error) {
          failures.push(error);
        } finally {
          openStreams.delete(stream);
        }
      }
      await state.transactionTail;
      if (active.length > 0) {
        const scopeName = options.scopeKind === "session" ? "session" : "transaction";
        const error = new DatabaseScopeError(
          "BRAID_STREAM_SCOPE",
          `A ${scopeName} callback must close its streams before completion.`,
        );
        if (failures.length > 0)
          throw new AggregateError([error, ...failures], "Transaction streams failed to close.", { cause: error });
        throw error;
      }
    },
    close(): void {
      closed = true;
    },
  };
  return {
    ...database,
    stream<Row>(query: RowQuery<Row>, streamOptions?: StreamOptions<Row>): AsyncIterable<Row> {
      return database.stream(query, streamOptions);
    },
    call<Result extends RoutineCallResult>(
      query: CallQuery<Result>,
      executionOptions?: ExecutionOptions,
    ): Promise<Result> {
      return database.call(query, executionOptions);
    },
  };
}
