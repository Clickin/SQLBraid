---
title: Direct connections and pools
description: Choose the factory that matches your physical database resource.
---

SQLBraid makes ownership explicit. It does not detect pools by duck typing.

## Direct resources

`createDatabase(executor)` in `@sqlbraid/runtime` and the direct factories of each adapter wrap one physical execution resource.

- PostgreSQL accepts a connected `pg.Client` or `pg.PoolClient`.
- MySQL accepts a resolved `Connection` or `PoolConnection` object from `mysql2/promise`.
- SQLite accepts a resource that is compatible with `DatabaseSync`.

```ts
const db = createPgDatabase(client);
const db = createMysql2Database(connection);
const db = createNodeSqliteDatabase(native);
```

Direct wrappers that share an ownership key serialize their physical operations. The application closes the direct resource.

## Pools

Use an explicit pool factory:

```ts
const pgDb = createPgPoolDatabase(pgPool);
const mysqlDb = createMysql2PoolDatabase(mysqlPool);
const mariadbDb = createMariaDbPoolDatabase(mariadbPool);
const customDb = createPooledDatabase(connectionProvider);
```

The `acquire()` of a provider returns one `ConnectionLease` with an executor and `release({ discard })`. Each independent pooled root operation acquires one lease, does the DB I/O, releases the lease and then maps the materialized results. The application owns the shutdown of the pool.

Providers expose an immutable `statementBinding` adapter. The binding
description and the hint validation occur before `acquire()`. Each lease must
use that exact adapter object. A lease cannot silently change the transport or
the dialect identity.

A pool is not a fake executor. If `BEGIN`, a query and `COMMIT` can go to different physical connections, the transaction is not real. To pin the lease, use `db.tx(...)`.

`db.session(async (session) => ...)` pins one acquired lease for the callback.

- Nested sessions use the same lease.
- `db.tx(...)` inside the session does not acquire again.
- The outer root database cannot be used to escape that scope.
- A stream keeps the lease until the cursor or request cleanup.
- If the provider or session primitive is unavailable, the call fails with
  `BRAID_SESSION_UNSUPPORTED`.

An already-aborted signal keeps its `reason`. Active cancellation is a driver
capability. Without it, the operation fails before I/O with
`UnsupportedFeatureError` / `BRAID_CANCEL_UNSUPPORTED`. Transaction options are
validated before acquisition:

- Malformed values use `TypeError` / `BRAID_TX_OPTIONS_INVALID`.
- Valid but unsupported values use `BRAID_TX_OPTION_UNSUPPORTED`.
- Nested explicit options use `BRAID_TX_OPTIONS_NESTED`.

:::caution Factory boundary
These calls are unsupported: `pg.Pool` to `createPgDatabase`, a mysql2 pool to `createMysql2Database` and a mariadb pool to `createMariaDbDatabase`. Use `createPgPoolDatabase`, `createMysql2PoolDatabase` or `createMariaDbPoolDatabase`.
:::
