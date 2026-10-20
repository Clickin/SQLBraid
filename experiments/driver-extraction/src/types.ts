export type Awaitable<T> = T | PromiseLike<T>;

/** SQL already contains native placeholders. Values never become SQL text. */
export interface Statement {
  readonly sql: string;
  readonly parameters?: readonly unknown[];
}

/** Native rows and metadata are not copied or decoded by the common layer. */
export interface Result<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly columns: readonly unknown[];
  readonly affectedRows?: number | bigint;
  readonly insertId?: number | bigint;
  readonly command?: string;
}

export interface TransactionOptions {
  readonly isolation?: "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";
  readonly readOnly?: boolean;
}

export interface Capabilities {
  readonly driver: "pg" | "node:sqlite";
  readonly parameters: "dollar-positional" | "question-positional";
  readonly transactions: true;
  readonly streaming: false;
  readonly cancellation: false;
  readonly prepared: false;
  readonly savepoints: false;
  readonly bulk: false;
  readonly routines: false;
  readonly multipleResults: false;
}

/** Exclusive physical ownership. Await every operation; concurrent operations reject. */
export interface Connection {
  readonly capabilities: Capabilities;
  execute<Row = Record<string, unknown>>(
    statement: Statement,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<Row>>;
  begin(options?: TransactionOptions): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** Roll back an unfinished transaction, then close or return the physical resource. */
  release(options?: { readonly discard?: boolean }): Promise<void>;
}

export interface Provider {
  readonly capabilities: Capabilities;
  acquire(): Promise<Connection>;
}

export class DriverError extends Error {
  constructor(
    readonly code: "UNSUPPORTED" | "BUSY" | "CLOSED" | "TRANSACTION_STATE" | "POISONED",
    message: string,
  ) {
    super(message);
    this.name = "DriverError";
  }
}
