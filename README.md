# SQLBraid

**Write SQL. Keep TypeScript. Skip the query-builder translation layer.**

SQLBraid is a SQL-first data-access toolkit for TypeScript. It keeps ordinary SQL as the primary authoring language while adding safe binds, readable dynamic SQL, explicit result contracts, Standard Schema result mapping, transaction-safe execution and first-party PostgreSQL/MySQL/SQLite adapters.

```ts
interface UserRow {
  id: number;
  name: string;
}

const users = sql.rows<UserRow>`
  SELECT u.id, u.name
  FROM users u
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND u.name = ${name}
    /*@braid end*/
  /*@braid end*/
`;
```

> **Status:** pre-release. Explicit result kinds, guarded compiler lowering, runtime result-kind enforcement, Standard Schema execution validation, query-bound result mapping, PostgreSQL/MySQL/SQLite adapters and real-DB tests are implemented. The next runtime milestone is the execution boundary: connection leasing/transaction pinning plus SQL/bind/audit observers. See [`PLAN.md`](./PLAN.md).

---

## Why SQLBraid?

SQLBraid sits between low-level drivers and query-builder/ORM-first libraries:

- write SQL directly;
- bind values safely;
- keep dynamic SQL next to the statement;
- declare the application row type explicitly;
- optionally validate/transform rows through Standard Schema;
- execute through a small runtime abstraction;
- keep metadata/codegen optional.

SQLBraid does not need a local function registry or complete SQL parser before you can use database-specific SQL.

```ts
const report = sql.rows<ReportRow>`
  SELECT
    custom_company_score(account_id) AS score,
    jsonb_build_object('id', account_id) AS metadata
  FROM reporting_view
`;
```

---

## Dynamic SQL

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
    /*@braid if ${teamId != null}*/
      AND team_id = ${teamId}
    /*@braid end*/
  /*@braid end*/
`;
```

Supported v1 directives are `if`, `choose`, `when`, `otherwise`, `where`, `set` and `trim`.

The compiler transform preserves lazy evaluation for guarded TypeScript expressions; inactive branches are not evaluated.

Structural SQL is explicit:

```ts
sql.ident(columnName)
sql.fragment`ORDER BY created_at DESC`
sql.list(ids)
sql.join(parts, sql.fragment`, `)
sql.raw(trustedSql)
```

Ordinary `${value}` interpolation is always a bind parameter.

---

## Result contracts

### Explicit contract

```ts
const query = sql.rows<AccountRow>`
  SELECT id, display_name AS "displayName"
  FROM accounts
`;
```

The developer owns the correspondence between arbitrary SQL and `AccountRow`. SQLBraid does not fabricate SQL-to-TypeScript inference.

Explicit result kinds are:

```ts
sql.rows<UserRow>`SELECT ...`
sql.command`UPDATE ...`
sql.call<RefreshResult>`CALL ...`
sql`SELECT ...` // Query<unknown, "unknown">
```

Adapters report the actual row/command result kind and the runtime checks it against the declaration. A mismatch throws `BRAID_RESULT_KIND` **after execution**; use a transaction when a write must roll back if its declared kind was wrong.

---

## Standard Schema result mapping

SQLBraid depends only on `@standard-schema/spec`. It does not require Valibot, Zod, ArkType or another concrete validator implementation.

### Query-bound mapper

```ts
const eventQuery = sql.rows(EventSchema)`
  SELECT created_at AS "createdAt", payload
  FROM events
`;

const event = await db.one(eventQuery);
```

The Standard Schema output type becomes the query row type.

A lightweight Valibot example:

```ts
import * as v from "valibot";

const EventSchema = v.object({
  createdAt: v.pipe(
    v.string(),
    v.regex(/^\d{14}$/),
    v.transform((s) =>
      new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`)
    ),
  ),
  payload: v.pipe(
    v.string(),
    v.parseJson(),
    v.object({ enabled: v.boolean() }),
  ),
});
```

Conceptually:

```text
database row
   ↓
driver + dialect TypePolicy normalization
   ↓
plain normalized row
   ↓
query-bound Standard Schema
   ↓
optional execution-level schema
   ↓
