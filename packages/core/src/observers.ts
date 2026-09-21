import type {
  LiteralizedSqlResult,
  LiteralizeOptions,
  ParameterTransportKind,
  StatementBindingDescription,
} from "./binding.js";
import type { ParameterTypeHint, RoutineParameterDirection } from "./parameter.js";
import type { BulkExecutionMode } from "./executor.js";
import type { QueryResultKind } from "./template-ir.js";

/** Immutable observer projection of adapter transport and reuse decisions. */
export interface QueryExecutionPlan {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: ParameterTransportKind;
  readonly reuse: StatementBindingDescription["reuse"];
}

/** Observer event emitted after rendering and binding, before physical execution. */
export interface QueryReadyEvent {
  readonly type: "query:ready";
  readonly purpose?: "environment";
  readonly operationId: string;
  readonly batchId?: string;
  readonly sql?: string;
  readonly values: readonly unknown[];
  readonly bindingMap?: readonly {
    readonly placeholder: number;
    readonly interpolation?: number;
    readonly direction?: RoutineParameterDirection;
    readonly outputName?: string;
  }[];
  readonly parameterHints?: readonly (ParameterTypeHint | undefined)[];
  readonly execution: QueryExecutionPlan;
  readonly literalizedSql: (options?: LiteralizeOptions) => LiteralizedSqlResult;
  readonly declaredKind: QueryResultKind;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
  readonly preparedName?: string;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Observer event emitted after driver materialization and result-kind validation, before mapping. */
export interface QueryResultEvent {
  readonly type: "query:result";
  readonly purpose?: "environment";
  readonly operationId: string;
  readonly preparedName?: string;
  readonly batchId?: string;
  readonly durationMs: number;
  readonly actualKind: "rows" | "command" | "call";
  readonly rowCount?: number;
  readonly resultSetCount?: number;
  readonly outputKeys?: readonly string[];
  readonly hasReturnValue?: boolean;
  readonly command?: Readonly<Record<string, unknown>>;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Observer event emitted after query-bound and execution-level mapping completes. */
export interface QueryMappedEvent {
  readonly type: "query:mapped";
  readonly purpose?: "environment";
  readonly operationId: string;
  readonly preparedName?: string;
  readonly batchId?: string;
  readonly durationMs: number;
  readonly rowCount: number;
  readonly queryMapped: boolean;
  readonly executionMapped: boolean;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Observer event emitted after the complete homogeneous bulk is prepared, before physical execution. */
export interface BulkReadyEvent {
  readonly type: "bulk:ready";
  readonly operationId: string;
  readonly itemCount: number;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
  readonly sql?: string;
  readonly valuesAt: (index: number) => readonly unknown[];
  readonly literalizedSql: (index: number, options?: LiteralizeOptions) => LiteralizedSqlResult;
}

/** Observer event emitted after bulk execution and result normalization. */
export interface BulkResultEvent {
  readonly type: "bulk:result";
  readonly operationId: string;
  readonly itemCount: number;
  readonly affectedRows?: number;
  readonly executionMode: BulkExecutionMode;
  readonly durationMs: number;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export type QueryErrorStage =
  | "render"
  | "prepared"
  | "observer-before"
  | "materialize"
  | "acquire"
  | "driver"
  | "result-kind"
  | "cardinality"
  | "query-map"
  | "execution-map"
  | "observer-after"
  | "release"
  | "stream"
  | "transaction";

/** Observer event describing the stage and truthful execution flags for a failed operation. */
export interface QueryErrorEvent {
  readonly type: "query:error";
  readonly purpose?: "environment";
  readonly operationId: string;
  readonly preparedName?: string;
  readonly batchId?: string;
  readonly error: unknown;
  readonly stage: QueryErrorStage;
  readonly executionStarted: boolean;
  readonly executionCompleted: boolean;
  readonly durationMs?: number;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Observer event emitted when a stream is admitted and its lease is about to be retained. */
export interface StreamStartEvent {
  readonly type: "stream:start";
  readonly operationId: string;
  readonly sql?: string;
  readonly values: readonly unknown[];
  readonly bindingMap?: readonly {
    readonly placeholder: number;
    readonly interpolation?: number;
    readonly direction?: RoutineParameterDirection;
    readonly outputName?: string;
  }[];
  readonly parameterHints?: readonly (ParameterTypeHint | undefined)[];
  readonly execution: QueryExecutionPlan;
  readonly literalizedSql: (options?: LiteralizeOptions) => LiteralizedSqlResult;
  readonly declaredKind: "rows";
  readonly variantFingerprint?: string;
  readonly preparedName?: string;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

/** Terminal stream event; delivery is attempted for every observer even if one observer fails. */
export interface StreamEndEvent {
  readonly type: "stream:end";
  readonly operationId: string;
  readonly status: "completed" | "error";
  readonly durationMs: number;
  readonly rowCount: number;
  readonly error?: unknown;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export type TransactionEventPhase =
  | "begin"
  | "commit"
  | "rollback"
  | "savepoint"
  | "rollback-to-savepoint"
  | "release-savepoint";

/** Transaction-control lifecycle event for outer transactions and nested savepoints. */
export interface TransactionEvent {
  readonly type: "transaction";
  readonly transactionId: string;
  readonly phase: TransactionEventPhase;
  readonly status: "requested" | "completed" | "failed";
  readonly depth: number;
  readonly savepointName?: string;
  readonly durationMs?: number;
  readonly error?: unknown;
}

export type ExecutionEvent =
  | QueryReadyEvent
  | QueryResultEvent
  | QueryMappedEvent
  | BulkReadyEvent
  | BulkResultEvent
  | QueryErrorEvent
  | StreamStartEvent
  | StreamEndEvent
  | TransactionEvent;

/** Readonly observer hook. Observers may fail execution, but cannot rewrite SQL, binds, routing, or results. */
export interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}
