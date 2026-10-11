import type { ConnectionProvider, QueryExecutor } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { createPgExecutorFor, createPgPoolProviderFor, type PgDriverIdentity } from "./pg/executor.js";
import type { PgClientLike, PgDatabaseOptions, PgExecutorOptions, PgPoolLike } from "./pg/types.js";

export type {
  PgClientLike as NeonClientLike,
  PgCursorFactory as NeonCursorFactory,
  PgDatabaseOptions as NeonDatabaseOptions,
  PgExecutorOptions as NeonExecutorOptions,
  PgPoolClientLike as NeonPoolClientLike,
  PgPoolLike as NeonPoolLike,
} from "./pg/types.js";

const neonDriverIdentity: PgDriverIdentity = Object.freeze({
  id: "neon-serverless",
  capabilities: Object.freeze({
    // A Neon pooled endpoint uses PgBouncer in transaction mode. Named prepared statements depend on the endpoint.
    "statement.prepare": { status: "guarded" as const, conditionCode: "neon.pooler-transaction-mode" },
  }),
});

/**
 * Wrap one connected `Client` or pool client from `@neondatabase/serverless` over WebSocket.
 * The caller sets `neonConfig.webSocketConstructor` and owns the client shutdown.
 */
export function createNeonExecutor(client: PgClientLike, options: PgExecutorOptions = {}): QueryExecutor {
  return createPgExecutorFor(neonDriverIdentity, client, options);
}

/** Wrap one connected Neon WebSocket `Client` as an application database. */
export function createNeonDatabase(client: PgClientLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, profile, cursor, streamBatchSize, parserProfile, ...databaseOptions } = options;
  return createDatabase(
    createNeonExecutor(client, { typePolicy, profile, cursor, streamBatchSize, parserProfile }),
    databaseOptions,
  );
}

/** Create a lease provider from a Neon WebSocket `Pool`; discarded leases call `client.release(true)`. */
export function createNeonPoolProvider(pool: PgPoolLike, options: PgExecutorOptions = {}): ConnectionProvider {
  return createPgPoolProviderFor(neonDriverIdentity, pool, options);
}

/** Wrap a Neon WebSocket `Pool` as a pooled application database with one lease per root operation. */
export function createNeonPoolDatabase(pool: PgPoolLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, profile, cursor, streamBatchSize, parserProfile, ...databaseOptions } = options;
  return createPooledDatabase(
    createNeonPoolProvider(pool, { typePolicy, profile, cursor, streamBatchSize, parserProfile }),
    databaseOptions,
  );
}
