import {
  createRenderedStatement,
  createRenderedBulk,
  ResultExactnessError,
  RoutineMappingError,
  safeDatabaseCount,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { preparedShape } from "./prepared-shape.js";
import { createAsyncContextStorage } from "#async-context";
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
  ExecutionObserver,
  ExecutionResultOf,
  PreparedFactoryOptions,
  PreparedQuery,
  PreparableQuery,
  Query,
  QueryExecutionResult,
  QueryExecutor,
  QueryResultKind,
  QueryReadyEvent,
  QueryRow,
  DriverRoutineResult,
  RoutineContract,
  RoutineMappingLocation,
  StatementBindingAdapter,
  StatementBindingDescription,
  RenderedBulk,
  RenderedStatement,
  RoutineCallResult,
  RowQuery,
  RowValidationOptions,
  RowsExecutionResult,
  StandardSchemaV1,
  StreamOptions,
  StreamStartEvent,
  TransactionOptions,
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
  static readonly codes = [
    "BRAID_TX_SCOPE",
    "BRAID_TX_CLOSED",
    "BRAID_SESSION_SCOPE",
    "BRAID_SESSION_CLOSED",
    "BRAID_CONNECTION_POISONED",
    "BRAID_STREAM_SCOPE",
    "BRAID_REENTRY",
    "BRAID_TX_OPTIONS_NESTED",
  ] as const;
  readonly code: (typeof DatabaseScopeError.codes)[number];
  declare readonly cause?: unknown;

  constructor(
    code: (typeof DatabaseScopeError.codes)[number],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseScopeError";
    this.code = code;
  }
}

export class DatabaseResultKindError extends Error {
  static readonly code = "BRAID_RESULT_KIND" as const;
  readonly code = DatabaseResultKindError.code;
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
  static readonly code = "BRAID_RESULT_VALIDATION" as const;
  readonly code = DatabaseResultValidationError.code;
  readonly issues: readonly StandardSchemaV1.Issue[];
  readonly rowIndex?: number;
  readonly stage: "query" | "execution";
  readonly location?: RoutineMappingLocation;

  constructor(
    issues: readonly StandardSchemaV1.Issue[],
    rowIndex?: number,
    stage: "query" | "execution" = "execution",
    location?: RoutineMappingLocation,
  ) {
    super("Database result validation failed.");
    this.name = "DatabaseResultValidationError";
    this.issues = issues;
    this.rowIndex = rowIndex;
    this.stage = stage;
    this.location = location;
  }
}

interface ScopeState {
  tail: Promise<void>;
  transactionTail: Promise<void>;
  streamUsers: number;
  pendingStreams?: number;
  directBusy?: boolean;
  activeScope?: symbol;
  activeSession?: symbol;
  poisoned?: unknown;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

type ScopeKind = "root" | "session" | "transaction";

interface RuntimeOptions extends DatabaseOptions {
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

interface TransactionContext {
  readonly rootState: ScopeState;
  readonly activity: { active: boolean };
  readonly parent?: TransactionContext;
}

interface SessionContext {
  readonly rootState: ScopeState;
  readonly activity: { active: boolean };
  readonly parent?: SessionContext;
}

interface PhysicalContext {
  readonly rootState: ScopeState;
  readonly direct: boolean;
  readonly stream: boolean;
}

interface OperationMeta {
  readonly operationId: string;
  readonly purpose?: "environment";
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
  readonly ownsLease: boolean;
  readonly release: (discard?: boolean) => Promise<void>;
}

class PreparationFailure extends Error {
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

class BatchAbortedError extends Error {
  readonly code = "BRAID_BATCH_ABORTED" as const;
  readonly batchId: string;
  declare readonly cause?: unknown;

