import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CallQuery,
  Database,
  ExecutableQuery,
  ExecutionResultOf,
  PreparedQuery,
  Query,
  QueryExecutionResult,
  QueryExecutor,
  QueryResultKind,
  QueryRow,
  RoutineCallResult,
  RowQuery,
  RowValidationOptions,
  StandardSchemaV1,
  StreamOptions,
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
  readonly code: "BRAID_TX_SCOPE" | "BRAID_TX_CLOSED" | "BRAID_CONNECTION_POISONED";
  declare readonly cause?: unknown;

  constructor(code: "BRAID_TX_SCOPE" | "BRAID_TX_CLOSED" | "BRAID_CONNECTION_POISONED", message: string, cause?: unknown) {
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
  owner?: symbol;
  poisoned?: unknown;
}

interface DatabaseOptions {
  readonly transaction?: boolean;
  readonly preparedNames: Set<string>;
}

interface ScopedDatabase extends Database {
  close(): void;
}

function cleanupError(error: unknown, cleanup: unknown): AggregateError {
  return new AggregateError([error, cleanup], "Transaction failed and cleanup also failed.", { cause: error });
}

const transactionContext = new AsyncLocalStorage<{ readonly state: ScopeState; readonly owner: symbol }>();
const scopeStates = new WeakMap<object, ScopeState>();

function scopeStateFor(executor: QueryExecutor): ScopeState {
  const key = executor.ownershipKey ?? executor;
  let state = scopeStates.get(key);
  if (!state) {
    state = { tail: Promise.resolve() };
    scopeStates.set(key, state);
  }
  return state;
}

function isPoisoned(state: ScopeState): boolean {
  return Object.hasOwn(state, "poisoned");
}

function poison(state: ScopeState, reason: unknown): void {
  if (!isPoisoned(state)) state.poisoned = reason;
}

function assertHealthy(state: ScopeState): void {
  if (isPoisoned(state)) throw new DatabaseScopeError("BRAID_CONNECTION_POISONED", "The physical execution resource is poisoned and cannot accept new SQLBraid work.", state.poisoned);
}

function acquireRoot(state: ScopeState): Promise<() => void> {
  assertHealthy(state);
  const context = transactionContext.getStore();
  if (context?.state === state && state.owner === context.owner) throw new DatabaseScopeError("BRAID_TX_SCOPE", "The root database handle cannot be used from its own transaction callback.");
  const { promise: turn, resolve: release } = Promise.withResolvers<void>();
  const previous = state.tail;
  state.tail = previous.then(() => turn);
  return previous.then(() => {
    if (isPoisoned(state)) {
      release();
      assertHealthy(state);
    }
    return release;
  });
}

