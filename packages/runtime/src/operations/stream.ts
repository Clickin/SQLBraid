import { UnsupportedFeatureError } from "@sqlbraid/core";
import type {
  ConnectionProvider,
  ExecutionEvent,
  ExecutionOptions,
  ExecutableQuery,
  Query,
  QueryExecutor,
  QueryResultKind,
  RenderedStatement,
  RowQuery,
  StandardSchemaV1,
  StatementBindingAdapter,
  StreamOptions,
} from "@sqlbraid/core";
import { isBindingIdentityMismatch } from "../binding.js";
import {
  addSafeCount,
  standardSchemaFor,
  validateRow,
  resourceCleanupFailure,
  assertRowsQuery,
} from "../validation.js";
import { errorEvent, notify, notifyError, notifyTerminalObservers, streamStartEvent, metadata } from "../observers.js";
import {
  assertHealthy,
  isPoisoned,
  now,
  nextOperationId,
  physicalContext,
  poison,
  type PreparedOperation,
  type PhysicalContext,
  type RuntimeOptions,
  type ScopeState,
  type Use,
  PreparationFailure,
} from "../state.js";
import { assertExecutionOptions, assertFeatureCapability } from "../capabilities.js";

export interface StreamRuntime {
  readonly executor: QueryExecutor | ConnectionProvider;
  readonly state: ScopeState;
  readonly options: RuntimeOptions;
  readonly statementBinding: StatementBindingAdapter;
  readonly openStreams: Set<AsyncGenerator<unknown>>;
  readonly assertOpen: () => void;
  readonly prepare: <Q extends Query<unknown, QueryResultKind>>(
    query: Q,
    preparedName?: string,
    batchId?: string,
    alreadyRendered?: RenderedStatement,
    operationId?: string,
  ) => PreparedOperation<Q>;
  readonly leaseForUse: (
    stream: boolean,
    expectedBinding: StatementBindingAdapter,
    executionOptions?: ExecutionOptions,
    reservedRootScope?: symbol,
  ) => Promise<Use>;
}

export function streamOperation<Row>(
  query: RowQuery<Row>,
  streamOptions: StreamOptions<Row> = {},
  preparedOperation: PreparedOperation<RowQuery<Row>> | undefined,
  runtime: StreamRuntime,
): AsyncIterable<Row> {
  const { executor, state, options, statementBinding, openStreams, assertOpen, prepare, leaseForUse } = runtime;

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
        queryStandard = standardSchemaFor(query.resultSchema) as StandardSchemaV1.Props<unknown, unknown> | undefined;
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
        // oxlint-disable-next-line no-await-in-loop -- Driver iteration must remain sequential.
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
            // oxlint-disable-next-line no-await-in-loop -- Preserve row order while mapping.
            mapped = await physicalContext.run(activeContext, () => validateRow(queryStandard!, row, count, "query"));
          } catch (error) {
            errorAlreadyReported = true;
            // oxlint-disable-next-line no-await-in-loop -- Report each row mapping failure before advancing.
            await notifyError(
              options.observers ?? [],
              errorEvent(operation, error, "query-map", true, true, now() - started),
              error,
            );
          }
        }
        if (executionStandard !== undefined) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- Preserve row order while mapping.
            mapped = await physicalContext.run(activeContext, () =>
              validateRow(executionStandard!, mapped, count, "execution"),
            );
          } catch (error) {
            errorAlreadyReported = true;
            // oxlint-disable-next-line no-await-in-loop -- Report each row mapping failure before advancing.
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
      // oxlint-disable-next-line no-unsafe-finally -- Terminal stream failure must escape after cleanup.
      if (streamFailed) throw streamError;
    }
  })();
  return stream;
}
