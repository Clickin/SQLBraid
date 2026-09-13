import { AsyncLocalStorage } from "node:async_hooks";
import { createRenderedStatement } from "@sqlbraid/core";
import type {
  CallQuery,
  ConnectionLease,
  ConnectionProvider,
  Database,
  DatabaseOptions,
  ExecutableQuery,
  ExecutionEvent,
  ExecutionObserver,
  ExecutionResultOf,
  PreparedQuery,
  Query,
  QueryExecutionResult,
  QueryExecutor,
  QueryResultKind,
  QueryReadyEvent,
  QueryRow,
  StatementBindingAdapter,
  StatementBindingDescription,
  RenderedStatement,
  RoutineCallResult,
  RowQuery,
  RowValidationOptions,
  RowsExecutionResult,
  StandardSchemaV1,
  StreamOptions,
  StreamStartEvent,
} from "@sqlbraid/core";

export class DatabaseCardinalityError extends Error {
  readonly expected: "one" | "maybeOne";
  readonly actual: number;

  constructor(expected: "one" | "maybeOne", actual: number) {
    super(`Expected ${expected === "one" ? "exactly one" : "at most one"} row, received ${actual}.`);
    this.name = "DatabaseCardinalityError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class DatabaseScopeError extends Error {
  readonly code: "BRAID_TX_SCOPE" | "BRAID_TX_CLOSED" | "BRAID_CONNECTION_POISONED" | "BRAID_STREAM_SCOPE" | "BRAID_REENTRY";
  declare readonly cause?: unknown;

  constructor(
    code: "BRAID_TX_SCOPE" | "BRAID_TX_CLOSED" | "BRAID_CONNECTION_POISONED" | "BRAID_STREAM_SCOPE" | "BRAID_REENTRY",
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseScopeError";
    this.code = code;
  }
}

export class DatabaseResultKindError extends Error {
  readonly code = "BRAID_RESULT_KIND";
  readonly declaredKind: QueryResultKind;
  readonly actualKind: "rows" | "command";

  constructor(declaredKind: QueryResultKind, actualKind: "rows" | "command") {
    super(`Declared query result kind "${declaredKind}" did not match actual result kind "${actualKind}".`);
    this.name = "DatabaseResultKindError";
    this.declaredKind = declaredKind;
    this.actualKind = actualKind;
  }
}

export class DatabaseResultValidationError extends Error {
  readonly code = "BRAID_RESULT_VALIDATION";
  readonly issues: readonly StandardSchemaV1.Issue[];
  readonly rowIndex?: number;
  readonly stage: "query" | "execution";

  constructor(issues: readonly StandardSchemaV1.Issue[], rowIndex?: number, stage: "query" | "execution" = "execution") {
    super("Database result validation failed.");
    this.name = "DatabaseResultValidationError";
    this.issues = issues;
    this.rowIndex = rowIndex;
    this.stage = stage;
  }
}

interface ScopeState {
  tail: Promise<void>;
  transactionTail: Promise<void>;
  streamUsers: number;
  activeScope?: symbol;
  poisoned?: unknown;
}

interface RuntimeOptions extends DatabaseOptions {
  readonly transaction: boolean;
  readonly preparedNames: Set<string>;
  readonly rootState: ScopeState;
  readonly pooled: boolean;
  readonly lease?: ConnectionLease;
  readonly leaseState?: ScopeState;
  readonly transactionId?: string;
  readonly depth: number;
  readonly scope?: symbol;
}

interface TransactionContext {
  readonly rootState: ScopeState;
  readonly activity: { active: boolean };
  readonly parent?: TransactionContext;
}

interface PhysicalContext {
  readonly rootState: ScopeState;
  readonly direct: boolean;
  readonly stream: boolean;
}

interface OperationMeta {
  readonly operationId: string;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
  readonly preparedName?: string;
  readonly batchId?: string;
}

interface PreparedOperation<Q extends Query<unknown, QueryResultKind>> {
  readonly query: Q;
  readonly rendered: RenderedStatement;
  readonly binding: StatementBindingDescription;
  readonly meta: OperationMeta;
}

interface RawOperation<Q extends Query<unknown, QueryResultKind>> extends PreparedOperation<Q> {
  readonly result?: QueryExecutionResult<unknown>;
  readonly durationMs: number;
  readonly driverError?: unknown;
  readonly driverFailed: boolean;
}

interface Use {
  readonly executor: QueryExecutor;
  readonly physicalState: ScopeState;
  readonly direct: boolean;
  readonly release: (discard?: boolean) => Promise<void>;
}

class PreparationFailure extends Error {
  declare readonly cause?: unknown;
  readonly stage: "render" | "materialize";

  constructor(stage: "render" | "materialize", cause: unknown) {
    super(stage === "render" ? "Query rendering failed." : "Statement materialization failed.", { cause });
    this.name = "PreparationFailure";
    this.stage = stage;
  }
}

const transactionContext = new AsyncLocalStorage<TransactionContext>();
const physicalContext = new AsyncLocalStorage<PhysicalContext>();
const scopeStates = new WeakMap<object, ScopeState>();
let operationSequence = 0;
let transactionSequence = 0;

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function nextOperationId(): string {
  operationSequence += 1;
  return `braid_op_${operationSequence}`;
}

function nextTransactionId(): string {
  transactionSequence += 1;
  return `braid_tx_${transactionSequence}`;
}

function scopeStateFor(executor: QueryExecutor): ScopeState {
  const key = executor.ownershipKey ?? executor;
  let state = scopeStates.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), transactionTail: Promise.resolve(), streamUsers: 0 };
    scopeStates.set(key, state);
  }
  return state;
}

function acquireTransactionTurn(state: ScopeState): Promise<() => void> {
  assertHealthy(state);
  const { promise: turn, resolve: release } = Promise.withResolvers<void>();
  const previous = state.transactionTail;
  state.transactionTail = previous.then(() => turn);
  return previous.then(() => release);
}

function isPoisoned(state: ScopeState): boolean {
  return Object.hasOwn(state, "poisoned");
}

function poison(state: ScopeState, reason: unknown): void {
  if (!isPoisoned(state)) state.poisoned = reason;
}

function assertHealthy(state: ScopeState): void {
  if (isPoisoned(state)) {
    throw new DatabaseScopeError(
      "BRAID_CONNECTION_POISONED",
      "The physical execution resource is poisoned and cannot accept new SQLBraid work.",
      state.poisoned,
    );
  }
}

