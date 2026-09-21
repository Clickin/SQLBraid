import type {
  BulkBindingDescription,
  ExecutionEvent,
  ExecutionObserver,
  Query,
  ExecutableQuery,
  QueryReadyEvent,
  QueryResultKind,
  QueryExecutionResult,
  RenderedBulk,
  StatementBindingDescription,
  StreamStartEvent,
} from "@sqlbraid/core";
import type { OperationMeta, PreparedOperation, RawOperation, RuntimeOptions } from "./state.js";
import { now } from "./state.js";

export function frozenEvent(event: ExecutionEvent): ExecutionEvent {
  if (event.type === "query:ready" || event.type === "stream:start") {
    const values = Object.freeze([...event.values]);
    const bindingMap =
      event.bindingMap === undefined
        ? undefined
        : Object.freeze(event.bindingMap.map((item) => Object.freeze({ ...item })));
    const parameterHints =
      event.parameterHints !== undefined
        ? Object.freeze(
            event.parameterHints.map((hint) => (hint === undefined ? undefined : Object.freeze({ ...hint }))),
          )
        : undefined;
    const execution = Object.freeze({
      ...event.execution,
      reuse: Object.freeze({ ...event.execution.reuse }),
    });
    const descriptors = Object.getOwnPropertyDescriptors(event);
    if (descriptors.values !== undefined) descriptors.values.value = values;
    if (bindingMap !== undefined && descriptors.bindingMap !== undefined) descriptors.bindingMap.value = bindingMap;
    if (parameterHints !== undefined && descriptors.parameterHints !== undefined)
      descriptors.parameterHints.value = parameterHints;
    if (descriptors.execution !== undefined) descriptors.execution.value = execution;
    return Object.freeze(Object.defineProperties({}, descriptors)) as ExecutionEvent;
  }
  return Object.freeze(event) as ExecutionEvent;
}

export async function notify(observers: readonly ExecutionObserver[], event: ExecutionEvent): Promise<void> {
  if (observers.length === 0) return;
  const immutable = frozenEvent(event);
  for (const observer of observers) {
    // oxlint-disable-next-line no-await-in-loop -- Observer order is part of lifecycle delivery.
    await observer.onEvent(immutable);
  }
}

