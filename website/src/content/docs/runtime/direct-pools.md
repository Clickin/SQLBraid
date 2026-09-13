---
title: Direct connections and pools
description: Choose the factory that matches your physical database resource.
---

SQLBraid makes ownership explicit instead of detecting pools by duck typing.

## Direct resources

`createDatabase(executor)` in `@sqlbraid/runtime` and adapter-specific direct factories wrap one physical execution resource. PostgreSQL accepts a connected `pg.Client` or `pg.PoolClient`; MySQL accepts a resolved `Connection` or `PoolConnection` object from `mysql2/promise`; SQLite accepts a `DatabaseSync`-compatible resource.

```ts
const db = createPgDatabase(client);
const db = createMysql2Database(connection);
const db = createNodeSqliteDatabase(native);
```

Direct wrappers that share an ownership key serialize physical operations. The application closes the direct resource.

## Pools

Use an explicit pool factory:

```ts
const pgDb = createPgPoolDatabase(pgPool);
const mysqlDb = createMysql2PoolDatabase(mysqlPool);
const customDb = createPooledDatabase(connectionProvider);
```

A provider's `acquire()` returns one `ConnectionLease` with an executor and `release({ discard })`. Each independent pooled root operation acquires one lease, performs DB I/O, releases it, and then maps materialized results. The application owns pool shutdown.

Providers expose an immutable `statementBinding` adapter. Binding description and
hint validation happen before `acquire()`, and every lease must use that exact
adapter object; a lease cannot silently switch transport or dialect identity.

A pool is not a fake executor. If `BEGIN`, a query, and `COMMIT` can land on different physical connections, the transaction is not real; use `db.tx(...)` to pin the lease.

:::caution Factory boundary
Passing `pg.Pool` to `createPgDatabase` or a mysql2 pool to `createMysql2Database` is unsupported. Use `createPgPoolDatabase` or `createMysql2PoolDatabase`.
:::
