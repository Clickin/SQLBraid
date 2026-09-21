import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RoutineCallResult, RoutineContract } from "./routine.js";
import type { RenderedStatement } from "./statement.js";
import type { QueryResultKind, TemplateIr } from "./template-ir.js";

/**
 * SQLBraid query value. It retains template IR and application mapping metadata until runtime rendering.
 * `resultSchema` is applied after driver materialization and is never forwarded to the driver.
 */
export interface Query<Row = unknown, Kind extends QueryResultKind = "unknown"> {
  readonly ir: TemplateIr;
  readonly values: readonly unknown[];
  readonly resultKind: Kind;
  /**
   * Application result mapper. Never forwarded to a DB driver.
   */
  readonly resultSchema?: StandardSchemaV1<unknown, Row>;
  readonly routineContract?: RoutineContract;
  render(): RenderedStatement;
  readonly __row?: Row;
}

export type RowQuery<Row = unknown> = Query<Row, "rows">;
export type CommandQuery = Query<CommandResult, "command">;
export type CallQuery<Result extends RoutineCallResult = RoutineCallResult> = Query<Result, "call">;

/** Driver-normalized command metadata; adapters may expose additional native fields without changing the kind. */
export interface CommandResult {
  readonly affectedRows?: number;
  readonly insertId?: string;
  readonly [key: string]: unknown;
}

/** Materialized row result. Runtime validates that it matches a rows query declaration. */
export interface RowsExecutionResult<Row = unknown> {
  readonly kind: "rows";
  readonly rows: readonly Row[];
  readonly rowCount?: number;
  readonly command?: never;
}

/** Materialized command result. Command executions intentionally expose no row payload. */
export interface CommandExecutionResult {
  readonly kind: "command";
  readonly rows: readonly [];
  readonly rowCount?: number;
  readonly command: CommandResult;
}

export type QueryExecutionResult<Row = unknown> = RowsExecutionResult<Row> | CommandExecutionResult;

/** Execution controls shared by materialized, routine, batch, and stream operations. */
export interface ExecutionOptions {
  readonly signal?: AbortSignal;
}

/** Physical SPI may complete synchronously; the public database surface remains asynchronous. */
export type Awaitable<T> = T | PromiseLike<T>;

/** Optional Standard Schema mapping applied after query-bound mapping and driver materialization. */
export interface RowValidationOptions<Row> extends ExecutionOptions {
  readonly schema?: StandardSchemaV1<unknown, NoInfer<Row>>;
}

export interface StreamOptions<Row> extends RowValidationOptions<Row> {}

/** Portable transaction isolation vocabulary; adapters reject levels they cannot provide. */
export type TransactionIsolation = "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";

/** Options for the outer physical transaction. Nested `db.tx()` calls are savepoints and accept no second option set. */
export interface TransactionOptions {
  readonly isolation?: TransactionIsolation;
  readonly readOnly?: boolean;
}