  constructor(batchId: string, cause: unknown) {
    super("Batch operation was abandoned after an earlier batch operation failed.", { cause });
    this.name = "BatchAbortedError";
    this.batchId = batchId;
  }
}

const transactionContext = createAsyncContextStorage<TransactionContext>();
const sessionContext = createAsyncContextStorage<SessionContext>();
const physicalContext = createAsyncContextStorage<PhysicalContext>();
const scopeStates = new WeakMap<object, ScopeState>();
const environmentQueries = new WeakSet<object>();
let operationSequence = 0;
let transactionSequence = 0;

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value as T | PromiseLike<T>);
    reject = (reason) => rejectPromise(reason);
  });
  return { promise, resolve, reject };
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function runtimeEnvironment(): DatabaseEnvironment["runtime"] {
  const host = globalThis as typeof globalThis & {
    Deno?: { version?: { deno?: string } };
    Bun?: { version?: string };
    navigator?: { userAgent?: string };
  };
  if (host.Deno) return Object.freeze({ id: "deno", version: host.Deno.version?.deno });
  if (host.Bun) return Object.freeze({ id: "bun", version: host.Bun.version });
  if (host.navigator?.userAgent === "Cloudflare-Workers") return Object.freeze({ id: "workerd" });
  // Optional host reflection keeps Node globals/types out of the browser contract.
  const nodeVersion: unknown = Reflect.get(globalThis, "process")?.versions?.node;
  if (typeof nodeVersion === "string") {
    return Object.freeze({ id: "node", version: nodeVersion });
  }
  return Object.freeze({ id: "browser" });
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
  const { promise: turn, resolve: release } = deferred<void>();
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
      throw new DatabaseScopeError("BRAID_TX_SCOPE", "The root database handle cannot be used from its own transaction callback.");
    }
  }
  for (let session = sessionContext.getStore(); session; session = session.parent) {
    if (session.rootState === rootState && session.activity.active) {
      throw new DatabaseScopeError("BRAID_SESSION_SCOPE", "The root database handle cannot be used from its own session callback.");
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

function acquireDirectRoot(rootState: ScopeState, stream: boolean, reservedRootScope?: symbol): Promise<() => void> {
  assertHealthy(rootState);
  if (reservedRootScope === undefined) assertRootAllowed(rootState, stream);
  else if (rootState.activeScope !== reservedRootScope && rootState.activeSession !== reservedRootScope) {
    throw new DatabaseScopeError("BRAID_TX_SCOPE", "The root database handle cannot acquire its reserved physical resource.");
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

function signalReason(signal: AbortSignal): unknown {
  return signal.reason;
}

function capabilityStatus(
  resource: QueryExecutor | ConnectionProvider,
  key: string,
  fallback?: DatabaseEnvironment["capabilities"],
): "guaranteed" | "guarded" | "unsupported" | undefined {
  return resource.environment?.capabilities[key]?.status ?? fallback?.[key]?.status;
}

function assertExecutionOptions(
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

function assertTransactionOptions(value: unknown): asserts value is TransactionOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const error = new TypeError("BRAID_TX_OPTIONS_INVALID: transaction options must be an object.");
    Object.defineProperty(error, "code", { configurable: false, enumerable: true, value: "BRAID_TX_OPTIONS_INVALID" });
    throw error;
  }
  const options = value as { readonly isolation?: unknown; readonly readOnly?: unknown };
  for (const key of Object.keys(options)) {
    if (key !== "isolation" && key !== "readOnly") {
      const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: unknown transaction option ${key}.`);
      Object.defineProperty(error, "code", { configurable: false, enumerable: true, value: "BRAID_TX_OPTIONS_INVALID" });
      throw error;
    }
  }
  if (options.isolation !== undefined
    && options.isolation !== "read-uncommitted"
    && options.isolation !== "read-committed"
    && options.isolation !== "repeatable-read"
    && options.isolation !== "serializable") {
    const error = new TypeError("BRAID_TX_OPTIONS_INVALID: transaction isolation is not a supported SQLBraid isolation level.");
    Object.defineProperty(error, "code", { configurable: false, enumerable: true, value: "BRAID_TX_OPTIONS_INVALID" });
    throw error;
  }
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") {
    const error = new TypeError("BRAID_TX_OPTIONS_INVALID: transaction readOnly must be a boolean.");
    Object.defineProperty(error, "code", { configurable: false, enumerable: true, value: "BRAID_TX_OPTIONS_INVALID" });
    throw error;
  }
}

function assertSessionCapability(resource: QueryExecutor | ConnectionProvider, fallback?: DatabaseEnvironment["capabilities"]): void {
  if (capabilityStatus(resource, "session.pinned", fallback) === "unsupported") {
    throw new UnsupportedFeatureError(
      "session.pinned",
      "BRAID_SESSION_UNSUPPORTED",
      "The selected execution resource cannot pin a session.",
    );
  }
}

function assertFeatureCapability(
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

function assertTransactionCapability(
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

function malformedExecutionResult(): never {
  throw new TypeError("Executor returned a malformed query execution result.");
}

function addSafeCount(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    throw new ResultExactnessError("Database row count exceeds the safe JavaScript integer range.");
  }
  return left + right;
}

function assertBulkExecutionResult(value: unknown, expectedCount: number): BulkExecutionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Executor returned a malformed bulk execution result.");
  }
  const result = value as Partial<BulkExecutionResult>;
  const inputCount = result.inputCount;
  const executionMode = result.executionMode;
  if (typeof inputCount !== "number" || !Number.isSafeInteger(inputCount) || inputCount !== expectedCount
    || (executionMode !== "native-bulk"
      && executionMode !== "pipeline"
      && executionMode !== "prepared-loop"
      && executionMode !== "remote-batch")) {
    throw new TypeError("Executor returned a malformed bulk execution result.");
  }
  const affectedRows = result.affectedRows === undefined ? undefined : safeDatabaseCount(result.affectedRows);
  return {
    inputCount,
    ...(affectedRows === undefined ? {} : { affectedRows }),
    executionMode,
  };
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
      || binding.direction !== statement.parameters[offset].direction
      || binding.outputName !== statement.parameters[offset].outputName
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

function assertBulkBindingDescription(
  description: BulkBindingDescription,
  adapter: StatementBindingAdapter,
  bulk: RenderedBulk,
): BulkBindingDescription {
  const statement = bulk.statement;
  const validTransport = description !== null
    && typeof description === "object"
    && (description.transport === "native-value-template"
      || description.transport === "text-positional"
      || description.transport === "text-named"
      || description.transport === "typed-request");
  if (
    description === null
    || typeof description !== "object"
    || description.adapterId !== adapter.id
    || description.dialectId !== statement.dialectId
    || !validTransport
    || !Array.isArray(description.bindings)
    || description.bindings.length !== statement.parameters.length
    || description.itemCount !== bulk.parameterSets.length
    || typeof description.valuesAt !== "function"
    || typeof description.literalizedSql !== "function"
  ) {
    throw new TypeError("Statement binding adapter returned an invalid bulk description.");
  }
  if ((description.transport === "text-positional" || description.transport === "text-named")
    && (typeof description.parameterizedSql !== "string")) {
    throw new TypeError("BRAID_BIND_TRANSPORT: text bulk binding descriptions must provide parameterized SQL.");
  }
  for (const [offset, binding] of description.bindings.entries()) {
    if (
      binding === null
      || typeof binding !== "object"
      || binding.index !== offset + 1
      || binding.interpolation !== statement.parameters[offset].interpolation
      || binding.direction !== statement.parameters[offset].direction
      || binding.outputName !== statement.parameters[offset].outputName
    ) {
      throw new TypeError("Statement binding adapter returned misaligned bulk bindings.");
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
      throw new TypeError("Statement binding adapter returned misaligned bulk parameter hints.");
    }
    if (actualHint !== undefined && !Object.isFrozen(actualHint)) Object.freeze(actualHint);
    if (!Object.isFrozen(binding)) Object.freeze(binding);
  }
  if (!Object.isFrozen(description.bindings)) Object.freeze(description.bindings);
  if (!Object.isFrozen(description)) Object.freeze(description);
  return description;
}

function bulkShape(rendered: RenderedStatement): string {
  return preparedShape("command", rendered);
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

function resourceCleanupFailure(error: unknown): boolean {
  if (error instanceof Error && "code" in error && error.code === "BRAID_RESOURCE_CLEANUP") return true;
  return error instanceof AggregateError && error.errors.some(resourceCleanupFailure);
}

function assertDriverRoutineResult(value: unknown): asserts value is DriverRoutineResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) malformedRoutineResult();
  const result = value as Partial<DriverRoutineResult>;
  if (result.output === null || typeof result.output !== "object" || Array.isArray(result.output)) malformedRoutineResult();
  if (!Array.isArray(result.resultSets)) malformedRoutineResult();
  for (const resultSet of result.resultSets) {
    if (resultSet === null || typeof resultSet !== "object" || Array.isArray(resultSet) || !Array.isArray(resultSet.rows)) {
      malformedRoutineResult();
    }
    const source = resultSet.source;
    if (source === null || typeof source !== "object" || Array.isArray(source)
      || (source.kind !== "out-cursor" && source.kind !== "implicit" && source.kind !== "emitted")) {
      malformedRoutineResult();
    }
    if (source.kind !== "out-cursor"
      && (!Number.isInteger(source.index) || source.index < 0)) {
      malformedRoutineResult();
    }
  }
}

function malformedRoutineResult(): never {
  throw new TypeError("Executor returned a malformed routine execution result.");
}

function codedError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  Object.defineProperty(error, "code", { configurable: false, enumerable: true, value: code });
  return error;
}

function callRequiresTransaction(rendered: RenderedStatement): boolean {
  return rendered.parameters.some((parameter) => {
    const direction = parameter.direction;
    return (direction === "out" || direction === "inout")
      && parameter.hint?.databaseType.toLowerCase() === "refcursor";
  });
}

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

function executablePreparedOperation(operation: PreparedOperation<PreparableQuery>): PreparedOperation<ExecutableQuery> {
  const query = operation.query;
  assertExecutableQuery(query);
  return { ...operation, query };
}

function rowPreparedOperation(operation: PreparedOperation<PreparableQuery>): PreparedOperation<RowQuery<unknown>> {
  const query = operation.query;
  assertRowsQuery(query);
  return { ...operation, query };
}

function callPreparedOperation(operation: PreparedOperation<PreparableQuery>): PreparedOperation<CallQuery> {
  const query = operation.query;
  if (query.resultKind !== "call") throw new TypeError("Only call queries may be executed with prepared.call().");
  return { ...operation, query };
}

async function mapRoutineValue(
  schema: StandardSchemaV1<unknown, unknown>,
  value: unknown,
  location: RoutineMappingLocation,
): Promise<unknown> {
  try {
    const standard = standardSchemaFor(schema) as StandardSchemaV1.Props<unknown, unknown>;
    const result = await standard.validate(value);
    assertStandardSchemaResult(result);
    if (isStandardSchemaFailure(result)) {
      const rowIndex = location.kind === "result-set" ? location.rowIndex : undefined;
      throw new RoutineMappingError(
        `Routine ${location.kind === "result-set"
          ? `result set ${location.resultSetIndex}, row ${location.rowIndex}`
          : location.kind === "return-value" ? "return value" : "output"} failed validation.`,
        location,
        { cause: new DatabaseResultValidationError(result.issues, rowIndex, "query", location) },
      );
    }
    return result.value;
  } catch (error) {
    if (error instanceof RoutineMappingError) throw error;
    throw new RoutineMappingError(
      `Routine ${location.kind === "result-set"
        ? `result set ${location.resultSetIndex}, row ${location.rowIndex}`
        : location.kind === "return-value" ? "return value" : "output"} mapping failed.`,
      location,
      { cause: error },
    );
  }
}

function routineMappingRequested(contract: RoutineContract | undefined): boolean {
  return contract !== undefined
    && (contract.output !== undefined || contract.resultSets !== undefined || contract.returnValue !== undefined);
}

async function mapRoutineResult(
  raw: DriverRoutineResult,
  contract: RoutineContract | undefined,
): Promise<{ readonly value: RoutineCallResult; readonly rowCount: number; readonly mapped: boolean }> {
  assertDriverRoutineResult(raw);
  let rowCount = 0;
  for (const resultSet of raw.resultSets) rowCount = addSafeCount(rowCount, resultSet.rows.length);
  if (!routineMappingRequested(contract)) {
    const value = {
      output: raw.output,
      resultSets: raw.resultSets.map((resultSet) => ({ rows: resultSet.rows })),
      ...(Object.hasOwn(raw, "returnValue") ? { returnValue: raw.returnValue } : {}),
    };
    return { value, rowCount, mapped: false };
  }

  if (contract?.resultSets !== undefined && raw.resultSets.length !== contract.resultSets.length) {
    throw codedError("BRAID_CALL_RESULT_SETS",
      `Expected ${contract.resultSets.length} result sets, received ${raw.resultSets.length}.`,
    );
  }
  if (contract?.returnValue !== undefined && !Object.hasOwn(raw, "returnValue")) {
    throw codedError("BRAID_CALL_RETURN_UNSUPPORTED", "The routine did not expose a return/status channel.");
  }
  const output = contract?.output === undefined
    ? raw.output
    : await mapRoutineValue(contract.output, raw.output, { kind: "output" });
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new RoutineMappingError("Routine output schema must produce an object.", { kind: "output" });
  }
  const resultSets = [];
  for (let resultSetIndex = 0; resultSetIndex < raw.resultSets.length; resultSetIndex += 1) {
    const source = raw.resultSets[resultSetIndex];
    const schema = contract?.resultSets?.[resultSetIndex];
    if (schema === undefined) {
      resultSets.push({ rows: source.rows });
      continue;
    }
    const rows: unknown[] = [];
    for (let rowIndex = 0; rowIndex < source.rows.length; rowIndex += 1) {
      rows.push(await mapRoutineValue(schema, source.rows[rowIndex], { kind: "result-set", resultSetIndex, rowIndex }));
    }
    resultSets.push({ rows });
  }
  const value = {
    output: output as Readonly<Record<string, unknown>>,
    resultSets,
    ...(Object.hasOwn(raw, "returnValue") ? {
      returnValue: contract?.returnValue === undefined ? raw.returnValue
        : await mapRoutineValue(contract.returnValue, raw.returnValue, { kind: "return-value" }),
    } : {}),
  };
  return { value, rowCount, mapped: true };
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
  const rowCount = result.rowCount === undefined ? undefined : safeDatabaseCount(result.rowCount);
  if (result.kind === "rows") {
    return rowCount === result.rowCount ? result : { ...result, rowCount };
  }
  if (result.command.insertId !== undefined && typeof result.command.insertId !== "string") {
    throw new ResultExactnessError("Database insertId must be represented as an exact string.");
  }
  const affectedRows = result.command.affectedRows === undefined
    ? undefined
    : safeDatabaseCount(result.command.affectedRows);
  if (rowCount === result.rowCount && affectedRows === result.command.affectedRows) return result;
  return {
    ...result,
    ...(rowCount === undefined ? {} : { rowCount }),
    command: {
      ...result.command,
      ...(affectedRows === undefined ? {} : { affectedRows }),
    },
  };
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

async function notifyErrorObservers(
  observers: readonly ExecutionObserver[],
  event: ExecutionEvent,
): Promise<unknown[]> {
  if (observers.length === 0) return [];
  const failures: unknown[] = [];
  const immutable = frozenEvent(event);
  for (const observer of observers) {
    try {
      await observer.onEvent(immutable);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function notifyError(
  observers: readonly ExecutionObserver[],
  event: ExecutionEvent,
  original: unknown,
): Promise<never> {
  const failures = await notifyErrorObservers(observers, event);
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

function bulkReadyEvent(
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

function queryResultEvent(operation: RawOperation<ExecutableQuery>, result: QueryExecutionResult<unknown>): ExecutionEvent {
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

function queryMappedEvent(operation: RawOperation<ExecutableQuery>, rowCount: number, queryMapped: boolean, executionMapped: boolean, durationMs: number): ExecutionEvent {
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

function errorEvent(operation: { readonly meta: OperationMeta }, error: unknown, stage: QueryErrorEventStage, started: boolean, completed: boolean, durationMs?: number): ExecutionEvent {
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
    scopeKind: "root",
    capabilities: executor.environment?.capabilities,
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
    scopeKind: "root",
    capabilities: provider.environment?.capabilities,
    preparedNames: new Set<string>(),
    rootState,
    pooled: true,
    depth: 0,
  });
}

function createScopedDatabase(executor: QueryExecutor | ConnectionProvider, state: ScopeState, options: RuntimeOptions): Database & { close(): void; finish(): Promise<void> } {
  let closed = false;
  let environmentSnapshot: Omit<DatabaseEnvironment, "supportMatch"> | undefined;
  const statementBinding = bindingAdapterFor(executor);
  const openStreams = new Set<AsyncGenerator<unknown>>();
  const assertOpen = (): void => {
    if (closed) {
      throw new DatabaseScopeError(
        options.scopeKind === "session" ? "BRAID_SESSION_CLOSED" : "BRAID_TX_CLOSED",
        options.scopeKind === "session" ? "Session database is no longer usable." : "Transaction database is no longer usable.",
      );
    }
    if (options.scopeKind === "transaction" && state.activeScope !== options.scope) {
      throw new DatabaseScopeError("BRAID_TX_SCOPE", "Use the innermost transaction database while its savepoint is active.");
    }
    if (options.scopeKind === "session" && options.transaction && options.transactionScope !== state.activeScope) {
      throw new DatabaseScopeError("BRAID_TX_SCOPE", "Use the innermost transaction database while its savepoint is active.");
    }
    if (options.scopeKind === "session" && !options.transaction && state.activeScope !== undefined) {
      throw new DatabaseScopeError("BRAID_TX_SCOPE", "Use the innermost transaction database while its transaction is active.");
    }
    if (options.scopeKind === "session" && state.activeSession !== options.scope) {
      throw new DatabaseScopeError("BRAID_SESSION_SCOPE", "Use the innermost session database while its nested scope is active.");
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
      const hasStream = pinned.physicalState.streamUsers > 0 || (pinned.physicalState.pendingStreams ?? 0) > (stream ? 1 : 0);
      if (hasStream || (active?.rootState === options.rootState && active.direct)) {
        if (hasStream) {
          throw new DatabaseScopeError("BRAID_STREAM_SCOPE", "A pinned stream cannot re-enter its physical execution resource.");
        }
        throw new DatabaseScopeError("BRAID_REENTRY", "A pinned execution resource cannot execute concurrent physical work.");
      }
      const releaseTurn = await acquireTransactionTurn(pinned.physicalState);
      try { assertOpen(); assertHealthy(pinned.physicalState); }
      catch (error) { releaseTurn(); throw error; }
      if (pinned.executor.statementBinding !== expectedBinding) {
        releaseTurn();
        throw bindingIdentityMismatch();
      }
      return {
        executor: pinned.executor,
        physicalState: pinned.physicalState,
        direct: pinned.direct,
        ownsLease: false,
        release: async () => { releaseTurn(); },
      };
    }
    if (options.transaction) {
      const lease = options.lease;
      if (!lease || !options.leaseState) throw new DatabaseScopeError("BRAID_TX_CLOSED", "Transaction database is no longer usable.");
      const active = physicalContext.getStore();
      const hasStream = options.leaseState.streamUsers > 0 || (options.leaseState.pendingStreams ?? 0) > (stream ? 1 : 0);
      if (hasStream || (active?.rootState === options.rootState && active.direct)) {
        if (hasStream) {
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
      return { executor: lease, physicalState: options.leaseState, direct: true, ownsLease: false, release: async () => { releaseTurn(); } };
    }
    if (reservedRootScope === undefined) assertRootAllowed(options.rootState, stream);
    else if (options.rootState.activeScope !== reservedRootScope && options.rootState.activeSession !== reservedRootScope) {
      throw new DatabaseScopeError("BRAID_TX_SCOPE", "The root database handle cannot acquire its reserved physical resource.");
    }
    if (!options.pooled) {
      const release = await acquireDirectRoot(state, stream, reservedRootScope);
      return { executor: executor as QueryExecutor, physicalState: state, direct: true, ownsLease: false, release: async () => { release(); } };
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
      ownsLease: true,
      release: async (discard = false) => { await lease.release(discard ? { discard: true } : undefined); },
    };
  };
  const acquireSessionResource = async (reservedRootSession?: symbol): Promise<Use> => {
    assertOpen();
    assertHealthy(state);
    if (reservedRootSession === undefined) assertRootAllowed(options.rootState, false);
    else if (options.rootState.activeSession !== reservedRootSession) {
      throw new DatabaseScopeError("BRAID_SESSION_SCOPE", "The root database handle cannot acquire its reserved session resource.");
    }
    assertSessionCapability(executor, options.capabilities);
    if (!options.pooled) {
      const release = await acquireDirectRoot(state, false, reservedRootSession);
      return {
        executor: executor as QueryExecutor,
        physicalState: state,
        direct: true,
        ownsLease: true,
        release: async () => { release(); },
      };
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
    if (lease.statementBinding !== statementBinding) {
      let releaseError: unknown;
      try { await lease.release({ discard: true }); } catch (error) { releaseError = error; }
      const mismatch = bindingIdentityMismatch();
      if (releaseError !== undefined) throw new AggregateError([mismatch, releaseError], "Binding identity mismatch and lease cleanup failed.", { cause: mismatch });
      throw mismatch;
    }
    try {
      assertSessionCapability(lease, options.capabilities);
    } catch (error) {
      try { await lease.release({ discard: true }); } catch (releaseError) {
        throw new AggregateError([error, releaseError], "Session capability check and lease cleanup failed.", { cause: error });
      }
      throw error;
    }
    const leaseState = scopeStateFor(lease);
    try {
      assertHealthy(leaseState);
    } catch (error) {
      try { await lease.release({ discard: true }); } catch (releaseError) {
        throw new AggregateError([error, releaseError], "Poisoned lease cleanup failed.", { cause: error });
      }
      throw error;
    }
    return {
      executor: lease,
      physicalState: leaseState,
      direct: false,
      ownsLease: true,
      release: async (discard = false) => { await lease.release(discard ? { discard: true } : undefined); },
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
    const requestedReuse = options.reuse === "simple"
      ? "simple"
      : preparedName === undefined ? (options.reuse ?? "auto") : "reuse";
    let binding: StatementBindingDescription;
    try {
      binding = assertBindingDescription(adapter.describe(rendered, {
        dialectId: rendered.dialectId,
        requestedReuse,
        preparedName,
        transactionScoped: options.transaction,
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
    return {
      query, rendered, binding,
      meta: {
        ...metadata(options, operationId, preparedName, batchId),
        ...(environmentQueries.has(query) ? { purpose: "environment" as const } : {}),
      },
    };
  };
  const observePrepared = async <Q extends Query<unknown, QueryResultKind>>(operation: PreparedOperation<Q>): Promise<void> => {
    try {
      await notify(options.observers ?? [], queryReadyEvent(operation));
    } catch (error) {
      await notifyError(options.observers ?? [], errorEvent(operation, error, "observer-before", false, false), error);
    }
  };
  const prepareObserved = async <Q extends Query<unknown, QueryResultKind>>(query: Q, preparedName?: string, batchId?: string): Promise<PreparedOperation<Q>> => {
    const operationId = nextOperationId();
    let operation: PreparedOperation<Q>;
    try {
      operation = prepare(query, preparedName, batchId, undefined, operationId);
    } catch (error) {
      const failure = error instanceof PreparationFailure ? error : undefined;
      const reported = failure === undefined ? error : failure.cause;
      await notifyError(
        options.observers ?? [],
        errorEvent({ meta: {
          ...metadata(options, operationId, preparedName, batchId),
          ...(environmentQueries.has(query) ? { purpose: "environment" as const } : {}),
        } }, reported, failure?.stage ?? "render", false, false),
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
      const error = codedError("BRAID_PREPARED_SHAPE", `Prepared query ${preparedName} changed its rendered structure.`);
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
      const original = releaseFailed ? new AggregateError([raw.driverError, releaseError], "Execution and lease release failed.", { cause: raw.driverError }) : raw.driverError;
      const stage = releaseFailed ? "release" : "driver";
      await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, original, stage, true, false, raw.durationMs), original);
    }
    if (releaseFailed) {
      await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, releaseError, "release", true, true, raw.durationMs), releaseError);
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
    return materializedPreparedResult(await prepareObserved(query, preparedName, batchId), executionSchema, executionOptions);
  };
  const executeNamed = async <Q extends ExecutableQuery>(
    query: Q,
    preparedName?: string,
    executionOptions?: ExecutionOptions,
  ): Promise<ExecutionResultOf<Q>> => await materializedResult(query, preparedName, undefined, undefined, executionOptions) as ExecutionResultOf<Q>;
  const allNamed = async <Row>(query: RowQuery<Row>, validationOptions?: RowValidationOptions<Row>, preparedName?: string): Promise<readonly Row[]> => {
    const result = await materializedResult(query, preparedName, validationOptions?.schema, undefined, validationOptions);
    if (result.kind !== "rows") malformedExecutionResult();
    return result.rows as readonly Row[];
  };
  const oneNamed = async <Row>(query: RowQuery<Row>, validationOptions?: RowValidationOptions<Row>, preparedName?: string): Promise<Row> => {
    const raw = await runMaterialized(query, preparedName, undefined, validationOptions);
    const result = await finalizePhysical(raw);
    if (result.kind !== "rows") malformedExecutionResult();
    if (result.rows.length !== 1) {
      const error = new DatabaseCardinalityError("one", result.rows.length);
      await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs), error);
    }
    return await processOne(raw, result, validationOptions?.schema) as Row;
  };
  const maybeOneNamed = async <Row>(query: RowQuery<Row>, validationOptions?: RowValidationOptions<Row>, preparedName?: string): Promise<Row | undefined> => {
    const raw = await runMaterialized(query, preparedName, undefined, validationOptions);
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
            const observedCapabilities = options.pooled && !options.transaction
              ? Object.fromEntries(Object.entries(observed.capabilities).map(([id, capability]) => [
                id,
                capability.status === "guaranteed"
                  ? { ...capability, status: "guarded" as const }
                  : capability,
              ]))
              : observed.capabilities;
            capabilities = { ...capabilities, ...observedCapabilities };
          }
        }
        environmentSnapshot = Object.freeze({
          database: Object.freeze({ ...databaseInfo }),
          driver: Object.freeze({ ...(descriptor?.driver ?? { id: statementBinding.id }) }),
          runtime: runtimeEnvironment(),
          ...(descriptor?.typePolicy === undefined
            ? {}
            : { typePolicy: Object.freeze({ ...descriptor.typePolicy }) }),
          capabilities: Object.freeze(Object.fromEntries(
            Object.entries(capabilities).map(([id, capability]) => [
              id,
              Object.freeze({
                ...capability,
                ...(capability.rawRepresentations ? { rawRepresentations: Object.freeze([...capability.rawRepresentations]) } : {}),
              }),
            ]),
          )),
        });
        // A pooled probe describes one acquired lease, not every future lease.
        // Refresh replaces this scope's snapshot, while observed guarantees are
        // guarded above so the snapshot cannot claim pool-wide certainty.
      }
      const evidence = environmentSnapshot!;
      const matches = (environmentOptions.targets ?? []).filter((target) =>
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
    async execute<Q extends ExecutableQuery>(query: Q, executionOptions?: ExecutionOptions): Promise<ExecutionResultOf<Q>> {
      return await executeNamed(query, undefined, executionOptions);
    },
    async call<Result extends RoutineCallResult>(
      query: CallQuery<Result>,
      executionOptions?: ExecutionOptions,
      preparedOperation?: PreparedOperation<CallQuery<Result>>,
    ): Promise<Result> {
      assertOpen();
      if (query.resultKind !== "call") throw new TypeError("Only call queries may be executed with database.call().");
      const operation = preparedOperation ?? await prepareObserved(query);
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
      } catch (error) {
        await notifyError(options.observers ?? [], errorEvent(operation, error, "materialize", false, false), error);
      }
      try {
        if (query.routineContract?.returnValue !== undefined) {
          assertFeatureCapability(
            executor,
            "routine.return-value",
            "BRAID_CALL_RETURN_UNSUPPORTED",
            "The selected execution resource does not expose a routine return/status channel.",
            options.capabilities,
          );
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
        try { await use!.release(); } catch (failure) { releaseError = failure; poison(use!.physicalState, failure); }
        const reported = releaseError === undefined ? error : new AggregateError([error, releaseError], "Call and lease release failed.", { cause: error });
        await notifyError(options.observers ?? [], errorEvent(operation, reported, releaseError === undefined ? "driver" : "release", false, false), reported);
      }
      const started = now();
      let value!: DriverRoutineResult;
      let released = false;
      try {
        value = await physicalContext.run(
          { rootState: options.rootState, direct: use!.direct, stream: false },
          () => use!.executor.call!(operation.rendered, operation.binding, executionOptions),
        );
      } catch (error) {
        if (resourceCleanupFailure(error)) poison(use!.physicalState, error);
        let releaseError: unknown;
        try { await use!.release(isPoisoned(use!.physicalState)); } catch (failure) { releaseError = failure; poison(use!.physicalState, failure); }
        released = true;
        const original = releaseError === undefined ? error : new AggregateError([error, releaseError], "Execution and lease release failed.", { cause: error });
        await notifyError(options.observers ?? [], errorEvent(operation, original, releaseError === undefined ? "driver" : "release", true, false, now() - started), original);
      }
      let releaseError: unknown;
      if (!released) {
        try { await use!.release(isPoisoned(use!.physicalState)); } catch (error) {
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
        const reported = resultValidationError !== undefined && releaseError !== undefined
          ? new AggregateError([resultValidationError, releaseError], "Routine execution and lease release failed.", { cause: resultValidationError })
          : original;
        await notifyError(
          options.observers ?? [],
          errorEvent(operation, reported, releaseError === undefined ? "result-kind" : "release", true, true, now() - started),
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
        await notifyError(options.observers ?? [], errorEvent(operation, error, "observer-after", true, true, now() - started), error);
      }
      let mapped: { readonly value: RoutineCallResult; readonly rowCount: number; readonly mapped: boolean };
      try {
        mapped = await mapRoutineResult(value, query.routineContract);
      } catch (error) {
        await notifyError(options.observers ?? [], errorEvent(operation, error, "query-map", true, true, now() - started), error);
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
        await notifyError(options.observers ?? [], errorEvent(operation, error, "observer-after", true, true, now() - started), error);
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
          if (query === null || typeof query !== "object" || query.resultKind !== "command" || typeof query.render !== "function") {
            throw codedError("BRAID_BULK_SHAPE", "db.bulk() factory must return a command query.");
          }
          let rendered: RenderedStatement;
          try {
            rendered = createRenderedStatement(query.render());
          } catch (error) {
            throw new PreparationFailure("render", error);
          }
          if (rendered.resultKind !== "command") {
            throw codedError("BRAID_BULK_SHAPE", `Bulk input ${index} rendered a ${rendered.resultKind} statement instead of a command.`);
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
        const stage = failure?.stage ?? (reported instanceof Error && reported.message.startsWith("BRAID_BULK_SHAPE:")
          ? "prepared"
          : "materialize");
        await notifyError(options.observers ?? [], errorEvent({ meta: bulkMeta }, reported, stage, false, false), reported);
        throw reported;
      }

      try {
        await notify(options.observers ?? [], bulkReadyEvent(operationId, bulk!, binding!, bulkMeta));
      } catch (error) {
        await notifyError(options.observers ?? [], errorEvent({ meta: bulkMeta }, error, "observer-before", false, false), error);
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
        await notifyError(options.observers ?? [], errorEvent({ meta: bulkMeta }, error, "materialize", false, false), error);
      }
      if (!options.pooled && typeof (executor as QueryExecutor).bulk !== "function") {
        const error = new UnsupportedFeatureError(
          "statement.bulk",
          "BRAID_BULK_UNSUPPORTED",
          "The selected execution resource does not expose a bulk protocol.",
        );
        await notifyError(options.observers ?? [], errorEvent({ meta: bulkMeta }, error, "materialize", false, false), error);
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
        const reported = cleanupFailure === undefined
          ? unsupported
          : new AggregateError([unsupported, cleanupFailure], "Bulk capability check and lease release failed.", { cause: unsupported });
        await notifyError(options.observers ?? [], errorEvent({ meta: bulkMeta }, reported, cleanupFailure === undefined ? "materialize" : "release", false, false), reported);
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
          reportedFailure = reportedFailure === undefined
            ? error
            : new AggregateError([reportedFailure, error], "Bulk execution and lease release failed.", { cause: reportedFailure });
        }
      }
      if (hasReportedFailure) {
        throw reportedFailure;
      }
      let result: BulkExecutionResult;
      try {
        result = assertBulkExecutionResult(physicalResult, inputs.length);
      } catch (error) {
        await notifyError(options.observers ?? [], errorEvent({ meta: bulkMeta }, error, "result-kind", true, true, now() - started), error);
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
        await notifyError(options.observers ?? [], errorEvent({ meta: bulkMeta }, error, "observer-after", true, true, now() - started), error);
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
        return notifyErrorObservers(
          options.observers ?? [],
          errorEvent(entry.operation, error, stage, executionStarted, executionCompleted, durationMs),
        );
      };
      const batchFailure = (original: unknown, failures: readonly unknown[]): unknown => failures.length === 0
        ? original
        : new AggregateError(
          [original, ...failures],
          "Batch execution failed and error observers also failed.",
          { cause: original },
        );
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
          failures.push(...await observerFailures(entry, error, stage, started, completed, entry.raw?.durationMs));
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
        const failures = first === undefined
          ? []
          : await observerFailures(first, error, stage, false, false);
        failures.push(...await abortEntries(error, stage, first));
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
        try { await use.release(isPoisoned(use.physicalState)); } catch (error) { batchReleaseError = error; batchReleaseFailed = true; poison(use.physicalState, error); }
      }

      const firstFailure = driverFailure;
      if (firstFailure !== undefined || batchReleaseFailed) {
        const target = firstFailure?.entry
          ?? [...entries].reverse().find((entry) => entry.raw !== undefined)
          ?? entries[0];
        if (target === undefined) {
          throw batchFailure(firstFailure?.error ?? batchReleaseError, []);
        }
        const raw = target.raw;
        const original = firstFailure === undefined
          ? batchReleaseError
          : batchReleaseFailed
            ? new AggregateError(
              [firstFailure.error, batchReleaseError],
              "Batch execution and lease release failed.",
              { cause: firstFailure.error },
            )
            : firstFailure.error;
        const stage: QueryErrorEventStage = firstFailure === undefined
          ? "release"
          : batchReleaseFailed ? "release" : "driver";
        const failures = await observerFailures(
          target,
          original,
          stage,
          raw !== undefined,
          raw !== undefined && !raw.driverFailed,
          raw?.durationMs,
        );
        failures.push(...await abortEntries(original, stage, target));
        throw batchFailure(original, failures);
      }

      const output: QueryExecutionResult<unknown>[] = [];
      for (const entry of entries) {
        const raw = entry.raw;
        if (raw === undefined) {
          const original = new BatchAbortedError(batchId, new Error("Batch operation did not reach physical execution."));
          const failures = await observerFailures(entry, original, "driver", false, false);
          failures.push(...await abortEntries(original, "driver", entry));
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
      if (options.preparedNames.has(name)) throw codedError("BRAID_PREPARED_NAME", `duplicate prepared query name ${name}.`);
      const shape: { value?: string } = {};
      if (
        prepareOptions !== undefined
        && prepareOptions.input !== "none"
        && prepareOptions.input !== "required"
      ) {
        throw new TypeError("Prepared input mode must be either \"none\" or \"required\".");
      }
      options.preparedNames.add(name);
      const takesInput = prepareOptions?.input !== "none";
      const invocation = (args: readonly unknown[]): {
        readonly options?: ExecutionOptions;
      } => ({
        options: (takesInput ? args[1] : args[0]) as ExecutionOptions | undefined,
      });
      const operation = async (args: readonly unknown[]): Promise<PreparedOperation<PreparableQuery>> => {
        assertOpen();
        const invoke = takesInput
          ? () => factory(args[0] as never)
          : () => factory();
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
            await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs), error);
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
            await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "cardinality", true, true, raw.durationMs), error);
          }
          if (result.rows.length === 0) {
            try {
              await notify(options.observers ?? [], queryMappedEvent(
                raw as RawOperation<ExecutableQuery>,
                0,
                raw.query.resultSchema !== undefined,
                (current.options as RowValidationOptions<unknown> | undefined)?.schema !== undefined,
                0,
              ));
            } catch (error) {
              await notifyError(options.observers ?? [], errorEvent(raw as RawOperation<ExecutableQuery>, error, "observer-after", true, true, raw.durationMs), error);
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
              await notifyError(options.observers ?? [], errorEvent(operationResult, error, "prepared", false, false), error);
            }
            let preparedStream: AsyncIterable<unknown>;
            try {
              preparedStream = database.stream(
                preparedOperation!.query,
                current.options as StreamOptions<unknown> | undefined,
                preparedOperation!,
              );
            } catch (error) {
              await notifyError(options.observers ?? [], errorEvent(operationResult, error, "stream", false, false), error);
            }
            yield* preparedStream!;
          })();
        },
        call: async (...args: unknown[]) => {
          const current = invocation(args);
          const preparedOperation = callPreparedOperation(await operation(args));
          return database.call(
            preparedOperation.query,
            current.options,
            preparedOperation,
          );
        },
      };
      return prepared as PreparedQuery<Parameters<Factory> extends [] ? never : Parameters<Factory>[0], ReturnType<Factory>>;
    },
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
          operation = preparedOperation === undefined
              ? prepare(query, undefined, undefined, undefined, operationId) as PreparedOperation<ExecutableQuery>
              : preparedOperation as PreparedOperation<ExecutableQuery>;
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
        const admissionState = options.pinned?.physicalState ?? (options.transaction || !options.pooled ? state : undefined);
        if (admissionState) admissionState.pendingStreams = (admissionState.pendingStreams ?? 0) + 1;
        let use: Use;
        try {
          try {
            await notify(options.observers ?? [], streamStartEvent(operation));
          } catch (error) {
            openStreams.delete(stream);
            await notifyError(options.observers ?? [], errorEvent(operation, error, "observer-before", false, false), error);
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
          const source = physicalContext.run(
            activeContext,
            () => use!.executor.stream!(operation.rendered, operation.binding, streamOptions),
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
            if (next.done) {
              if (streamOptions.signal?.aborted) throw streamOptions.signal.reason;
              break;
            }
            const row = next.value;
            if (streamOptions.signal?.aborted) throw streamOptions.signal.reason;
            let mapped: unknown = row;
            if (queryStandard !== undefined) {
              try { mapped = await physicalContext.run(activeContext, () => validateRow(queryStandard!, row, count, "query")); }
              catch (error) { errorAlreadyReported = true; await notifyError(options.observers ?? [], errorEvent(operation, error, "query-map", true, true, now() - started), error); }
            }
            if (executionStandard !== undefined) {
              try { mapped = await physicalContext.run(activeContext, () => validateRow(executionStandard!, mapped, count, "execution")); }
              catch (error) { errorAlreadyReported = true; await notifyError(options.observers ?? [], errorEvent(operation, error, "execution-map", true, true, now() - started), error); }
            }
            if (streamOptions.signal?.aborted) throw streamOptions.signal.reason;
            count = addSafeCount(count, 1);
            yield mapped as Row;
          }
        } catch (error) {
          streamError = error;
          streamFailed = true;
          if (resourceCleanupFailure(error)) poison(use!.physicalState, error);
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
            try { await scoped.finish(); } catch (closing) {
              if (closing !== error) {
                failure = new AggregateError([error, closing], "Session failed and stream cleanup also failed.", { cause: error });
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
          try { await use.release(isPoisoned(physicalState)); }
          catch (error) {
            poison(physicalState, error);
            failed = true;
            failure = failure === undefined ? error : new AggregateError([failure, error], "Session failed and lease release also failed.", { cause: failure });
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
      const callback = (hasOptions ? maybeCallback : callbackOrOptions) as ((database: Database) => Promise<T>) | undefined;
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
        assertTransactionCapability(executor, transactionOptions, options.capabilities);
      }
      const pinnedStreamState = options.pinned?.physicalState ?? (nested ? state : undefined);
      if (pinnedStreamState && (pinnedStreamState.streamUsers > 0 || (pinnedStreamState.pendingStreams ?? 0) > 0)) {
        throw new DatabaseScopeError("BRAID_STREAM_SCOPE", "Close the pinned stream before opening a transaction or savepoint.");
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
      const reservedRootTransaction = !nested && options.scopeKind === "root" && transactionContext.conservative
        ? scope
        : undefined;
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
      const combine = (original: unknown, errors: readonly unknown[]): unknown => errors.length === 0 ? original
        : new AggregateError([original, ...errors], "Transaction failed and cleanup also failed.", { cause: original });
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
          }
          catch (error) {
            try { await transactionEvent(observers, transactionId, "begin", "failed", depth, undefined, undefined, error); }
            catch (reporting) { throw combine(error, [reporting]); }
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
        if (hasOptions) assertTransactionCapability(resource, transactionOptions, options.capabilities);
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
          const control = async (
            phase: Extract<ExecutionEvent, { type: "transaction" }>["phase"],
            action: () => Awaitable<void>,
            cleanup = false,
            requested = true,
          ): Promise<void> => {
            const errors: unknown[] = [];
            const start = now();
            if (requested) {
              try { await transactionEvent(observers, transactionId, phase, "requested", depth, undefined, savepointName); }
              catch (error) { if (!cleanup) throw error; errors.push(error); }
            }
            if (!cleanup && (phase === "begin" || phase === "savepoint")
              && (physicalState.streamUsers > 0 || (physicalState.pendingStreams ?? 0) > 0)) {
              throw new DatabaseScopeError("BRAID_STREAM_SCOPE", "Close the pinned stream before opening a transaction or savepoint.");
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
              else if (transactionOptions === undefined) await resource.begin!();
              else await resource.begin!(transactionOptions);
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
        if (!nested && options.scopeKind === "root") options.rootState.activeScope = previousRootScope;
        if (use && !nested && use.ownsLease) {
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
      closed = true;
      const failures: unknown[] = [];
      for (const stream of active) {
        try { await stream.return(undefined); } catch (error) { failures.push(error); }
        finally { openStreams.delete(stream); }
      }
      await state.transactionTail;
      if (active.length > 0) {
        const scopeName = options.scopeKind === "session" ? "session" : "transaction";
        const error = new DatabaseScopeError("BRAID_STREAM_SCOPE", `A ${scopeName} callback must close its streams before completion.`);
        if (failures.length > 0) throw new AggregateError([error, ...failures], "Transaction streams failed to close.", { cause: error });
        throw error;
      }
    },
    close(): void { closed = true; },
  };
  return {
    ...database,
    stream<Row>(query: RowQuery<Row>, streamOptions?: StreamOptions<Row>): AsyncIterable<Row> {
      return database.stream(query, streamOptions);
    },
    call<Result extends RoutineCallResult>(query: CallQuery<Result>, executionOptions?: ExecutionOptions): Promise<Result> {
      return database.call(query, executionOptions);
    },
  };
}