application model
```

Mapping is intrinsic to row queries: `execute`, `all`, `one`, `maybeOne`, `batch`, prepared queries, streams and transaction-scoped equivalents return mapped rows.

A per-execution schema remains additive:

```ts
await db.all(eventQuery, { schema: ExtraSchema });
```

Validation issues throw `DatabaseResultValidationError` (`BRAID_RESULT_VALIDATION`) with query/execution stage and row index. SQLBraid's own error message does not dump raw rows or binds.

Result mapping is intentionally one-row-to-one-row. SQLBraid does not provide identity maps, relation hydration or multi-row object-graph assembly.

---

## Input mapping is deferred

Pre-release SQLBraid does not add a symmetric application input-codec framework.

```ts
${value}
```

remains an ordinary driver-bound value. JavaScript database drivers do not expose a JDBC-like universal application-input type system, so `Temporal`, custom classes, JSON conventions and binary representations will be revisited only after real post-release requirements justify an input-mapping design.

---

## Runtime execution model

Current public row/command APIs include:

```ts
await db.all(query);
await db.one(query);
await db.maybeOne(query);
await db.execute(command);
await db.call(callQuery);
await db.batch(queries);
db.prepare(name, factory);
db.stream(query);
await db.tx(async (tx) => { ... });
```

The runtime tracks physical-resource ownership and prevents uncertain transaction state from being silently reused.

### Direct connections and pools

`createDatabase(executor, options?)` accepts one physical execution resource. Direct wrappers sharing an ownership key serialize their physical operations.

Pools have explicit factories; SQLBraid does not detect pools by duck typing:

```ts
import { Pool } from "pg";
import { createPool } from "mysql2/promise";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import type { ConnectionProvider } from "@sqlbraid/core";

const direct = createPgDatabase(client); // connected pg.Client
const postgres = createPgPoolDatabase(new Pool(pgOptions));
const mysql = createMysql2PoolDatabase(createPool(mysqlOptions));
const custom = createPooledDatabase(provider); // ConnectionProvider
```

A `ConnectionProvider.acquire()` returns a `ConnectionLease`: one `QueryExecutor` plus `release({ discard? })`. Independent pooled root operations have no global SQLBraid queue. The application owns pool shutdown.

Outside an explicit transaction, a pooled database may obtain any available physical connection for each root operation:

```text
root query
  -> acquire lease
  -> execute DB I/O
  -> release lease
  -> application result mapping