export async function notifyTerminalObservers(
  observers: readonly ExecutionObserver[],
  event: ExecutionEvent,
): Promise<unknown[]> {
  if (observers.length === 0) return [];
  const failures: unknown[] = [];
  const immutable = frozenEvent(event);
  for (const observer of observers) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Terminal observers are delivered in registration order.
      await observer.onEvent(immutable);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export async function notifyError(
  observers: readonly ExecutionObserver[],
  event: ExecutionEvent,
  original: unknown,
): Promise<never> {
  const failures = await notifyTerminalObservers(observers, event);
  if (failures.length === 0) throw original;
  throw new AggregateError([original, ...failures], "Execution failed and error observers also failed.", {
    cause: original,
  });
}

export function batchFailure(original: unknown, failures: readonly unknown[]): unknown {
  return failures.length === 0
    ? original
    : new AggregateError([original, ...failures], "Batch execution failed and error observers also failed.", {
        cause: original,
      });
}

export function transactionFailure(original: unknown, errors: readonly unknown[]): unknown {
  return errors.length === 0
    ? original
    : new AggregateError([original, ...errors], "Transaction failed and cleanup also failed.", {
        cause: original,
      });
}

export function metadata(
  options: RuntimeOptions,
  operationId: string,
  preparedName?: string,
  batchId?: string,
): OperationMeta {
  return {
    operationId,
    preparedName,
    batchId,
    transactionDepth: options.depth,
    transactionScoped: options.transaction,
  };
}

export function executionProjection(binding: StatementBindingDescription): {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: StatementBindingDescription["transport"];
  readonly reuse: StatementBindingDescription["reuse"];
} {
  return {
    adapterId: binding.adapterId,
    dialectId: binding.dialectId,
    transport: binding.transport,
    reuse: {
      requested: binding.reuse.requested,
      effective: binding.reuse.effective,
      owner: binding.reuse.owner,
      ...(binding.reuse.capacity === undefined ? {} : { capacity: binding.reuse.capacity }),
    },
  };
}

export function eventSql(event: object, binding: StatementBindingDescription): void {
  Object.defineProperty(event, "sql", {
    configurable: false,
    enumerable: true,
    get: () => binding.parameterizedSql,
  });
}

export function queryReadyEvent(operation: PreparedOperation<Query<unknown, QueryResultKind>>): ExecutionEvent {
  const { query, rendered, binding, meta } = operation;
  const parameterHints = rendered.parameters.map((parameter) => parameter.hint);
  const event: QueryReadyEvent = {
    type: "query:ready",
    purpose: meta.purpose,
    literalizedSql: (options) => binding.literalizedSql(options),
    operationId: meta.operationId,
    batchId: meta.batchId,
    values: rendered.parameters.map((parameter) => parameter.value),
    bindingMap: rendered.parameters.map((parameter, index) => ({
      placeholder: index + 1,
      ...(parameter.interpolation === undefined ? {} : { interpolation: parameter.interpolation }),
      ...(parameter.direction === undefined ? {} : { direction: parameter.direction }),
      ...(parameter.outputName === undefined ? {} : { outputName: parameter.outputName }),
    })),
    ...(parameterHints.some((hint) => hint !== undefined) ? { parameterHints } : {}),
    execution: executionProjection(binding),
    declaredKind: query.resultKind,
    fingerprint: rendered.fingerprint,
    variantFingerprint: rendered.variantFingerprint,
    preparedName: meta.preparedName,
    transactionDepth: meta.transactionDepth,
    transactionScoped: meta.transactionScoped,
  };
  if ("parameterizedSql" in binding) eventSql(event, binding);
  return event;
}

export function bulkReadyEvent(
  operationId: string,
  bulk: RenderedBulk,
  binding: BulkBindingDescription,
  meta: OperationMeta,
): ExecutionEvent {
  const event: ExecutionEvent = {
    type: "bulk:ready",
    operationId,
    itemCount: bulk.parameterSets.length,
    valuesAt: (index) => binding.valuesAt(index),
    literalizedSql: (index, options) => binding.literalizedSql(index, options),
    transactionDepth: meta.transactionDepth,
    transactionScoped: meta.transactionScoped,
  };
  if ("parameterizedSql" in binding) {
    Object.defineProperty(event, "sql", {
      configurable: false,
      enumerable: true,
      get: () => binding.parameterizedSql,
    });
  }
  return event;
}

export function queryResultEvent(
  operation: RawOperation<ExecutableQuery>,
  result: QueryExecutionResult<unknown>,
): ExecutionEvent {
  return {
    type: "query:result",
    purpose: operation.meta.purpose,
    operationId: operation.meta.operationId,
    preparedName: operation.meta.preparedName,
    batchId: operation.meta.batchId,
    durationMs: operation.durationMs,
    actualKind: result.kind,
    rowCount: result.kind === "rows" ? result.rows.length : result.rowCount,
    command: result.kind === "command" ? Object.freeze({ ...result.command }) : undefined,
    transactionDepth: operation.meta.transactionDepth,
    transactionScoped: operation.meta.transactionScoped,
  };
}

export function queryMappedEvent(
  operation: RawOperation<ExecutableQuery>,
  rowCount: number,
  queryMapped: boolean,
  executionMapped: boolean,
  durationMs: number,
): ExecutionEvent {
  return {
    type: "query:mapped",
    purpose: operation.meta.purpose,
    operationId: operation.meta.operationId,
    preparedName: operation.meta.preparedName,
    batchId: operation.meta.batchId,
    durationMs,
    rowCount,
    queryMapped,
    executionMapped,
    transactionDepth: operation.meta.transactionDepth,
    transactionScoped: operation.meta.transactionScoped,
  };
}

export function errorEvent(
  operation: { readonly meta: OperationMeta },
  error: unknown,
  stage: QueryErrorEventStage,
  started: boolean,
  completed: boolean,
  durationMs?: number,
): ExecutionEvent {
  return {
    type: "query:error",
    purpose: operation.meta.purpose,
    operationId: operation.meta.operationId,
    preparedName: operation.meta.preparedName,
    batchId: operation.meta.batchId,
    error,
    stage,
    executionStarted: started,
    executionCompleted: completed,
    durationMs,
    transactionDepth: operation.meta.transactionDepth,
    transactionScoped: operation.meta.transactionScoped,
  };
}

export type QueryErrorEventStage = Extract<ExecutionEvent, { readonly type: "query:error" }>["stage"];

export function streamStartEvent(operation: PreparedOperation<ExecutableQuery>): ExecutionEvent {
  const { rendered, binding, meta } = operation;
  const parameterHints = rendered.parameters.map((parameter) => parameter.hint);
  const event: StreamStartEvent = {
    type: "stream:start",
    literalizedSql: (options) => binding.literalizedSql(options),
    operationId: meta.operationId,
    values: rendered.parameters.map((parameter) => parameter.value),
    bindingMap: rendered.parameters.map((parameter, index) => ({
      placeholder: index + 1,
      ...(parameter.interpolation === undefined ? {} : { interpolation: parameter.interpolation }),
      ...(parameter.direction === undefined ? {} : { direction: parameter.direction }),
      ...(parameter.outputName === undefined ? {} : { outputName: parameter.outputName }),
    })),
    ...(parameterHints.some((hint) => hint !== undefined) ? { parameterHints } : {}),
    execution: executionProjection(binding),
    declaredKind: "rows",
    variantFingerprint: rendered.variantFingerprint,
    preparedName: meta.preparedName,
    transactionDepth: meta.transactionDepth,
    transactionScoped: meta.transactionScoped,
  };
  if ("parameterizedSql" in binding) eventSql(event, binding);
  return event;
}

export async function transactionEvent(
  observers: readonly ExecutionObserver[],
  transactionId: string,
  phase: Extract<ExecutionEvent, { readonly type: "transaction" }>["phase"],
  status: Extract<ExecutionEvent, { readonly type: "transaction" }>["status"],
  depth: number,
  started?: number,
  savepointName?: string,
  error?: unknown,
): Promise<void> {
  await notify(observers, {
    type: "transaction",
    transactionId,
    phase,
    status,
    depth,
    savepointName,
    durationMs: started === undefined ? undefined : now() - started,
    error,
  });
}
