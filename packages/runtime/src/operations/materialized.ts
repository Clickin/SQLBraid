import type {
  ExecutableQuery,
  ExecutionOptions,
  ExecutionResultOf,
  Query,
  QueryExecutionResult,
  QueryResultKind,
  QueryRow,
  RowQuery,
  RowValidationOptions,
  StandardSchemaV1,
  StatementBindingAdapter,
} from "@sqlbraid/core";
import { DatabaseCardinalityError } from "../errors.js";
import {
  assertExecutionResult,
  assertExecutableQuery,
  malformedExecutionResult,
  resourceCleanupFailure,
  standardSchemaFor,
  validateRow,
} from "../validation.js";
import { isBindingIdentityMismatch } from "../binding.js";
import { errorEvent, notify, notifyError, queryMappedEvent, queryResultEvent } from "../observers.js";

import {
  isPoisoned,
  now,
  physicalContext,
  poison,
  type PreparedOperation,
  type RawOperation,
  type RuntimeOptions,
  type Use,
} from "../state.js";

export interface MaterializedRuntime {
  readonly options: RuntimeOptions;
  readonly statementBinding: StatementBindingAdapter;
  readonly leaseForUse: (
    stream: boolean,
    expectedBinding: StatementBindingAdapter,
    executionOptions?: ExecutionOptions,
    reservedRootScope?: symbol,
  ) => Promise<Use>;
  readonly prepareObserved: <Q extends Query<unknown, QueryResultKind>>(
    query: Q,
    preparedName?: string,
    batchId?: string,
  ) => Promise<PreparedOperation<Q>>;
}

export function createMaterializedOperations(runtime: MaterializedRuntime) {
  const { options, statementBinding, leaseForUse, prepareObserved } = runtime;
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
          // oxlint-disable-next-line no-await-in-loop -- Preserve row order during application mapping.
          mapped = await validateRow(queryStandard, mapped, rowIndex, "query");
        } catch (error) {
          // oxlint-disable-next-line no-await-in-loop -- Preserve ordered observer reporting for row mapping.
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
          // oxlint-disable-next-line no-await-in-loop -- Preserve row order during application mapping.
          mapped = await validateRow(executionStandard, mapped, rowIndex, "execution");
        } catch (error) {
          // oxlint-disable-next-line no-await-in-loop -- Preserve ordered observer reporting for row mapping.
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
  return {
    physical,
    finalizePhysical,
    processRows,
    processOne,
    runPrepared,
    runMaterialized,
    materializedPreparedResult,
    materializedResult,
    executeNamed,
    allNamed,
    oneNamed,
    maybeOneNamed,
  };
}
