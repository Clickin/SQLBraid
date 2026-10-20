import { createConnection } from "./lifecycle.js";
import { DriverError, type Capabilities, type Connection, type Result, type TransactionOptions } from "./types.js";

export interface SqliteColumn {
  readonly name?: string | null;
  readonly column?: string | null;
  readonly database?: string | null;
  readonly table?: string | null;
  readonly type?: string | null;
}

export interface SqliteStatement {
  all(...values: readonly unknown[]): readonly unknown[];
  run(...values: readonly unknown[]): {
    readonly changes?: number | bigint;
    readonly lastInsertRowid?: number | bigint;
  };
  columns(): readonly SqliteColumn[];
  setReadBigInts?(enabled: boolean): void;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface MaterializationHooks {
  validateColumns?(columns: readonly SqliteColumn[]): void;
  configure?(statement: SqliteStatement, columns: readonly SqliteColumn[]): void;
}

const noParameters: readonly unknown[] = [];

/** Shared native dispatch; policy hooks run before the statement executes. */
export function materializeSqlite(
  database: Pick<SqliteDatabase, "prepare">,
  sql: string,
  parameters: readonly unknown[] = noParameters,
  hooks?: MaterializationHooks,
): Result<unknown> & { readonly columns: readonly SqliteColumn[] } {
  const statement = database.prepare(sql);
  const columns = statement.columns();
  hooks?.validateColumns?.(columns);
  hooks?.configure?.(statement, columns);
  if (columns.length > 0) return { rows: statement.all(...parameters), columns };
  const result = statement.run(...parameters);
  return { rows: [], columns, affectedRows: result.changes, insertId: result.lastInsertRowid };
}

const capabilities: Capabilities = Object.freeze({
  driver: "node:sqlite",
  parameters: "question-positional",
  transactions: true,
  streaming: false,
  cancellation: false,
  prepared: false,
  savepoints: false,
  bulk: false,
  routines: false,
  multipleResults: false,
});

function validateTransactionOptions(options?: TransactionOptions): void {
  if (options === undefined) return;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Transaction options must be an object.");
  }
  for (const key of Object.keys(options)) {
    if (key !== "isolation" && key !== "readOnly") throw new TypeError(`Unknown SQLite transaction option: ${key}.`);
  }
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") {
    throw new TypeError("Transaction readOnly must be boolean.");
  }
  if (options.isolation !== undefined && options.isolation !== "serializable") {
    throw new DriverError("UNSUPPORTED", "SQLite only supports serializable isolation in this driver.");
  }
  if (options.readOnly === true)
    throw new DriverError("UNSUPPORTED", "SQLite read-only transactions are not supported.");
}

/** Own a native node:sqlite database, preserving its default rows and numeric values. */
export function sqliteConnection(database: SqliteDatabase): Connection {
  return createConnection(database, capabilities, {
    execute: (statement) => materializeSqlite(database, statement.sql, statement.parameters),
    validateTransactionOptions,
    begin: () => database.exec("BEGIN"),
    commit: () => database.exec("COMMIT"),
    rollback: () => database.exec("ROLLBACK"),
    release: () => database.close(),
  });
}