```

`db.tx(...)` is the connection-pinning boundary:

```ts
await db.tx(async (tx) => {
  await tx.execute(insertAudit);
  await tx.execute(updateAccount);
});
```

Inside that closure, every `tx.*` operation reuses one physical connection until commit/rollback and release. Nested transactions use savepoints on the same connection when supported.

Use the innermost callback handle while a savepoint is active; parent/sibling handle use fails with `BRAID_TX_SCOPE`. Physical transaction operations are serialized. A callback must close its streams: an abandoned live iterator is closed and the transaction rolls back instead of committing over an active cursor.

Using the outer/root database from its own transaction context fails with `BRAID_TX_SCOPE` instead of silently escaping onto another pool connection. Use the callback's `tx` handle, which becomes unusable after the closure ends.

A pool such as `pg.Pool`, `mysql2.Pool` or Bun.SQL must be modeled as a **connection provider/lease source**, not as a fake executor whose `BEGIN`, query and `COMMIT` could land on different connections.

Materialized query results release their root lease before asynchronous application mapping, including `execute`, prepared execution and `batch`.

One batch uses one lease, executes every physical statement in order, releases, then maps the materialized results. **Batch is not atomic:** earlier statements—and later statements when mapping fails—may already have executed. Wrap it in `db.tx()` when atomicity is required.

Streaming keeps its lease until iteration finishes, breaks, aborts or fails. Rows are mapped one at a time without buffering. Pooled-root mapper re-entry may acquire another lease; a pool needs available capacity for that nested operation. Same-root direct-stream re-entry fails with `BRAID_STREAM_SCOPE` rather than waiting on itself. Transaction streams prohibit overlapping work on the pinned connection. The SQLite adapter uses native statement iteration; adapters without a streaming protocol reject streaming.

Uncertain transaction-control failures poison the physical resource. Pooled cleanup discards it (`pg` release-with-destroy; mysql2 `destroy()`); direct resources reject further SQLBraid work.

---

## Execution observers / interceptors

Production systems often need SQL/bind logging or audit without coupling SQLBraid to a logger.

Configure observers through `{ observers: [...] }` on direct or pooled database factories.

Coverage includes:

- final rendered SQL;
- readonly bind values and binding metadata;
- declared and actual result kinds;
- query/call/batch/prepared lifecycle;
- DB execution duration in milliseconds (`durationMs`);
- row count/command metadata where appropriate;
- result-mapping completion;
- stream start/end/error;
- transaction begin/commit/rollback;
- savepoint lifecycle;
- errors with pipeline stage.

The public contract in `@sqlbraid/core` is a readonly discriminated event union:

```ts
interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}
```

Redact binds by default:

```ts
const db = createPgPoolDatabase(pool, {
  observers: [{
    onEvent(event) {
      if (event.type === "query:ready") {
        logger.debug({
          sql: event.sql,
          binds: event.values.map(() => "[REDACTED]"),
        });
      }
    },
  }],
});
```

An audit policy can fail closed before acquiring a connection:

```ts
const db = createPgPoolDatabase(pool, {
  observers: [{
    async onEvent(event) {
      if (event.type === "query:ready") {
        await audit.record({ operationId: event.operationId, sql: event.sql });
        // A rejected audit write prevents this SQL statement from executing.
      }
    },
  }],
});
```

Observers run sequentially in registration order. Events and metadata arrays are frozen where practical; nested application bind objects remain application-owned and must not be mutated. Prepared events carry the SQLBraid shape-lock name, not a promise of native driver preparation.

The event types are `query:ready`, `query:result`, `query:mapped`, `query:error`, `stream:start`, `stream:end` and `transaction`. Batch items use ordinary query events with a shared `batchId` and individual `operationId`s; this is the batch lifecycle representation rather than separate batch start/end events.

Pre-release observer semantics are **observe/fail only**:

- observers may inspect events;
- an observer may throw to reject/fail the operation;
- SQL, binds and results are not mutable through this SPI;
- retry/routing/query rewriting are not part of the observer contract.

Bind values are available because some audit systems require them, but SQLBraid does not log them by default. Applications decide their own redaction and retention policy.

A failure before DB execution prevents execution. A failure after DB execution cannot undo an already committed root side effect; inside `db.tx(...)`, propagated failures participate in rollback.

If an error observer also fails, an `AggregateError` preserves the original failure and the observer failure. SQLBraid-generated errors do not stringify bind values; driver/application errors retain their original identity and may require application redaction.

This SPI is also the intended foundation for a later optional OpenTelemetry integration.

---

## Dialect, driver and runtime are separate

SQLBraid does not need a new dialect for every driver/runtime combination.

```text
dialect     PostgreSQL / MySQL / SQLite SQL surface
driver      pg / mysql2 / node:sqlite / future alternatives
runtime     Node / Bun / Deno
```

Current primary first-party adapters are:

| Dialect | Adapter |
| --- | --- |
| PostgreSQL | `pg` |
| MySQL | `mysql2` |
| SQLite | `node:sqlite` |

A different driver only needs a thin adapter/provider if the SQL dialect remains the same.

Runtime support uses four labels:

- **Official** — exercised in SQLBraid CI for that runtime + driver;
- **Compatible** — expected from public APIs but not an SQLBraid CI gate;
- **Custom** — connected through the executor/provider SPI.
- **Unsupported** — a required capability is absent or the combination fails SQLBraid's checks.

### Runtime libraries

| Runtime | core/template/runtime | Tested version | Notes |
| --- | --- | --- | --- |
| Node | Compatible; CI promotion pending | 22.18.0, 24.21.0 | Floor full release gate; packed smoke including concurrent transaction ALS |
| Bun | Compatible; CI promotion pending | 1.3.14 | Same packed smoke and ALS assertions |
| Deno | Compatible; CI promotion pending | 2.9.3 | Same packed smoke and ALS assertions |

### First-party driver adapters

| Adapter | Node 22.18.0 / 24.21.0 | Bun 1.3.14 | Deno 2.9.3 |
| --- | --- | --- | --- |
| PostgreSQL / `pg` 8.23.0 | Compatible | Compatible | Compatible |
| MySQL / `mysql2` 3.24.4 | Compatible | Compatible | Compatible |
| SQLite / `node:sqlite` | Compatible | Unsupported | Compatible |

These are measured local packed-consumer results, not observed GitHub CI passes.
The [runtime workflow](.github/workflows/runtime-portability.yml) adds release gates
on Node **22.18.0**, Bun **1.3.14**, and Deno **2.9.3**. Promote a cell to Official
only after its CI job succeeds. Bun/Deno versions are exact tested versions, not
minimum-version promises. Node package metadata retains `>=22.18.0`.

PostgreSQL 16.4 and MySQL 8.4.2 smokes exercise direct clients, concurrent pools,
physical transaction identity, savepoint rollback, root escape protection, observer
events, and asynchronous mapper re-entry with pool size one.
Bun 1.3.14 has no `node:sqlite` module. Deno 2.9.3 does provide `columns()` and
passes the existing adapter smoke; older documentation omitting that method is
not evidence of its absence. No SQL keyword classifier or substitute SQLite driver
is used.

Compiler, CLI, language server, and metadata/codegen tooling remain **Node-first**.
Other drivers remain **Custom** through `QueryExecutor` / `ConnectionProvider`.

Direct `createPgDatabase()` accepts physical `Client`/`PoolClient`, not `pg.Pool`.
Direct `createMysql2Database()` accepts a Promise `Connection`/`PoolConnection`,
not a pool. Type checks and immediate runtime guards enforce this boundary;
use the corresponding `create*PoolDatabase()` factory for pools.
Observer errors distinguish `cardinality` from `result-kind`; all public timing
fields are named `durationMs`, with no former-name alias.

---

## Metadata and code generation

Database metadata is optional development tooling.

The current `@sqlbraid/schema` package is planned to become `@sqlbraid/metadata` after the runtime execution boundary is stable.

A later optional `@sqlbraid/codegen` package will generate deterministic table-oriented TypeScript models such as `Row`, `Insert` and `Update` shapes. Arbitrary SELECT/JOIN inference is not required.

---

## Oracle

Oracle/node-oracledb is intentionally post-release.

Oracle support needs more than placeholder syntax: named/positional binds, IN/OUT/IN OUT parameters, REF CURSOR, LOBs, NUMBER conversion, DATE/TIMESTAMP variants, object/database types, result-set modes and Oracle-specific session/pool behavior need a dedicated dialect/adapter design.

A future surface may look like:

```text
@sqlbraid/oracle
@sqlbraid/oracle/oracledb
```

but it is not a pre-release gate.

---

## Packages

Current workspace packages:

| Package | Responsibility |
| --- | --- |
| `@sqlbraid/core` | Public contracts and Standard Schema-facing types |
| `@sqlbraid/template` | Tagged templates, directives and rendering |
| `@sqlbraid/runtime` | Execution, mapping, result-kind safety, transactions and streaming |
| `@sqlbraid/postgres` | PostgreSQL dialect, TypePolicy, inspector, `pg` adapter |
| `@sqlbraid/mysql` | MySQL dialect, TypePolicy, inspector, `mysql2` adapter |
| `@sqlbraid/sqlite` | SQLite dialect, inspector, `node:sqlite` adapter |
| `@sqlbraid/compiler` | TypeScript discovery and guarded-template lowering |
| `@sqlbraid/schema` | Database metadata snapshots; later rename to `@sqlbraid/metadata` |
| `@sqlbraid/operations` | Fingerprints and provisional declaration manifests |
| `@sqlbraid/cli` | Command-line tooling |
| `@sqlbraid/language-server` | Editor/LSP integration |

---

## Roadmap

Completed:

1. **PV1** — explicit query/result-kind contracts;
2. **PV2** — remove compiler SQL semantic inference;
3. **PV3** — remove broad SQL AST/resolver;
4. **PV4** — runtime result-kind enforcement + execution-time Standard Schema validation;
5. **PV5** — query-bound Standard Schema result mapping;
6. **PV6** — execution boundary, connection leasing/transaction pinning, SQL/bind/audit observer SPI.

Next:

7. **PV7** — Node/Bun/Deno runtime portability matrix;
8. **PV8** — rename/reframe `@sqlbraid/schema` as `@sqlbraid/metadata`;
9. **PV9** — optional metadata → TypeScript codegen;
10. **PV10** — codegen CLI and overrides;
11. **PV11** — LSP metadata/codegen integration;
12. **PV12** — public API/docs/package hardening for pre-release/Product Hunt.

Post-release candidates include Oracle/node-oracledb, application input mapping, optional DB verification, additional driver adapters, cancellation, bulk/pipeline operations, query transformation, routing/retry and OpenTelemetry.

---

## Development

Requirements:

- Node.js `>=22.18.0` for the current published packages;
- pnpm `12.x`;
- Docker for PostgreSQL/MySQL integration tests.

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:db
pnpm run test:consumer
pnpm run test:all
pnpm run pack:check
pnpm run test:runtime
```

`test:runtime:node`, `test:runtime:bun`, and `test:runtime:deno` run individual cells.
The Node/pnpm orchestrator builds and packs runtime packages, installs an isolated
consumer, audits source/distribution and Node-ambient-free declarations, and runs
the same scripts under each runtime. It starts disposable PostgreSQL/MySQL
Testcontainers unless `SQLBRAID_POSTGRES_URL` / `SQLBRAID_MYSQL_URL` identify
dedicated test databases. The smoke creates and drops isolated test tables;
**never point it at a non-test database**. CI supplies service containers.
Deno uses `--no-prompt`, consumer-scoped `--allow-read`, DB endpoint-scoped
`--allow-net`, and `--allow-env=SQLBRAID_POSTGRES_URL,SQLBRAID_MYSQL_URL,PG*,NODE_*,USER,USERNAME,TZ`.
It needs no `-A`, subprocess, write, or FFI permission.

Read [`PLAN.md`](./PLAN.md) for the authoritative roadmap and [`AGENTS.md`](./AGENTS.md) before broad architectural changes.
