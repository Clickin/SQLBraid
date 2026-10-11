import type { ConnectionProvider, QueryExecutor } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { pgStatementBinding } from "./common/binding.js";
import { createPgExecutorFor, createPgPoolProviderFor, pgDriverIdentity } from "./pg/executor.js";
import { pgOidTypes } from "./pg/types.js";
import type { PgClientLike, PgDatabaseOptions, PgExecutorOptions, PgPoolLike } from "./pg/types.js";

export { pgOidTypes, pgStatementBinding };
export type {
  PgClientLike,
  PgCursorFactory,
  PgCursorLike,
  PgDatabaseOptions,
  PgExecutorOptions,
  PgFieldLike,
  PgParserProfile,
  PgPoolClientLike,
  PgPoolLike,
  PgResultLike,
  PgTypeOverrides,
} from "./pg/types.js";

/** Wrap one connected `pg` client. SQLBraid owns query serialization but not client shutdown. */
export function createPgExecutor(client: PgClientLike, options: PgExecutorOptions = {}): QueryExecutor {
  return createPgExecutorFor(pgDriverIdentity, client, options);
}

/** Wrap one connected `pg` client as an application database. */
export function createPgDatabase(client: PgClientLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, profile, cursor, streamBatchSize, parserProfile, ...databaseOptions } = options;
  return createDatabase(
    createPgExecutor(client, { typePolicy, profile, cursor, streamBatchSize, parserProfile }),
    databaseOptions,
  );
}

/** Create a lease provider from a `pg` pool; discarded leases call `client.release(true)`. */
export function createPgPoolProvider(pool: PgPoolLike, options: PgExecutorOptions = {}): ConnectionProvider {
  return createPgPoolProviderFor(pgDriverIdentity, pool, options);
}

/** Wrap a `pg` pool as a pooled application database with one lease per root operation. */
export function createPgPoolDatabase(pool: PgPoolLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, profile, cursor, streamBatchSize, parserProfile, ...databaseOptions } = options;
  return createPooledDatabase(
    createPgPoolProvider(pool, { typePolicy, profile, cursor, streamBatchSize, parserProfile }),
    databaseOptions,
  );
}

export { representationProfiles, typePolicyForProfile } from "./type-policy.js";
export type { PgRepresentationProfile, PgRepresentationProfileOptions } from "./type-policy.js";
