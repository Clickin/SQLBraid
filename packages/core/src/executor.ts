import type { BulkBindingDescription, StatementBindingAdapter, StatementBindingDescription } from "./binding.js";
import type { DriverEnvironment } from "./environment.js";
import type { DriverRoutineResult } from "./routine.js";
import type { RenderedBulk, RenderedStatement } from "./statement.js";
import type { Awaitable, ExecutionOptions, QueryExecutionResult, TransactionOptions } from "./query.js";

/** Native or adapter execution strategy reported for a bulk operation; the label does not imply atomicity. */
export type BulkExecutionMode = "native-bulk" | "pipeline" | "prepared-loop" | "remote-batch";

/** Driver bulk result normalized for runtime accounting and observer events. */
export interface BulkExecutionResult {
  readonly inputCount: number;
  readonly affectedRows?: number;
  readonly executionMode: BulkExecutionMode;
}

/**
 * Physical execution SPI for one serialized resource.
 * Query/call/control methods may be synchronous at this boundary; streams remain async iterables and retain ownership until closed.
 */
export interface QueryExecutor {
  /** Stable identity for the physical execution resource shared by wrappers; pools must use a leased resource. */
  readonly ownershipKey?: object;
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
  /** Execute one materialized statement on this physical resource. */
  query<Row>(
    rendered: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<QueryExecutionResult<Row>>;
  /** Open a true driver stream; the physical resource remains owned until iteration closes. */
  stream<Row>(
    rendered: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): AsyncIterable<Row>;
  /** Execute a routine call and return normalized scalar/result-set channels. */
  call(
    rendered: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<DriverRoutineResult>;
  /** Optional homogeneous bulk protocol. The reported execution mode does not imply atomicity. */
  bulk?(
    bulk: RenderedBulk,
    binding: BulkBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<BulkExecutionResult>;
  /** Pure pre-acquire validation for adapter-specific transaction option support. */
  validateTransactionOptions?(options: TransactionOptions): void;
  /** Begin the outer transaction on this physical resource. */
  begin?(options?: TransactionOptions): Awaitable<void>;
  /** Commit the outer transaction on this physical resource. */
  commit?(): Awaitable<void>;
  /** Roll back the outer transaction on this physical resource. */
  rollback?(): Awaitable<void>;
  /** Create a nested transaction boundary on the current resource. */
  savepoint?(name: string): Awaitable<void>;
  /** Roll back the current resource to a previously created savepoint. */
  rollbackTo?(name: string): Awaitable<void>;
  /** End the logical savepoint boundary; adapters may implement this as a no-op when the database releases implicitly. */
  releaseSavepoint?(name: string): Awaitable<void>;
}

/** Acquired physical resource. The lease owns release/discard, while runtime owns operation serialization. */
export interface ConnectionLease extends QueryExecutor {
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}

/** Lease factory for pools; acquiring one lease is the boundary that establishes physical connection ownership. */
export interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
  validateTransactionOptions?(options: TransactionOptions): void;
  acquire(): Promise<ConnectionLease>;
}