function malformedExecutionResult(): never {
  throw new TypeError("Executor returned a malformed query execution result.");
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
  if (
    candidate === null
    || typeof candidate !== "object"
    || Array.isArray(candidate)
  ) {
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

async function validateRows<Output>(
  rows: readonly unknown[],
  querySchema: StandardSchemaV1<unknown, Output> | undefined,
  executionSchema?: StandardSchemaV1<unknown, Output> | undefined,
): Promise<readonly Output[]> {
  const queryStandard = standardSchemaFor(querySchema);
  const executionStandard = standardSchemaFor(executionSchema);
  if (queryStandard === undefined && executionStandard === undefined) return rows as readonly Output[];
  const validated: Output[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const mapped = queryStandard === undefined
      ? rows[rowIndex]
      : await validateRow(queryStandard, rows[rowIndex], rowIndex, "query");
    validated.push(executionStandard === undefined
      ? mapped as Output
      : await validateRow(executionStandard, mapped, rowIndex, "execution"));
  }
  return validated;
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

export function createDatabase(executor: QueryExecutor): Database {
  return createScopedDatabase(executor, scopeStateFor(executor), { transaction: false, preparedNames: new Set<string>() });
}

function createScopedDatabase(executor: QueryExecutor, state: ScopeState, options: DatabaseOptions): ScopedDatabase {
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new DatabaseScopeError("BRAID_TX_CLOSED", "Transaction database is no longer usable.");
  };
  const acquireForUse = (): Promise<(() => void) | undefined> => {
    assertOpen();
    assertHealthy(state);
    return options.transaction ? Promise.resolve(undefined) : acquireRoot(state);
  };
  const executeOne = async <Q extends ExecutableQuery>(query: Q, mapQuery = true): Promise<QueryExecutionResult<unknown>> => {
    assertExecutableQuery(query);
    const result = assertExecutionResult(query, await executor.query<unknown>(query.render()));
    if (!mapQuery || result.kind !== "rows" || query.resultSchema === undefined) {
      return result;
    }
    return {
      ...result,
      rows: await validateRows(result.rows, query.resultSchema),
    };
  };
  const executeForUse = async <Q extends ExecutableQuery>(query: Q, mapQuery = true): Promise<QueryExecutionResult<unknown>> => {
    assertExecutableQuery(query);
    const release = await acquireForUse();
    try { return await executeOne(query, mapQuery); } finally { release?.(); }
  };
  const database: ScopedDatabase = {
    async execute<Q extends ExecutableQuery>(query: Q): Promise<ExecutionResultOf<Q>> {
      return await executeForUse(query) as ExecutionResultOf<Q>;
    },
    async call<Row>(query: CallQuery<Row>): Promise<RoutineCallResult<Row>> {
      if (query.resultKind !== "call") throw new TypeError("Only call queries may be executed with database.call().");
      const release = await acquireForUse();
      try {
        if (!executor.call) throw new Error("Executor does not support routine calls.");
        return await executor.call<Row>(query.render());
      } finally { release?.(); }
    },
    async all<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<readonly Row[]> {
      const result = await executeForUse(query, false);
      if (result.kind !== "rows") malformedExecutionResult();
      return validateRows(result.rows, query.resultSchema, options?.schema);
    },
    async one<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row> {
      const result = await executeForUse(query, false);
      if (result.kind !== "rows") malformedExecutionResult();
      const rows = result.rows;
      if (rows.length !== 1) throw new DatabaseCardinalityError("one", rows.length);
      const queryStandard = standardSchemaFor(query.resultSchema);
      const executionStandard = standardSchemaFor(options?.schema);
      const mapped = queryStandard === undefined ? rows[0] : await validateRow(queryStandard, rows[0], 0, "query");
      return executionStandard === undefined ? mapped as Row : validateRow(executionStandard, mapped, 0, "execution");
    },
    async maybeOne<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row | undefined> {
      const result = await executeForUse(query, false);
      if (result.kind !== "rows") malformedExecutionResult();
      const rows = result.rows;
      if (rows.length > 1) throw new DatabaseCardinalityError("maybeOne", rows.length);
      if (rows.length === 0) return undefined;
      const queryStandard = standardSchemaFor(query.resultSchema);
      const executionStandard = standardSchemaFor(options?.schema);
      const mapped = queryStandard === undefined ? rows[0] : await validateRow(queryStandard, rows[0], 0, "query");
      return executionStandard === undefined ? mapped as Row : validateRow(executionStandard, mapped, 0, "execution");
    },
    async batch<const Queries extends readonly ExecutableQuery[]>(queries: Queries): Promise<{ readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> }> {
      for (const query of queries) assertExecutableQuery(query);
      const release = await acquireForUse();
      try {
        const results: QueryExecutionResult<unknown>[] = [];
        for (const query of queries) results.push(await executeOne(query));
        return results as { readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> };
      } finally { release?.(); }
    },
    prepare<Row>(name: string, factory: () => RowQuery<Row>): PreparedQuery<Row> {
      if (!name.trim()) throw new Error("BRAID_PREPARED_NAME: prepared query name must not be empty.");
      if (options.preparedNames.has(name)) throw new Error(`BRAID_PREPARED_NAME: duplicate prepared query name ${name}.`);
      options.preparedNames.add(name);
      let shape: string | undefined;
      const current = (): RowQuery<Row> => {
        const query = factory();
        const rendered = query.render();
        const nextShape = `${query.resultKind}:${rendered.text}`;
        if (shape === undefined) shape = nextShape;
        else if (shape !== nextShape) throw new Error(`BRAID_PREPARED_SHAPE: prepared query ${name} changed its rendered structure.`);
        return query;
      };
      return {
        name,
        execute: async () => database.execute(current()),
        all: async (validationOptions?: RowValidationOptions<Row>) => database.all(current(), validationOptions),
        one: async (validationOptions?: RowValidationOptions<Row>) => database.one(current(), validationOptions),
        maybeOne: async (validationOptions?: RowValidationOptions<Row>) => database.maybeOne(current(), validationOptions),
      };
    },
    stream<Row>(query: RowQuery<Row>, options: StreamOptions<Row> = {}): AsyncIterable<Row> {
      assertOpen();
      assertHealthy(state);
      assertRowsQuery(query);
      const streamExecutor = executor.stream;
      if (!streamExecutor) throw new Error("BRAID_STREAM_UNSUPPORTED: this adapter does not expose a streaming protocol.");
      return (async function* (): AsyncGenerator<Row> {
        const release = await acquireForUse();
        try {
          const rendered = query.render();
          const source = streamExecutor<unknown>(rendered, options.signal);
          const queryStandard = standardSchemaFor(query.resultSchema);
          const executionStandard = standardSchemaFor(options.schema);
          let rowIndex = 0;
          for await (const row of source) {
            if (options.signal?.aborted) throw options.signal.reason ?? new Error("Stream aborted.");
            const mapped = queryStandard === undefined ? row : await validateRow(queryStandard, row, rowIndex, "query");
            const validated = executionStandard === undefined ? mapped : await validateRow(executionStandard, mapped, rowIndex, "execution");
            if (options.signal?.aborted) throw options.signal.reason ?? new Error("Stream aborted.");
            yield validated as Row;
            rowIndex += 1;
          }
        } finally { release?.(); }
      })();
    },
    async transaction<T>(callback: (transactionDatabase: Database) => Promise<T>): Promise<T> {
      assertOpen();
      assertHealthy(state);
      if (options.transaction) {
        if (!executor.savepoint || !executor.rollbackTo || !executor.releaseSavepoint) throw new DatabaseScopeError("BRAID_TX_SCOPE", "Nested transactions require savepoint support.");
        const name = `braid_sp_${Math.random().toString(36).slice(2)}`;
        try { await executor.savepoint(name); } catch (error) { poison(state, error); throw error; }
        const nested = createScopedDatabase(executor, state, { transaction: true, preparedNames: options.preparedNames });
        try {
          const result = await callback(nested);
          try { await executor.releaseSavepoint(name); } catch (error) { poison(state, error); throw error; }
          return result;
        } catch (error) {
          if (isPoisoned(state)) throw error;
          let cleanup: unknown;
          try { await executor.rollbackTo(name); } catch (failure) { cleanup = failure; }
          if (cleanup === undefined) {
            try { await executor.releaseSavepoint(name); } catch (failure) { cleanup = failure; }
          }
          if (cleanup !== undefined) {
            const combined = cleanupError(error, cleanup);
            poison(state, combined);
            throw combined;
          }
          throw error;
        } finally {
          nested.close();
        }
      }
      if (!executor.begin || !executor.commit || !executor.rollback) throw new Error("Executor does not support transactions.");
      const release = await acquireRoot(state);
      const transactionDatabase = createScopedDatabase(executor, state, { transaction: true, preparedNames: options.preparedNames });
      let begun = false;
      const owner = Symbol("sqlbraid.transaction");
      try {
        try { await executor.begin(); } catch (error) { poison(state, error); throw error; }
        begun = true;
        state.owner = owner;
        const result = await transactionContext.run({ state, owner }, () => callback(transactionDatabase));
        try { await executor.commit(); } catch (error) { poison(state, error); throw error; }
        return result;
      } catch (error) {
        if (!begun) throw error;
        if (isPoisoned(state)) throw error;
        try { await executor.rollback(); } catch (cleanup) {
          const combined = cleanupError(error, cleanup);
          poison(state, combined);
          throw combined;
        }
        throw error;
      } finally {
        transactionDatabase.close();
        state.owner = undefined;
        release();
      }
    },
    close(): void {
      closed = true;
    },
  };
  return database;
}