function assertRootAllowed(rootState: ScopeState, stream: boolean): void {
  for (let transaction = transactionContext.getStore(); transaction; transaction = transaction.parent) {
    if (transaction.rootState === rootState && transaction.activity.active) {
      throw new DatabaseScopeError("BRAID_TX_SCOPE", "The root database handle cannot be used from its own transaction callback.");
    }
  }
  const active = physicalContext.getStore();
  if (active?.rootState === rootState && active.direct && active.stream) {
    throw new DatabaseScopeError(
      "BRAID_STREAM_SCOPE",
      "A direct database stream cannot re-enter its own physical execution resource.",
    );
  }
  if (rootState.streamUsers > 0) {
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

function acquireDirectRoot(rootState: ScopeState, stream: boolean): Promise<() => void> {
  assertHealthy(rootState);
  assertRootAllowed(rootState, stream);
  const { promise: turn, resolve: release } = Promise.withResolvers<void>();
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

function malformedExecutionResult(): never {
  throw new TypeError("Executor returned a malformed query execution result.");
}

function bindingAdapterFor(resource: QueryExecutor | ConnectionProvider): StatementBindingAdapter {
  const adapter = resource.statementBinding;
  if (
    adapter === null
    || typeof adapter !== "object"
    || typeof adapter.id !== "string"
    || adapter.id.length === 0
    || typeof adapter.describe !== "function"
  ) {
    throw new TypeError("Execution resource returned an invalid statement binding adapter.");
  }
  return adapter;
}

function assertBindingDescription(
  description: StatementBindingDescription,
  adapter: StatementBindingAdapter,
  statement: RenderedStatement,
): StatementBindingDescription {
  const effective = statement.dialectId;
  const validTransport = description !== null
    && typeof description === "object"
    && (description.transport === "native-value-template"
      || description.transport === "text-positional"
      || description.transport === "text-named"
      || description.transport === "typed-request");
  const validReuseOwner = description !== null
    && typeof description === "object"
    && (description.reuse?.owner === "sqlbraid" || description.reuse?.owner === "driver" || description.reuse?.owner === "server");
  if (
    description === null
    || typeof description !== "object"
    || description.adapterId !== adapter.id
    || description.dialectId !== effective
    || !validTransport
    || !Array.isArray(description.bindings)
    || description.bindings.length !== statement.parameters.length
    || description.reuse === null
    || typeof description.reuse !== "object"
    || description.reuse.requested === undefined
    || (description.reuse.requested !== "auto" && description.reuse.requested !== "simple" && description.reuse.requested !== "reuse")
    || (description.reuse.effective !== "simple" && description.reuse.effective !== "reuse")
    || !validReuseOwner
    || typeof description.literalizedSql !== "function"
  ) {
    throw new TypeError("Statement binding adapter returned an invalid description.");
  }
  if (description.reuse.capacity !== undefined
    && (!Number.isInteger(description.reuse.capacity) || description.reuse.capacity < 0)) {
    throw new TypeError("Statement binding adapter returned an invalid reuse capacity.");
  }
  for (const [offset, binding] of description.bindings.entries()) {
    if (
      binding === null
      || typeof binding !== "object"
      || binding.index !== offset + 1
      || binding.interpolation !== statement.parameters[offset].interpolation
    ) {
      throw new TypeError("Statement binding adapter returned misaligned bindings.");
    }
    const expectedHint = statement.parameters[offset].hint;
    const actualHint = binding.hint;
    if ((expectedHint === undefined) !== (actualHint === undefined)
      || (expectedHint !== undefined && (
        actualHint!.databaseType !== expectedHint.databaseType
        || actualHint!.length !== expectedHint.length
        || actualHint!.precision !== expectedHint.precision
        || actualHint!.scale !== expectedHint.scale
      ))) {
      throw new TypeError("Statement binding adapter returned misaligned parameter hints.");
    }
    if (actualHint !== undefined && !Object.isFrozen(actualHint)) Object.freeze(actualHint);
    if (!Object.isFrozen(binding)) Object.freeze(binding);
  }
  if (!Object.isFrozen(description.bindings)) Object.freeze(description.bindings);
  if (!Object.isFrozen(description.reuse)) Object.freeze(description.reuse);
  if (!Object.isFrozen(description)) Object.freeze(description);
  return description;
}

function bindingIdentityMismatch(): TypeError {
  const error = new TypeError("BRAID_BINDING_IDENTITY: leased execution resource uses a different statement binding adapter.");
  return error;
}

function isBindingIdentityMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("BRAID_BINDING_IDENTITY:");
}

function assertExecutableQuery(query: Query<unknown, QueryResultKind>): asserts query is ExecutableQuery {
  if (query.resultKind === "call") throw new TypeError("Call queries must be executed with database.call().");
}

function assertRowsQuery(query: Query<unknown, QueryResultKind>): asserts query is RowQuery<unknown> {
  if (query.resultKind === "call") throw new TypeError("Call queries must be executed with database.call().");
  if (query.resultKind === "command") throw new DatabaseResultKindError("command", "rows");
}

function standardSchemaFor<Input, Output>(schema: StandardSchemaV1<Input, Output> | undefined): StandardSchemaV1.Props<Input, Output> | undefined {
  if (schema === undefined) return undefined;
  if (schema === null || typeof schema !== "object") throw new TypeError("Standard Schema validator is malformed.");
  const candidate = (schema as { readonly "~standard"?: unknown })["~standard"];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Standard Schema validator is malformed.");
  }
  const standard = candidate as { readonly version?: unknown; readonly validate?: unknown };
  if (standard.version !== 1 || typeof standard.validate !== "function") {
    throw new TypeError("Standard Schema validator is malformed.");
  }
  return standard as StandardSchemaV1.Props<Input, Output>;
}

function isStandardSchemaSuccess<T>(result: unknown): result is StandardSchemaV1.SuccessResult<T> {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const candidate = result as { readonly value?: unknown; readonly issues?: unknown };
  return "value" in candidate && candidate.issues === undefined;
}

function isStandardSchemaFailure(result: unknown): result is StandardSchemaV1.FailureResult {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const candidate = result as { readonly value?: unknown; readonly issues?: unknown };
  return Array.isArray(candidate.issues) && (!("value" in candidate) || candidate.value === undefined);
}

function assertStandardSchemaResult(result: unknown): asserts result is StandardSchemaV1.Result<unknown> {
  if (!isStandardSchemaSuccess(result) && !isStandardSchemaFailure(result)) {
    throw new TypeError("Standard Schema validator returned a malformed result.");
  }
}

async function validateRow<Output>(
  standard: StandardSchemaV1.Props<unknown, Output>,
  row: unknown,
  rowIndex: number,
  stage: "query" | "execution",
): Promise<Output> {
  const result = await standard.validate(row);
  assertStandardSchemaResult(result);
  if (isStandardSchemaFailure(result)) throw new DatabaseResultValidationError(result.issues, rowIndex, stage);
  return result.value;
}

function assertExecutionResult<Row>(query: Query<unknown, QueryResultKind>, result: QueryExecutionResult<Row>): QueryExecutionResult<Row> {
  if (result === null || typeof result !== "object" || (result.kind !== "rows" && result.kind !== "command") || !Array.isArray(result.rows)) {
    malformedExecutionResult();
  }
  if (result.kind === "rows") {
    if ("command" in result && result.command !== undefined) malformedExecutionResult();
  } else if (result.rows.length !== 0 || !result.command || typeof result.command !== "object" || Array.isArray(result.command)) {
    malformedExecutionResult();
  }
  if (query.resultKind !== "unknown" && query.resultKind !== result.kind) {
    throw new DatabaseResultKindError(query.resultKind, result.kind);
  }
  return result;
}

function frozenEvent(event: ExecutionEvent): ExecutionEvent {
  if (event.type === "query:ready" || event.type === "stream:start") {
    const values = Object.freeze([...event.values]);
    const bindingMap = event.bindingMap === undefined ? undefined : Object.freeze(event.bindingMap.map((item) => Object.freeze({ ...item })));
    const parameterHints = event.parameterHints !== undefined
      ? Object.freeze(event.parameterHints.map((hint) => hint === undefined ? undefined : Object.freeze({ ...hint })))
      : undefined;
    const execution = Object.freeze({
      ...event.execution,
      reuse: Object.freeze({ ...event.execution.reuse }),
    });
    const descriptors = Object.getOwnPropertyDescriptors(event);
    if (descriptors.values !== undefined) descriptors.values.value = values;
    if (bindingMap !== undefined && descriptors.bindingMap !== undefined) descriptors.bindingMap.value = bindingMap;
    if (parameterHints !== undefined && descriptors.parameterHints !== undefined) descriptors.parameterHints.value = parameterHints;
    if (descriptors.execution !== undefined) descriptors.execution.value = execution;
    return Object.freeze(Object.defineProperties({}, descriptors)) as ExecutionEvent;
  }
  return Object.freeze(event) as ExecutionEvent;
}

async function notify(observers: readonly ExecutionObserver[], event: ExecutionEvent): Promise<void> {
  if (observers.length === 0) return;
  const immutable = frozenEvent(event);
  for (const observer of observers) await observer.onEvent(immutable);
}

async function notifyError(
  observers: readonly ExecutionObserver[],
  event: ExecutionEvent,
  original: unknown,
): Promise<never> {
  const failures: unknown[] = [];
  const immutable = frozenEvent(event);
  for (const observer of observers) {
    try {
      await observer.onEvent(immutable);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) throw original;
  throw new AggregateError([original, ...failures], "Execution failed and error observers also failed.", { cause: original });
}

function metadata(options: RuntimeOptions, operationId: string, preparedName?: string, batchId?: string): OperationMeta {
  return {
    operationId,
    preparedName,
    batchId,
    transactionDepth: options.depth,
    transactionScoped: options.transaction,
  };
}

function parameterHintShape(rendered: RenderedStatement): string {
  return JSON.stringify(rendered.parameters.map(({ hint }) => {
    if (hint === undefined) return null;
    return {
      databaseType: hint.databaseType,
      ...(hint.length === undefined ? {} : { length: hint.length }),
      ...(hint.precision === undefined ? {} : { precision: hint.precision }),
      ...(hint.scale === undefined ? {} : { scale: hint.scale }),
    };
  }));
}

function preparedShape(query: ExecutableQuery, rendered: RenderedStatement): string {
  return JSON.stringify({
    resultKind: query.resultKind,
    segments: rendered.segments,
    hints: parameterHintShape(rendered),
  });
}

function executionProjection(binding: StatementBindingDescription): {
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

function eventSql(
  event: object,
  binding: StatementBindingDescription,
): void {
  Object.defineProperty(event, "sql", {
    configurable: false,
    enumerable: true,
    get: () => binding.parameterizedSql,
  });
}

function queryReadyEvent(operation: PreparedOperation<Query<unknown, QueryResultKind>>): ExecutionEvent {
  const { query, rendered, binding, meta } = operation;
  const parameterHints = rendered.parameters.map((parameter) => parameter.hint);
  const event: QueryReadyEvent = {
    type: "query:ready",
    literalizedSql: (options) => binding.literalizedSql(options),
    operationId: meta.operationId,
    batchId: meta.batchId,
    values: rendered.parameters.map((parameter) => parameter.value),
    bindingMap: rendered.parameters.map((parameter, index) => ({
      placeholder: index + 1,
      ...(parameter.interpolation === undefined ? {} : { interpolation: parameter.interpolation }),
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

function queryResultEvent(operation: RawOperation<ExecutableQuery>, result: QueryExecutionResult<unknown>): ExecutionEvent {
  return {
    type: "query:result",
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

function queryMappedEvent(operation: RawOperation<ExecutableQuery>, rowCount: number, queryMapped: boolean, executionMapped: boolean, durationMs: number): ExecutionEvent {
  return {
    type: "query:mapped",
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

function errorEvent(operation: { readonly meta: OperationMeta }, error: unknown, stage: QueryErrorEventStage, started: boolean, completed: boolean, durationMs?: number): ExecutionEvent {
  return {
    type: "query:error",
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

type QueryErrorEventStage = Extract<ExecutionEvent, { readonly type: "query:error" }>['stage'];

function streamStartEvent(operation: PreparedOperation<ExecutableQuery>): ExecutionEvent {
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

async function transactionEvent(
  observers: readonly ExecutionObserver[],
  transactionId: string,
  phase: Extract<ExecutionEvent, { readonly type: "transaction" }>['phase'],
  status: Extract<ExecutionEvent, { readonly type: "transaction" }>['status'],
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

export function createDatabase(executor: QueryExecutor, options: DatabaseOptions = {}): Database {
  bindingAdapterFor(executor);
  const rootState = scopeStateFor(executor);
  return createScopedDatabase(executor, rootState, {
    ...options,
    observers: options.observers === undefined ? [] : Object.freeze([...options.observers]),
    transaction: false,
    preparedNames: new Set<string>(),
    rootState,
    pooled: false,
    depth: 0,
  });
}

export function createPooledDatabase(provider: ConnectionProvider, options: DatabaseOptions = {}): Database {
  bindingAdapterFor(provider);
  const rootState: ScopeState = { tail: Promise.resolve(), transactionTail: Promise.resolve(), streamUsers: 0 };
  return createScopedDatabase(provider, rootState, {
    ...options,
    observers: options.observers === undefined ? [] : Object.freeze([...options.observers]),
    transaction: false,
    preparedNames: new Set<string>(),
    rootState,
    pooled: true,
    depth: 0,
  });
}

function createScopedDatabase(executor: QueryExecutor | ConnectionProvider, state: ScopeState, options: RuntimeOptions): Database & { close(): void; finish(): Promise<void> } {
  let closed = false;
  const statementBinding = bindingAdapterFor(executor);
  const openStreams = new Set<AsyncGenerator<unknown>>();
  const assertOpen = (): void => {
    if (closed) throw new DatabaseScopeError("BRAID_TX_CLOSED", "Transaction database is no longer usable.");
    if (options.transaction && state.activeScope !== options.scope) {
      throw new DatabaseScopeError("BRAID_TX_SCOPE", "Use the innermost transaction database while its savepoint is active.");
    }
  };
  const leaseForUse = async (stream: boolean, expectedBinding: StatementBindingAdapter): Promise<Use> => {
    assertOpen();
    assertHealthy(state);
    if (options.transaction) {
      const lease = options.lease;
      if (!lease || !options.leaseState) throw new DatabaseScopeError("BRAID_TX_CLOSED", "Transaction database is no longer usable.");
      const active = physicalContext.getStore();
      if (options.leaseState.streamUsers > 0 || (active?.rootState === options.rootState && active.direct)) {
        if (options.leaseState.streamUsers > 0) {
          throw new DatabaseScopeError("BRAID_STREAM_SCOPE", "A transaction stream cannot re-enter its pinned physical execution resource.");
        }
        throw new DatabaseScopeError("BRAID_REENTRY", "A transaction connection cannot execute concurrent physical work.");
      }
      assertHealthy(options.leaseState);
      const releaseTurn = await acquireTransactionTurn(options.leaseState);
      try { assertOpen(); assertHealthy(options.leaseState); }
      catch (error) { releaseTurn(); throw error; }
      if (lease.statementBinding !== expectedBinding) {
        releaseTurn();
        throw bindingIdentityMismatch();
      }
      return { executor: lease, physicalState: options.leaseState, direct: true, release: async () => { releaseTurn(); } };
    }
    assertRootAllowed(options.rootState, stream);
    if (!options.pooled) {
      const release = await acquireDirectRoot(state, stream);
      return { executor: executor as QueryExecutor, physicalState: state, direct: true, release: async () => { release(); } };
    }
    let lease: ConnectionLease;
    try {
      lease = await (executor as ConnectionProvider).acquire();
    } catch (error) {
      throw error;
    }
    if (!lease || typeof lease !== "object" || typeof lease.release !== "function" || typeof lease.query !== "function") {
      throw new TypeError("Connection provider returned an invalid lease.");
    }
    if (lease.statementBinding !== expectedBinding) {
      let releaseError: unknown;
      let releaseFailed = false;
      try { await lease.release({ discard: true }); } catch (error) { releaseFailed = true; releaseError = error; }
      const mismatch = bindingIdentityMismatch();
      if (releaseFailed) throw new AggregateError([mismatch, releaseError], "Binding identity mismatch and lease cleanup failed.", { cause: mismatch });
      throw mismatch;
    }
    const leaseState = scopeStateFor(lease);
    try {
      assertHealthy(leaseState);
    } catch (error) {
      try { await lease.release({ discard: true }); } catch (releaseError) { throw new AggregateError([error, releaseError], "Poisoned lease cleanup failed.", { cause: error }); }
      throw error;
    }
    return {
      executor: lease,
      physicalState: leaseState,
      direct: false,
      release: async (discard = false) => { await lease.release(discard ? { discard: true } : undefined); },
    };
  };
  const prepare = <Q extends Query<unknown, QueryResultKind>>(
    query: Q,
    preparedName?: string,
    batchId?: string,
    alreadyRendered?: RenderedStatement,
  ): PreparedOperation<Q> => {
    const operationId = nextOperationId();
    let rendered: RenderedStatement;
    try {
      rendered = alreadyRendered ?? createRenderedStatement(query.render());
    } catch (error) {
      throw new PreparationFailure("render", error);
    }
    const adapter = statementBinding;
    const requestedReuse = options.reuse === "simple"
      ? "simple"
      : preparedName === undefined ? (options.reuse ?? "auto") : "reuse";
    let binding: StatementBindingDescription;
    try {
      binding = assertBindingDescription(adapter.describe(rendered, {
        dialectId: rendered.dialectId,
        requestedReuse,
        preparedName,
      }), adapter, rendered);
      if ("parameterizedSql" in binding) {
        const parameterizedSql = binding.parameterizedSql;
        if (parameterizedSql !== undefined && typeof parameterizedSql !== "string") {
          throw new TypeError("BRAID_BIND_TRANSPORT: binding parameterized SQL must be a string.");
        }
        if ((binding.transport === "text-positional" || binding.transport === "text-named") && parameterizedSql === undefined) {
          throw new TypeError("BRAID_BIND_TRANSPORT: text binding descriptions must provide parameterized SQL.");
        }
      } else if (binding.transport === "text-positional" || binding.transport === "text-named") {
        throw new TypeError("BRAID_BIND_TRANSPORT: text binding descriptions must provide parameterized SQL.");
      }
    } catch (error) {
      throw new PreparationFailure("materialize", error);
    }
    return { query, rendered, binding, meta: metadata(options, operationId, preparedName, batchId) };
  };
  const observePrepared = async <Q extends Query<unknown, QueryResultKind>>(operation: PreparedOperation<Q>): Promise<void> => {
    try {
      await notify(options.observers ?? [], queryReadyEvent(operation));
    } catch (error) {
      await notifyError(options.observers ?? [], errorEvent(operation, error, "observer-before", false, false), error);
    }
  };
  const prepareObserved = async <Q extends Query<unknown, QueryResultKind>>(query: Q, preparedName?: string, batchId?: string): Promise<PreparedOperation<Q>> => {
    let operation: PreparedOperation<Q>;
    try {
      operation = prepare(query, preparedName, batchId);
    } catch (error) {
      const failure = error instanceof PreparationFailure ? error : undefined;
      const reported = failure === undefined ? error : failure.cause;
      await notifyError(
        options.observers ?? [],
        errorEvent({ meta: metadata(options, nextOperationId(), preparedName, batchId) }, reported, failure?.stage ?? "render", false, false),
        reported,
      );
      throw reported;
    }
    await observePrepared(operation);
    return operation;
  };
  const physical = async <Q extends ExecutableQuery>(operation: PreparedOperation<Q>, use: Use): Promise<RawOperation<Q>> => {
    const started = now();
    try {
      const result = await physicalContext.run(
        { rootState: options.rootState, direct: use.direct, stream: false },
        () => use.executor.query<unknown>(operation.rendered, operation.binding),
      );
      return { ...operation, result, durationMs: now() - started, driverFailed: false };
    } catch (driverError) {
      return { ...operation, driverError, driverFailed: true, durationMs: now() - started };
    }
  };
  const finalizePhysical = async <Q extends ExecutableQuery>(operation: RawOperation<Q>): Promise<QueryExecutionResult<unknown>> => {
    if (operation.driverFailed) {
      await notifyError(options.observers ?? [], errorEvent(operation as RawOperation<ExecutableQuery>, operation.driverError, "driver", true, false, operation.durationMs), operation.driverError);
    }
    let result: QueryExecutionResult<unknown>;
    try {
      result = assertExecutionResult(operation.query, operation.result as QueryExecutionResult<unknown>);
    } catch (error) {
      await notifyError(options.observers ?? [], errorEvent(operation as RawOperation<ExecutableQuery>, error, "result-kind", true, true, operation.durationMs), error);
    }
    try {
      await notify(options.observers ?? [], queryResultEvent(operation as RawOperation<ExecutableQuery>, result!));
    } catch (error) {
      await notifyError(options.observers ?? [], errorEvent(operation as RawOperation<ExecutableQuery>, error, "observer-after", true, true, operation.durationMs), error);
    }
    return result!;
  };
  const processRows = async <Q extends ExecutableQuery>(operation: RawOperation<Q>, result: QueryExecutionResult<unknown>, executionSchema?: StandardSchemaV1<unknown, QueryRow<Q>>): Promise<QueryExecutionResult<unknown>> => {
    const queryMapped = operation.query.resultSchema !== undefined;
    const executionMapped = executionSchema !== undefined;
    if (result.kind !== "rows" || (!queryMapped && !executionMapped)) {
      try {
        await notify(options.observers ?? [], queryMappedEvent(operation as RawOperation<ExecutableQuery>, result.kind === "rows" ? result.rows.length : result.rowCount ?? 0, queryMapped, executionMapped, 0));
      } catch (error) {
        await notifyError(options.observers ?? [], errorEvent(operation as RawOperation<ExecutableQuery>, error, "observer-after", true, true, operation.durationMs), error);
      }
      return result;
    }
    const mappingStarted = now();
    const rows: unknown[] = [];
    let queryStandard: StandardSchemaV1.Props<unknown, unknown> | undefined;
    let executionStandard: StandardSchemaV1.Props<unknown, unknown> | undefined;
    try {
      queryStandard = standardSchemaFor(operation.query.resultSchema) as StandardSchemaV1.Props<unknown, unknown> | undefined;
    } catch (error) {
      await notifyError(options.observers ?? [], errorEvent(operation as RawOperation<ExecutableQuery>, error, "query-map", true, true, operation.durationMs), error);
    }
    try {
      executionStandard = standardSchemaFor(executionSchema) as StandardSchemaV1.Props<unknown, unknown> | undefined;
    } catch (error) {
      await notifyError(options.observers ?? [], errorEvent(operation as RawOperation<ExecutableQuery>, error, "execution-map", true, true, operation.durationMs), error);
    }
    for (let rowIndex = 0; rowIndex < result.rows.length; rowIndex += 1) {
      let mapped: unknown = result.rows[rowIndex];
      if (queryStandard !== undefined) {
        try {
          mapped = await validateRow(queryStandard, mapped, rowIndex, "query");
        } catch (error) {
          await notifyError(options.observers ?? [], errorEvent(operation as RawOperation<ExecutableQuery>, error, "query-map", true, true, operation.durationMs), error);
        }
      }
      if (executionStandard !== undefined) {
        try {
          mapped = await validateRow(executionStandard, mapped, rowIndex, "execution");
        } catch (error) {
          await notifyError(options.observers ?? [], errorEvent(operation as RawOperation<ExecutableQuery>, error, "execution-map", true, true, operation.durationMs), error);
        }
      }
      rows.push(mapped);
    }
    try {
      await notify(options.observers ?? [], queryMappedEvent(operation as RawOperation<ExecutableQuery>, result.rows.length, queryMapped, executionMapped, now() - mappingStarted));
    } catch (error) {
      await notifyError(options.observers ?? [], errorEvent(operation as RawOperation<ExecutableQuery>, error, "observer-after", true, true, operation.durationMs), error);
    }
    return { ...result, rows: rows! };
  };
  const processOne = async <Q extends ExecutableQuery>(operation: RawOperation<Q>, result: QueryExecutionResult<unknown>, executionSchema?: StandardSchemaV1<unknown, QueryRow<Q>>): Promise<unknown> => {
    if (result.kind !== "rows") return result;
    const mapped = await processRows(operation, result, executionSchema);
    return mapped.rows[0];
  };
  const runPrepared = async <Q extends ExecutableQuery>(operation: PreparedOperation<Q>): Promise<RawOperation<Q>> => {
    let use: Use;
    try {
      use = await leaseForUse(false, statementBinding);
    } catch (error) {
      const stage = isBindingIdentityMismatch(error) ? "materialize" : "acquire";
      await notifyError(options.observers ?? [], errorEvent(operation, error, stage, false, false), error);
      throw error;
    }
    const raw = await physical(operation, use!);
    let releaseError: unknown;
    let releaseFailed = false;
    try {
      await use!.release();
    } catch (error) {
      releaseError = error;
      releaseFailed = true;
      poison(use!.physicalState, error);
    }
    if (raw.driverFailed) {
      const original = releaseFailed ? new AggregateError([raw.driverError, releaseError], "Execution and lease release failed.", { cause: raw.driverError }) : raw.driverError;
      const stage = releaseFailed ? "release" : "driver";
      await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, original, stage, true, false, raw.durationMs), original);
    }
    if (releaseFailed) {
      await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, releaseError, "release", true, true, raw.durationMs), releaseError);
    }
    return raw;
  };
  const runMaterialized = async <Q extends ExecutableQuery>(query: Q, preparedName?: string, batchId?: string): Promise<RawOperation<Q>> => {
    assertExecutableQuery(query);
    return runPrepared(await prepareObserved(query, preparedName, batchId));
  };
  const materializedPreparedResult = async <Q extends ExecutableQuery>(
    operation: PreparedOperation<Q>,
    executionSchema?: StandardSchemaV1<unknown, QueryRow<Q>>,
  ): Promise<QueryExecutionResult<unknown>> => {
    const raw = await runPrepared(operation);
    const result = await finalizePhysical(raw);
    return processRows(raw, result, executionSchema);
  };
  const materializedResult = async <Q extends ExecutableQuery>(query: Q, preparedName?: string, executionSchema?: StandardSchemaV1<unknown, QueryRow<Q>>, batchId?: string): Promise<QueryExecutionResult<unknown>> => {
    return materializedPreparedResult(await prepareObserved(query, preparedName, batchId), executionSchema);
  };
  const executeNamed = async <Q extends ExecutableQuery>(query: Q, preparedName?: string): Promise<ExecutionResultOf<Q>> => await materializedResult(query, preparedName) as ExecutionResultOf<Q>;
  const allNamed = async <Row>(query: RowQuery<Row>, validationOptions?: RowValidationOptions<Row>, preparedName?: string): Promise<readonly Row[]> => {
    const result = await materializedResult(query, preparedName, validationOptions?.schema);
    if (result.kind !== "rows") malformedExecutionResult();
    return result.rows as readonly Row[];
  };
  const oneNamed = async <Row>(query: RowQuery<Row>, validationOptions?: RowValidationOptions<Row>, preparedName?: string): Promise<Row> => {
    const raw = await runMaterialized(query, preparedName);
    const result = await finalizePhysical(raw);
    if (result.kind !== "rows") malformedExecutionResult();
    if (result.rows.length !== 1) {
      const error = new DatabaseCardinalityError("one", result.rows.length);
      await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs), error);
    }
    return await processOne(raw, result, validationOptions?.schema) as Row;
  };
  const maybeOneNamed = async <Row>(query: RowQuery<Row>, validationOptions?: RowValidationOptions<Row>, preparedName?: string): Promise<Row | undefined> => {
    const raw = await runMaterialized(query, preparedName);
    const result = await finalizePhysical(raw);
    if (result.kind !== "rows") malformedExecutionResult();
    if (result.rows.length > 1) {
      const error = new DatabaseCardinalityError("maybeOne", result.rows.length);
      await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs), error);
    }
    if (result.rows.length === 0) {
      try { await notify(options.observers ?? [], queryMappedEvent(raw as RawOperation<ExecutableQuery>, 0, query.resultSchema !== undefined, validationOptions?.schema !== undefined, 0)); }
      catch (error) { await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "observer-after", true, true, raw.durationMs), error); }
      return undefined;
    }
    return await processOne(raw, result, validationOptions?.schema) as Row;
  };
  const database: Database & { close(): void; finish(): Promise<void> } = {
    async execute<Q extends ExecutableQuery>(query: Q): Promise<ExecutionResultOf<Q>> {
      return await executeNamed(query);
    },
    async call<Row>(query: CallQuery<Row>): Promise<RoutineCallResult<Row>> {
      assertOpen();
      if (query.resultKind !== "call") throw new TypeError("Only call queries may be executed with database.call().");
      const operation = await prepareObserved(query);
      let use: Use;
      try {
        use = await leaseForUse(false, statementBinding);
      } catch (error) {
        const stage = isBindingIdentityMismatch(error) ? "materialize" : "acquire";
        await notifyError(options.observers ?? [], errorEvent(operation, error, stage, false, false), error);
        throw error;
      }
      if (!use!.executor.call) {
        const error = new Error("Executor does not support routine calls.");
        let releaseError: unknown;
        try { await use!.release(); } catch (failure) { releaseError = failure; poison(use!.physicalState, failure); }
        const reported = releaseError === undefined ? error : new AggregateError([error, releaseError], "Call and lease release failed.", { cause: error });
        await notifyError(options.observers ?? [], errorEvent(operation, reported, releaseError === undefined ? "driver" : "release", false, false), reported);
      }
      const started = now();
      let value: RoutineCallResult<Row>;
      let released = false;
      try {
        value = await physicalContext.run(
          { rootState: options.rootState, direct: use!.direct, stream: false },
          () => use!.executor.call!(operation.rendered, operation.binding),
        );
      } catch (error) {
        let releaseError: unknown;
        try { await use!.release(); } catch (failure) { releaseError = failure; poison(use!.physicalState, failure); }
        released = true;
        const original = releaseError === undefined ? error : new AggregateError([error, releaseError], "Execution and lease release failed.", { cause: error });
        await notifyError(options.observers ?? [], errorEvent(operation, original, releaseError === undefined ? "driver" : "release", true, false, now() - started), original);
      }
      if (!released) {
        try { await use!.release(); } catch (error) { poison(use!.physicalState, error); await notifyError(options.observers ?? [], errorEvent(operation, error, "release", true, true, now() - started), error); }
      }
      const rowCount = value!.resultSets.reduce((count, set) => count + (set.rows === "unknown" ? 0 : set.rows.length), 0);
      try {
        await notify(options.observers ?? [], {
          type: "query:result",
          operationId: operation.meta.operationId,
          durationMs: now() - started,
          actualKind: "call",
          rowCount,
          transactionDepth: options.depth,
          transactionScoped: options.transaction,
        });
        await notify(options.observers ?? [], {
          type: "query:mapped",
          operationId: operation.meta.operationId,
          durationMs: 0,
          rowCount,
          queryMapped: false,
          executionMapped: false,
          transactionDepth: options.depth,
          transactionScoped: options.transaction,
        });
      } catch (error) {
        await notifyError(options.observers ?? [], errorEvent(operation, error, "observer-after", true, true, now() - started), error);
      }
      return value!;
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
    async batch<const Queries extends readonly ExecutableQuery[]>(queries: Queries): Promise<{ readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> }> {
      assertOpen();
      for (const query of queries) assertExecutableQuery(query);
      const batchId = `braid_batch_${nextOperationId()}`;
      const operations: PreparedOperation<ExecutableQuery>[] = [];
      for (const query of queries) operations.push(await prepareObserved(query, undefined, batchId));
      let use: Use;
      try {
        use = await leaseForUse(false, statementBinding);
      } catch (error) {
        const operation = operations[0];
        if (operation) {
          const stage = isBindingIdentityMismatch(error) ? "materialize" : "acquire";
          await notifyError(options.observers ?? [], errorEvent(operation, error, stage, false, false), error);
        }
        throw error;
      }
      const raw: RawOperation<ExecutableQuery>[] = [];
      let batchReleaseError: unknown;
      let batchReleaseFailed = false;
      try {
        for (const operation of operations) {
          const result = await physical(operation, use);
          raw.push(result);
          if (result.driverFailed) break;
        }
      } finally {
        try { await use.release(); } catch (error) { batchReleaseError = error; batchReleaseFailed = true; poison(use.physicalState, error); }
      }
      if (batchReleaseFailed) {
        const failed = raw.find((operation) => operation.driverFailed);
        if (failed) {
          const original = new AggregateError([failed.driverError, batchReleaseError], "Batch execution and lease release failed.", { cause: failed.driverError });
          await notifyError(options.observers ?? [], errorEvent(failed, original, "release", true, false, failed.durationMs), original);
        }
        const operation = failed ?? raw.at(-1) ?? operations[0];
        if (operation) await notifyError(options.observers ?? [], errorEvent(operation, batchReleaseError, "release", true, true), batchReleaseError);
      }
      const output: QueryExecutionResult<unknown>[] = [];
      for (const operation of raw) {
        const result = await finalizePhysical(operation);
        output.push(await processRows(operation, result));
      }
      return output as { readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> };
    },
    prepare<Row>(name: string, factory: () => RowQuery<Row>): PreparedQuery<Row> {
      if (!name.trim()) throw new Error("BRAID_PREPARED_NAME: prepared query name must not be empty.");
      if (options.preparedNames.has(name)) throw new Error(`BRAID_PREPARED_NAME: duplicate prepared query name ${name}.`);
      options.preparedNames.add(name);
      let shape: string | undefined;
      const current = (): PreparedOperation<RowQuery<Row>> => {
        const query = factory();
        const rendered = createRenderedStatement(query.render());
        const nextShape = preparedShape(query, rendered);
        if (shape === undefined) shape = nextShape;
        else if (shape !== nextShape) throw new Error(`BRAID_PREPARED_SHAPE: prepared query ${name} changed its rendered structure.`);
        return prepare(query, name, undefined, rendered);
      };
      const currentObserved = async (): Promise<PreparedOperation<RowQuery<Row>>> => {
        const operation = current();
        await observePrepared(operation);
        return operation;
      };
      return {
        name,
        execute: async () => await materializedPreparedResult(await currentObserved()) as RowsExecutionResult<Row>,
        all: async (validationOptions?: RowValidationOptions<Row>) => {
          const result = await materializedPreparedResult(await currentObserved(), validationOptions?.schema);
          if (result.kind !== "rows") malformedExecutionResult();
          return result.rows as readonly Row[];
        },
        one: async (validationOptions?: RowValidationOptions<Row>) => {
          const raw = await runPrepared(await currentObserved());
          const result = await finalizePhysical(raw);
          if (result.kind !== "rows") malformedExecutionResult();
          if (result.rows.length !== 1) {
            const error = new DatabaseCardinalityError("one", result.rows.length);
            await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs), error);
          }
          return await processOne(raw, result, validationOptions?.schema) as Row;
        },
        maybeOne: async (validationOptions?: RowValidationOptions<Row>) => {
          const raw = await runPrepared(await currentObserved());
          const result = await finalizePhysical(raw);
          if (result.kind !== "rows") malformedExecutionResult();
          if (result.rows.length > 1) {
            const error = new DatabaseCardinalityError("maybeOne", result.rows.length);
            await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs), error);
          }
          if (result.rows.length === 0) {
            try {
              await notify(options.observers ?? [], queryMappedEvent(
                raw as RawOperation<ExecutableQuery>,
                0,
                raw.query.resultSchema !== undefined,
                validationOptions?.schema !== undefined,
                0,
              ));
            } catch (error) {
              await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "observer-after", true, true, raw.durationMs), error);
            }
            return undefined;
          }
          return await processOne(raw, result, validationOptions?.schema) as Row;
        },
      };
    },
    stream<Row>(query: RowQuery<Row>, streamOptions: StreamOptions<Row> = {}): AsyncIterable<Row> {
      assertOpen();
      assertHealthy(state);
      assertRowsQuery(query);
      const operationId = nextOperationId();
      let stream!: AsyncGenerator<Row>;
      stream = (async function* (): AsyncGenerator<Row> {
        let operation: PreparedOperation<ExecutableQuery>;
        try {
          operation = prepare(query) as PreparedOperation<ExecutableQuery>;
        } catch (error) {
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
          await notify(options.observers ?? [], streamStartEvent(operation));
        } catch (error) {
          await notifyError(options.observers ?? [], errorEvent(operation, error, "observer-before", false, false), error);
        }
        let use: Use;
        try {
          use = await leaseForUse(true, statementBinding);
        } catch (error) {
          const stage = isBindingIdentityMismatch(error) ? "materialize" : "acquire";
          await notifyError(options.observers ?? [], errorEvent(operation, error, stage, false, false), error);
        }
        const started = now();
        let count = 0;
        let streamError: unknown;
        let streamFailed = false;
        let errorAlreadyReported = false;
        let iterator: AsyncIterator<unknown> | undefined;
        const activeContext: PhysicalContext = { rootState: options.rootState, direct: use!.direct, stream: true };
        use!.physicalState.streamUsers += 1;
        openStreams.add(stream);
        try {
          if (!use!.executor.stream) throw new Error("BRAID_STREAM_UNSUPPORTED: this adapter does not expose a streaming protocol.");
          const source = physicalContext.run(
            activeContext,
            () => use!.executor.stream!(operation.rendered, streamOptions.signal, operation.binding),
          );
          iterator = source[Symbol.asyncIterator]();
          let queryStandard: StandardSchemaV1.Props<unknown, unknown> | undefined;
          let executionStandard: StandardSchemaV1.Props<unknown, unknown> | undefined;
          try { queryStandard = standardSchemaFor(query.resultSchema) as StandardSchemaV1.Props<unknown, unknown> | undefined; }
          catch (error) { errorAlreadyReported = true; await notifyError(options.observers ?? [], errorEvent(operation, error, "query-map", true, true, now() - started), error); }
          try { executionStandard = standardSchemaFor(streamOptions.schema) as StandardSchemaV1.Props<unknown, unknown> | undefined; }
          catch (error) { errorAlreadyReported = true; await notifyError(options.observers ?? [], errorEvent(operation, error, "execution-map", true, true, now() - started), error); }
          while (true) {
            const next = await physicalContext.run(activeContext, () => iterator!.next());
            if (next.done) break;
            const row = next.value;
            if (streamOptions.signal?.aborted) throw streamOptions.signal.reason ?? new Error("Stream aborted.");
            let mapped: unknown = row;
            if (queryStandard !== undefined) {
              try { mapped = await physicalContext.run(activeContext, () => validateRow(queryStandard!, row, count, "query")); }
              catch (error) { errorAlreadyReported = true; await notifyError(options.observers ?? [], errorEvent(operation, error, "query-map", true, true, now() - started), error); }
            }
            if (executionStandard !== undefined) {
              try { mapped = await physicalContext.run(activeContext, () => validateRow(executionStandard!, mapped, count, "execution")); }
              catch (error) { errorAlreadyReported = true; await notifyError(options.observers ?? [], errorEvent(operation, error, "execution-map", true, true, now() - started), error); }
            }
            if (streamOptions.signal?.aborted) throw streamOptions.signal.reason ?? new Error("Stream aborted.");
            count += 1;
            yield mapped as Row;
          }
        } catch (error) {
          streamError = error;
          streamFailed = true;
          if (!errorAlreadyReported) {
            try { await notifyError(options.observers ?? [], errorEvent(operation, error, "stream", true, false, now() - started), error); } catch (reported) { streamError = reported; }
          }
        } finally {
          if (iterator?.return) {
            try { await physicalContext.run(activeContext, () => iterator!.return!()); }
            catch (error) {
              streamError = streamFailed ? new AggregateError([streamError, error], "Stream iterator cleanup failed.", { cause: streamError }) : error;
              streamFailed = true;
              poison(use!.physicalState, streamError);
            }
          }
          let releaseError: unknown;
          let releaseFailed = false;
          try { await use!.release(isPoisoned(use!.physicalState)); } catch (error) { releaseError = error; releaseFailed = true; poison(use!.physicalState, error); }
          if (releaseFailed) {
            try { await notifyError(options.observers ?? [], errorEvent(operation, releaseError, "release", true, streamError === undefined, now() - started), releaseError); }
            catch (reported) { releaseError = reported; }
          }
          if (releaseFailed) {
            streamError = streamFailed
              ? new AggregateError([streamError, releaseError], "Stream and lease release failed.", { cause: streamError })
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
          try { await notify(options.observers ?? [], endEvent); }
          catch (error) {
            streamError = streamFailed ? new AggregateError([streamError, error], "Stream and observer failed.", { cause: streamError }) : error;
            streamFailed = true;
          }
          if (streamFailed) throw streamError;
        }
      })();
      return stream;
    },
    async tx<T>(callback: (database: Database) => Promise<T>): Promise<T> {
      assertOpen();
      assertHealthy(state);
      const nested = options.transaction;
      if (nested && state.streamUsers > 0) throw new DatabaseScopeError("BRAID_STREAM_SCOPE", "Close the transaction stream before opening a savepoint.");
      const transactionId = options.transactionId ?? nextTransactionId();
      const depth = options.depth + 1;
      const savepointName = nested ? `braid_sp_${nextTransactionId()}` : undefined;
      const scope = Symbol("transaction scope");
      const previousScope = state.activeScope;
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
      const combine = (original: unknown, errors: readonly unknown[]): unknown => errors.length === 0 ? original
        : new AggregateError([original, ...errors], "Transaction failed and cleanup also failed.", { cause: original });
      try {
        if (nested) {
          const lease = options.lease!;
          if (!lease.savepoint || !lease.rollbackTo || !lease.releaseSavepoint) throw new DatabaseScopeError("BRAID_TX_SCOPE", "Nested transactions require savepoint support.");
          use = { executor: lease, physicalState: state, direct: true, release: async () => {} };
        } else {
          await transactionEvent(observers, transactionId, "begin", "requested", depth);
          try { use = await leaseForUse(false, statementBinding); }
          catch (error) {
            try { await transactionEvent(observers, transactionId, "begin", "failed", depth, undefined, undefined, error); }
            catch (reporting) { throw combine(error, [reporting]); }
            throw error;
          }
          physicalState = use.physicalState;
          physicalState.activeScope = scope;
        }
        const resource = use.executor;
        if (!nested && (!resource.begin || !resource.commit || !resource.rollback)) throw new Error("Executor does not support transactions.");
        scoped = createScopedDatabase(resource, physicalState, {
          ...options, transaction: true, lease: resource as ConnectionLease, leaseState: physicalState, transactionId, depth, scope,
        });
        await transactionContext.run({ rootState: options.rootState, activity, parent }, async () => {
          const control = async (
            phase: Extract<ExecutionEvent, { type: "transaction" }>["phase"],
            action: () => Promise<void>,
            cleanup = false,
            requested = true,
          ): Promise<void> => {
            const errors: unknown[] = [];
            const start = now();
            if (requested) {
              try { await transactionEvent(observers, transactionId, phase, "requested", depth, undefined, savepointName); }
              catch (error) { if (!cleanup) throw error; errors.push(error); }
            }
            const release = await acquireTransactionTurn(physicalState);
            let driverFailed = false;
            try {
              await physicalContext.run({ rootState: options.rootState, direct: true, stream: false }, action);
            } catch (error) {
              driverFailed = true;
              errors.push(error);
              poison(physicalState, error);
            } finally { release(); }
            try {
              await transactionEvent(observers, transactionId, phase, driverFailed ? "failed" : "completed", depth, start, savepointName, driverFailed ? errors.at(-1) : undefined);
            } catch (error) { errors.push(error); }
            if (errors.length > 0) throw combine(errors[0], errors.slice(1));
          };
          try {
            await control(nested ? "savepoint" : "begin", async () => {
              if (nested) await resource.savepoint!(savepointName!);
              else await resource.begin!();
              started = true;
            }, false, nested);
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
            try { await scoped!.finish(); } catch (closing) { if (closing !== error) cleanup.push(closing); }
            if (started && !completed && !isPoisoned(physicalState)) {
              try { await control(nested ? "rollback-to-savepoint" : "rollback", () => nested ? resource.rollbackTo!(savepointName!) : resource.rollback!(), true); }
              catch (rollback) { cleanup.push(rollback); }
              if (nested && !isPoisoned(physicalState)) {
                try { await control("release-savepoint", () => resource.releaseSavepoint!(savepointName!), true); }
                catch (release) { cleanup.push(release); }
              }
            }
            const combined = combine(error, cleanup);
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
        if (use && !nested) {
          try { await use.release(isPoisoned(physicalState)); }
          catch (error) {
            poison(physicalState, error);
            failure = failed ? combine(failure, [error]) : error;
            failed = true;
          }
        }
      }
      if (failed) throw failure;
      return result;
    },
    async finish(): Promise<void> {
      const active = [...openStreams];
      const failures: unknown[] = [];
      for (const stream of active) {
        try { await stream.return(undefined); } catch (error) { failures.push(error); }
      }
      await state.transactionTail;
      closed = true;
      if (active.length > 0) {
        const error = new DatabaseScopeError("BRAID_STREAM_SCOPE", "A transaction callback must close its streams before completion.");
        if (failures.length > 0) throw new AggregateError([error, ...failures], "Transaction streams failed to close.", { cause: error });
        throw error;
      }
    },
    close(): void { closed = true; },
  };
  return database;
}
