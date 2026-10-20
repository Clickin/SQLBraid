import { createConnection } from "./lifecycle.js";
import {
  DriverError,
  type Awaitable,
  type Capabilities,
  type Connection,
  type Provider,
  type TransactionOptions,
} from "./types.js";

export interface PgNativeField {
  readonly name: string;
  readonly dataTypeID?: number;
  readonly dataType?: string;
}

export interface PgNativeResult {
  readonly rows: readonly unknown[];
  readonly fields?: readonly PgNativeField[];
  readonly rowCount?: number | null;
  readonly command?: string;
}

export interface PgNativeQuery {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly name?: string;
  readonly rowMode?: "array";
  readonly types?: { getTypeParser(oid: number, format?: string): (value: string) => unknown };
}

export interface PgNativeClient {
  query(config: PgNativeQuery): Promise<PgNativeResult | PgNativeResult[]>;
  escapeIdentifier(value: string): string;
  escapeLiteral(value: string): string;
}

export interface PgDirectClient extends PgNativeClient {
  end(): Awaitable<void>;
}

export interface PgPooledClient extends PgNativeClient {
  release(discard?: boolean): Awaitable<void>;
}

export interface PgNativePool {
  connect(): Promise<PgPooledClient>;
}

/** Shared materialized dispatch: keep native configuration, rows and field metadata intact. */
export function executePgQuery<Result>(
  client: { query(config: PgNativeQuery): Promise<Result> },
  config: PgNativeQuery,
): Promise<Result> {
  return client.query(config);
}

const capabilities: Capabilities = Object.freeze({
  driver: "pg",
  parameters: "dollar-positional",
  transactions: true,
  streaming: false,
  cancellation: false,
  prepared: false,
  savepoints: false,
  bulk: false,
  routines: false,
  multipleResults: false,
});
const empty: readonly never[] = Object.freeze([]);
const isolationSql = {
  "read-uncommitted": "READ UNCOMMITTED",
  "read-committed": "READ COMMITTED",
  "repeatable-read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
} as const;

function validateTransactionOptions(options?: TransactionOptions): void {
  if (options === undefined) return;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Transaction options must be an object.");
  }
  if (Object.keys(options).some((key) => key !== "isolation" && key !== "readOnly")) {
    throw new DriverError("UNSUPPORTED", "Unsupported PostgreSQL transaction option.");
  }
  if (
    options.isolation !== undefined &&
    (typeof options.isolation !== "string" || !Object.hasOwn(isolationSql, options.isolation))
  ) {
    throw new DriverError("UNSUPPORTED", "Unsupported PostgreSQL transaction isolation.");
  }
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") {
    throw new TypeError("Transaction readOnly must be a boolean.");
  }
}

function connection(client: PgNativeClient, release: (discard: boolean) => Awaitable<void>): Connection {
  if (
    !client ||
    typeof client !== "object" ||
    typeof client.query !== "function" ||
    typeof client.escapeIdentifier !== "function" ||
    typeof client.escapeLiteral !== "function"
  ) {
    throw new TypeError("A connected physical pg Client or PoolClient is required.");
  }
  const control = async (text: string): Promise<void> => {
    const result = await executePgQuery(client, { text, values: empty });
    if (Array.isArray(result))
      throw new DriverError("UNSUPPORTED", "PostgreSQL multiple-result payloads are not supported.");
    if (text === "COMMIT" && result.command !== undefined && result.command !== "COMMIT") {
      throw new DriverError("TRANSACTION_STATE", `PostgreSQL COMMIT completed with ${result.command}, not COMMIT.`);
    }
  };
  return createConnection(client, capabilities, {
    async execute(statement) {
      const result = await executePgQuery(client, { text: statement.sql, values: statement.parameters ?? empty });
      if (Array.isArray(result))
        throw new DriverError("UNSUPPORTED", "PostgreSQL multiple-result payloads are not supported.");
      const dml =
        result.command === "INSERT" ||
        result.command === "UPDATE" ||
        result.command === "DELETE" ||
        result.command === "MERGE";
      return {
        rows: result.rows,
        columns: result.fields ?? empty,
        ...(dml && result.rowCount != null ? { affectedRows: result.rowCount } : {}),
        ...(result.command === undefined ? {} : { command: result.command }),
      };
    },
    validateTransactionOptions,
    begin(options) {
      let text = "BEGIN";
      if (options?.isolation !== undefined) text += ` ISOLATION LEVEL ${isolationSql[options.isolation]}`;
      if (options?.readOnly !== undefined) text += options.readOnly ? " READ ONLY" : " READ WRITE";
      return control(text);
    },
    commit: () => control("COMMIT"),
    rollback: () => control("ROLLBACK"),
    release,
  });
}

/** Takes ownership of an already connected physical client; release closes it. */
export function pgConnection(client: PgDirectClient): Connection {
  if (!client || typeof client.end !== "function") throw new TypeError("A direct pg client must expose end().");
  return connection(client, () => client.end());
}

/** The caller owns the pool; each acquired physical client is returned or discarded. */
export function pgPool(pool: PgNativePool): Provider {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("A pg pool must expose connect().");
  return {
    capabilities,
    async acquire() {
      const client = await pool.connect();
      try {
        if (typeof client.release !== "function") throw new TypeError("A pooled pg client must expose release().");
        return connection(client, (discard) => (discard ? client.release(true) : client.release()));
      } catch (error) {
        try {
          await client.release(true);
        } catch (cleanup) {
          // oxlint-disable-next-line preserve-caught-error -- Both errors are retained; initialization remains the primary cause.
          throw new AggregateError([error, cleanup], "PostgreSQL pool acquisition cleanup failed.", { cause: error });
        }
        throw error;
      }
    },
  };
}
