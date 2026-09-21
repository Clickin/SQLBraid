import type { RequestedReuse } from "./binding.js";
import type { DatabaseEnvironment, EnvironmentOptions } from "./environment.js";
import type { ExecutionObserver } from "./observers.js";
import type {
  CallQuery,
  CommandExecutionResult,
  CommandQuery,
  ExecutionOptions,
  Query,
  QueryExecutionResult,
  RowQuery,
  RowValidationOptions,
  RowsExecutionResult,
  StreamOptions,
  TransactionOptions,
} from "./query.js";
import type { QueryResultKind } from "./template-ir.js";
import type { RoutineCallResult } from "./routine.js";

/** Root database behavior: observers and default prepared-reuse preference. */
export interface DatabaseOptions {
  readonly observers?: readonly ExecutionObserver[];
  readonly reuse?: RequestedReuse;
}

export type PreparableQuery = ExecutableQuery | CallQuery;

export type PreparedFactoryOptions = { readonly input: "none" } | { readonly input: "required" };

export type PreparedArguments<Input, Options> = [Input] extends [never]
  ? [options?: Options]
  : [input: Input, options?: Options];

/** Prepared handle whose input arity and result helpers are fixed by the factory's query kind. */
export type PreparedQuery<Input, Q extends PreparableQuery> = {
  readonly name: string;
} & (Q extends CallQuery<infer Result>
  ? { call(...args: PreparedArguments<Input, ExecutionOptions>): Promise<Result> }
  : {
      execute(...args: PreparedArguments<Input, ExecutionOptions>): Promise<ExecutionResultOf<Q>>;
    } & (Q extends RowQuery<infer Row>
      ? {
          all(...args: PreparedArguments<Input, RowValidationOptions<Row>>): Promise<readonly Row[]>;
          one(...args: PreparedArguments<Input, RowValidationOptions<Row>>): Promise<Row>;
          maybeOne(...args: PreparedArguments<Input, RowValidationOptions<Row>>): Promise<Row | undefined>;
          stream(...args: PreparedArguments<Input, StreamOptions<Row>>): AsyncIterable<Row>;
        }
      : {}));

export type ExecutableQuery = RowQuery<unknown> | Query<unknown, "command"> | Query<unknown, "unknown">;

export type ExecutionResultOf<Q> =
  Q extends RowQuery<infer Row>
    ? RowsExecutionResult<Row>
    : Q extends Query<unknown, "command">
      ? CommandExecutionResult
      : Q extends Query<infer Row, "unknown">
        ? QueryExecutionResult<Row>
        : never;

/**
 * Async application database surface.
 * Root pooled operations acquire/release per operation; `session()` and `tx()` callbacks pin a scoped resource.
 * Scoped handles expire when their callback returns, and streams must close before a scope can finish.
 */
export interface Database {
  /** Observe database/driver/runtime evidence and optionally match it against exact support targets. */
  environment(options?: EnvironmentOptions): Promise<DatabaseEnvironment>;
  /** Materialize every row and apply query/execution mapping after the root lease is released. */
  all<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<readonly Row[]>;
  /** Require exactly one row; cardinality is checked before application mapping. */
  one<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row>;
  /** Return `undefined` for zero rows and reject when more than one row is returned. */
  maybeOne<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row | undefined>;
  /** Execute a row, command, or unknown query and preserve its normalized result kind. */
  execute<Q extends ExecutableQuery>(query: Q, options?: ExecutionOptions): Promise<ExecutionResultOf<Q>>;
  /** Execute a routine query and materialize all normalized routine channels before mapping. */
  call<Result extends RoutineCallResult>(query: CallQuery<Result>, options?: ExecutionOptions): Promise<Result>;
  /** Execute different queries sequentially on one physical use/lease. This is not an implicit transaction. */
  batch<const Queries extends readonly ExecutableQuery[]>(
    queries: Queries,
    options?: ExecutionOptions,
  ): Promise<{ readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> }>;
  /** Execute one homogeneous command shape for many inputs using the adapter's bulk strategy. */
  bulk<Input>(
    inputs: readonly Input[],
    factory: (input: Input, index: number) => CommandQuery,
    options?: ExecutionOptions,
  ): Promise<BulkResult>;
  /** Create a prepared handle whose first successful execution locks the logical SQLBraid shape. */
  prepare<Factory extends () => PreparableQuery>(
    name: string,
    factory: Factory & (Parameters<Factory> extends [] ? unknown : never),
    options: { readonly input: "none" },
  ): PreparedQuery<never, ReturnType<Factory>>;
  prepare<Factory extends (input: never) => PreparableQuery>(
    name: string,
    factory: Factory & (Parameters<Factory> extends [unknown] ? unknown : never),
  ): PreparedQuery<Parameters<Factory>[0], ReturnType<Factory>>;
  prepare<Factory extends (input: never) => PreparableQuery>(
    name: string,
    factory: Factory &
      (number extends Parameters<Factory>["length"]
        ? unknown
        : Parameters<Factory>["length"] extends 0 | 1
          ? unknown
          : never),
    options: { readonly input: "required" },
  ): PreparedQuery<Parameters<Factory>[0], ReturnType<Factory>>;
  /** Stream rows without full buffering; the physical resource remains pinned until iteration closes. */
  stream<Row>(query: RowQuery<Row>, options?: StreamOptions<Row>): AsyncIterable<Row>;
  /** Pin one physical resource for the callback without implicitly starting a transaction. */
  session<T>(callback: (database: Database) => Promise<T>): Promise<T>;
  /** Run the callback in one physical transaction; nested calls use savepoints on the same resource. */
  tx<T>(callback: (database: Database) => Promise<T>): Promise<T>;
  tx<T>(options: TransactionOptions, callback: (database: Database) => Promise<T>): Promise<T>;
}

/** Normalized bulk accounting; root bulk is not implicitly transactional. */
export interface BulkResult {
  readonly inputCount: number;
  readonly affectedRows?: number;
}

export type QueryRow<Q> = Q extends Query<infer Row, QueryResultKind> ? Row : never;
