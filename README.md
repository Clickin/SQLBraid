# SQLBraid

**Write SQL. Keep TypeScript. Skip the query-builder translation layer.**

SQLBraid is a SQL-first data-access toolkit for TypeScript. It keeps ordinary SQL visible while adding safe value binds, readable dynamic SQL, explicit result contracts, Standard Schema result mapping, physical connection ownership, and driver-owned transports.

```sh
pnpm add sqlbraid
```

```ts
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";
import { DatabaseSync } from "node:sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
const db = createNodeSqliteDatabase(native);
const users = await db.all(sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id = ${userId}
`);
```

Application code installs the unscoped `sqlbraid` facade and imports a
combined driver+dialect/query subpath such as `sqlbraid/pg`, `sqlbraid/mysql2`,
`sqlbraid/mariadb`, `sqlbraid/node-sqlite`, `sqlbraid/better-sqlite3`,
`sqlbraid/libsql`, `sqlbraid/sqlite-wasm`,
`sqlbraid/d1`, `sqlbraid/oracledb`, or `sqlbraid/tedious`. The facade has no implicit
default dialect; its root exports only common runtime contracts. The granular
`@sqlbraid/*` packages remain available for custom integrations and tooling.

> **Release status:** pre-release / release candidate. [Versioned support records](support/targets/)
> identify each certified database/driver/profile/runtime tuple, implementation
> revision, and workflow evidence. Changed revisions require fresh exact-SHA
> Runtime, Documentation, and Release gates; neighboring versions do not inherit
> certification. No tag, npm publication, Pages deployment, or release
> authorization is implied.

[Get started](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [Documentation](https://clickin.github.io/SQLBraid/latest/) · [Data representations](https://clickin.github.io/SQLBraid/latest/concepts/data-representation/) · [Public API audit](./docs/public-api-audit.md) · [Driver-author guide](./docs/driver-author-guide.md)

## The core boundary

- Ordinary `${value}` interpolation is always a value bind.
- Structural SQL uses explicit helpers such as `sql.ident`, `sql.fragment`, `sql.list`, `sql.join`, `sql.raw`, and `sql.empty`.
- `@braid` directives (`if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`) are lowered by the compiler; inactive branches stay lazy.
- The renderer produces one immutable logical `RenderedStatement`: `segments.length === parameters.length + 1`. A rendered parameter is never SQL, an identifier, a nested query, or a driver fragment.
- The selected adapter owns placeholder materialization. `$1`, `?`, `:1`, `@p1`, and native value-template syntax are transport details, not logical shape identity.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${teamId != null}*/
      AND team_id = ${teamId}
    /*@braid end*/
  /*@braid end*/
`;
```

Use `sql.bind(value, hint)` only when a first-party adapter documents the database parameter metadata. Hints are not application codecs or Standard Schema validators; an adapter honors a hint or rejects it before I/O.

## Result contracts and mapping

```ts
sql.rows<UserRow>`SELECT ...`;
sql.command`UPDATE ...`;
sql.call({ resultSets: [UserSchema] as const })`CALL ...`;
sql`driver-specific SQL`; // unknown result kind
```

`db.all`, `db.one`, `db.maybeOne`, and `db.stream` require `sql.rows`. `db.execute` accepts row, command, or unknown queries and checks the actual result kind after execution. `db.call` accepts `sql.call` and returns `output`, ordered heterogeneous `resultSets`, and an optional `returnValue`.

`sql.out(name, hint?)` is valid for `sql.call` and Oracle row-returning DML. `sql.inOut(name, value, hint?)` is call-only. Cursor and emitted result sets are materialized and closed before asynchronous mapping; raw cursors, portals, requests, and carrier rows do not escape. A result-kind mismatch is `BRAID_RESULT_KIND` after execution and cannot undo a root side effect.

Attach a Standard Schema to a row query or pass one per execution:

```ts
const eventQuery = sql.rows(EventSchema)`SELECT created_at, payload FROM events`;
const event = await db.one(eventQuery, { schema: EventSchema });
```

Mapping is one row to one application value. SQLBraid does not hydrate relations, maintain identity maps, or infer arbitrary `SELECT`/`JOIN` result types.

## Runtime API

The public runtime surface is intentionally small:

```ts
interface ExecutionOptions { signal?: AbortSignal }
interface RowValidationOptions<Row> extends ExecutionOptions { schema?: StandardSchemaV1<unknown, Row> }
interface StreamOptions<Row> extends RowValidationOptions<Row> {}

type TransactionIsolation =
  | "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";
interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}

await db.execute(query, options?);
await db.all(rows, options?);
await db.one(rows, options?);
await db.maybeOne(rows, options?);
await db.call(call, options?);
await db.batch(queries, options?);
await db.bulk(inputs, factory, options?);
await db.environment(options?);
db.stream(rows, options?);
await db.session(callback);
await db.tx(callback);
await db.tx(transactionOptions, callback);
```

All execution methods accept options in the trailing position. `signal` is an `AbortSignal`; cancellation is capability-driven. An already-aborted signal rejects with its `reason`. An active signal requires the adapter's `statement.cancel` capability; otherwise the operation fails with `UnsupportedFeatureError` (`BRAID_CANCEL_UNSUPPORTED`) rather than pretending cancellation is supported.

### Sessions, providers, and physical leases

A direct database wraps one physical executor. A pooled database wraps a `ConnectionProvider`:

```ts
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  acquire(): Promise<ConnectionLease>;
}

interface ConnectionLease extends QueryExecutor {
  release(options?: { discard?: boolean }): void | Promise<void>;
}
```

A provider is a source of leases; it is not itself a physical connection and must not be modeled as a fake executor whose transaction commands can land on unrelated connections. Each pooled root operation acquires one lease, performs physical I/O, releases it, and then maps materialized results. A stream keeps its lease until the driver resource closes. The application owns pool shutdown.

`db.session(async (session) => ...)` acquires one lease for the callback and reuses that physical lease for nested operations and nested sessions. `db.tx(...)` inside a session uses the session lease; it does not reacquire. The root database must not be used to escape the session. An unavailable session primitive fails with `BRAID_SESSION_UNSUPPORTED`; root misuse, closed callback handles, and sibling/parent transaction handles fail with the runtime's scope errors.

`db.tx` begins and ends one physical transaction. If transactions are absent, the operation fails with `BRAID_TX_UNSUPPORTED`. Nested transactions use savepoints when the executor exposes them. Explicit transaction options are supported only when the adapter advertises the matching capability; valid but unsupported isolation/access options fail with `UnsupportedFeatureError` (`BRAID_TX_OPTION_UNSUPPORTED`, feature `transaction.isolation.<level>` or `transaction.read-only`). Malformed runtime values fail before acquisition with `TypeError` / `BRAID_TX_OPTIONS_INVALID`. Nested `tx(options, callback)` is rejected with `BRAID_TX_OPTIONS_NESTED` rather than silently changing an active transaction. If options are omitted, the database/driver default remains in force; SQLBraid does not guess a profile or reset a session.

```ts
await db.tx({ isolation: "serializable", readOnly: true }, async (tx) => {
  await tx.all(sql.rows<{ id: string }>`SELECT id FROM accounts`);
});
```

Transaction-control uncertainty poisons a direct resource or discards a pooled lease. Use the innermost callback handle while a savepoint is active.

### Prepared queries

`prepare` accepts an input factory (required input by default, or explicitly
`{ input: "required" }`) or a zero-input factory that explicitly declares
`{ input: "none" }`. The factory is evaluated per execution, renders once, and
is locked to the first logical shape: result kind, canonical segments, ordered
hint/direction/output metadata, and dialect. Values may change; shape changes
fail before driver I/O with `BRAID_PREPARED_SHAPE`.

```ts
const byId = db.prepare(
  "user-by-id",
  (id: string) => sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id = ${id}
`,
);

await byId.execute("u_1", { signal });
await byId.all("u_1", { schema: UserSchema });
await byId.one("u_1");
await byId.maybeOne("u_1");
for await (const row of byId.stream("u_1", { signal })) console.log(row);
```

A zero-input prepared query is declared with
`db.prepare("users", () => query, { input: "none" })` and takes options as its
only execution argument (`prepared.all({ signal })`). Row queries expose
`execute`, `all`, `one`, `maybeOne`, and `stream`; command/unknown queries
expose `execute`; call queries expose `call`. Prepared means a stable SQLBraid
application shape, not a universal native/server prepared cache. The adapter
reports effective reuse.

## Observers and diagnostics

`DatabaseOptions` accepts `observers`. Events include `query:ready`, `query:result`, `query:mapped`, `query:error`, `bulk:ready`, `bulk:result`, `stream:start`, `stream:end`, and `transaction`. `query:ready` is emitted after pure binding description and before lease acquisition. It exposes the effective adapter/dialect/transport/reuse plan, declared kind, values and lazy `literalizedSql()` diagnostics. Bind values are not logged by SQLBraid; applications own redaction and retention.

Observers run in registration order and are observe/fail-only: they may inspect or throw, but cannot rewrite SQL, replace binds/results, retry, or route. A pre-I/O failure prevents execution; a post-I/O failure cannot undo a root side effect. Timing fields are named `durationMs`.

Optional `@sqlbraid/opentelemetry` adds SQLBraid-level DB client spans and the
stable `db.client.operation.duration` metric. It keeps SDK/exporter ownership
with the application, omits bind values and literalized SQL, and does not add
itself to the `sqlbraid` facade.

## Dialects, drivers, and runtimes

These are independent axes:

```text
dialect  SQL surface, quoting, lexical behavior
 driver  protocol/API bridge, binding/materialization, result normalization
runtime  Node, Bun, Deno, browser, or Worker host
```

First-party dialect roots are PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL Server. Driver subpaths include `pg`, `mysql2`, MariaDB Connector/Node.js, `node:sqlite`, `better-sqlite3`, libSQL, SQLite WASM, D1, node-oracledb Thin, and Tedious. A new JavaScript runtime does not require a new dialect or adapter when an existing driver API works.

SQLite keeps one dialect while exposing driver-specific subpaths:
`sqlbraid/node-sqlite`, `sqlbraid/better-sqlite3`, `sqlbraid/libsql`,
`sqlbraid/sqlite-wasm`, and `sqlbraid/d1`. Node `node:sqlite` and
better-sqlite3 execute synchronously at the physical boundary; the public
`Database` remains async, and the `Awaitable<T>` SPI type avoids adding
unnecessary Promise wrappers. Synchronous better-sqlite3 calls still block the
JavaScript event loop. libSQL requires an explicit `{ intMode: "string" }`
assertion for exact INTEGER strings, uses its interactive transaction handle
for transaction continuity, does not claim pinned ordinary sessions, and
rejects streaming rather than buffering.

Bun's first-party SQL adapter is a single adapter family. The user selects `dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`; the adapter does not auto-detect SQL semantics from a connection. Bun 1.3.14 has no supported active cancellation (`BRAID_CANCEL_UNSUPPORTED`) and stream/routine carriers remain unsupported. Its `result.rows`/`result.command` metadata is guarded by `bun-sql.result-kind-metadata`; for Bun MySQL/MariaDB, an empty `SELECT` and zero-affected DML/DDL are `BRAID_RESULT_KIND_AMBIGUOUS` after execution because the driver reports `command: null` and `affectedRows: 0`, so side effects may already have occurred. Nonempty rows and positive command counts are the supported cases. Deno uses existing first-party driver adapters where their public Node-compatible API works; it does not receive a new Deno-specific dialect. Runtime labels are evidence labels, not promises: Official requires the exact runtime/driver/database/profile tuple in support evidence; otherwise use Compatible, Custom, or Unsupported.

Do not promote an unverified server version, runtime, profile option, or capability from a neighboring tuple. `db.environment({ targets?, refresh? })` is observational and returns `compatible` when no single verified exact target matches. Capability keys use the canonical names:

```text
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

Support capability is capability-driven rather than a promise that every dialect combination has every operation. DML `RETURNING`/`OUTPUT` remains native SQL and materialized unless the selected adapter's evidence says otherwise.

## Deliberate nonfeatures

SQLBraid is not an ORM, query-builder-first language, complete SQL parser, universal SQL compiler, input-codec framework, retry/router, audit-log store, or connection-pool implementation. It does not rewrite SQL, infer arbitrary result models, hydrate object graphs, or silently emulate missing cursors, transactions, cancellation, or routine channels. Metadata is open-world positive evidence; missing facts do not prove SQL invalid. Numeric exactness, JSON/temporal profiles, and nested containers remain separate evidence boundaries. Exact database numerics are canonical strings; approximate IEEE values are numbers; `decodeExactInteger` is an application opt-in transform. Bun's 1.3.14 profile uses `{ bigint: true }` for PostgreSQL/MySQL/MariaDB and `{ safeIntegers: true }` for SQLite. Integral `Number` rows reject; PostgreSQL decimal is text, MySQL/MariaDB DECIMAL and binary byte carriers require authored SQL text/hex conversion, and SQLite native decimal is unsupported. Bun SQLite's mixed-quote SQL classifier also limits result-kind guarantees; bind JSON values. `null` is SQL `NULL`; ordinary `undefined` IN binds fail before acquisition with `BRAID_BIND_VALUE_UNSUPPORTED`.

## Packages

| Package                     | Responsibility                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sqlbraid`                  | Canonical runtime facade; combined driver+dialect/query subpaths use matching adapters, while `/bun-sql` is a multi-dialect adapter with an explicit dialect |
| `@sqlbraid/core`            | Public contracts, rendered statements, binding SPI, observers, Standard Schema types                                                                         |
| `@sqlbraid/template`        | Dialect-neutral tags, directives, fragments, `sql.bind`                                                                                                      |
| `@sqlbraid/runtime`         | Execution, sessions, leases, transactions, prepared shapes, streams, mapping                                                                                 |
| `@sqlbraid/postgres`        | PostgreSQL dialect/TypePolicy; `/pg`; `/inspector`                                                                                                           |
| `@sqlbraid/mysql`           | MySQL dialect/TypePolicy; `/mysql2`; `/inspector`                                                                                                            |
| `@sqlbraid/mariadb`         | MariaDB dialect/TypePolicy; `/mariadb`; `/inspector`                                                                                                         |
| `@sqlbraid/sqlite`          | SQLite dialect; `/node-sqlite`, `/better-sqlite3`, `/libsql`, `/wasm`, `/d1`; `/inspector`                                                                   |
| `@sqlbraid/oracle`          | Oracle portable dialect/TypePolicy; `/oracledb`; `/inspector`                                                                                                |
| `@sqlbraid/mssql`           | SQL Server portable dialect/TypePolicy; `/tedious`; `/inspector`                                                                                             |
| `@sqlbraid/bun-sql`         | Bun.SQL multi-dialect driver adapter; requires user-selected dialect                                                                                         |
| `@sqlbraid/compiler`        | Guarded-template lowering and source maps                                                                                                                    |
| `@sqlbraid/vite`            | Vite pre-transform                                                                                                                                           |
| `@sqlbraid/opentelemetry`   | Optional OpenTelemetry DB client spans and duration metrics                                                                                                  |
| `@sqlbraid/metadata`        | Database-fact snapshots, validation, hashing, drift                                                                                                          |
| `@sqlbraid/codegen`         | Pure metadata + TypePolicy → Row/Insert/Update source                                                                                                        |
| `@sqlbraid/tooling`         | Node-first config/workspace/evidence services                                                                                                                |
| `@sqlbraid/operations`      | Fingerprints and declaration manifests                                                                                                                       |
| `@sqlbraid/cli`             | Optional CLI for codegen, inspect, diagnostics, and drift                                                                                                    |
| `@sqlbraid/language-server` | Standard stdio LSP                                                                                                                                           |

Runtime packages do not pull tooling, metadata, codegen, editor, or Vite
dependencies. The facade also does not install database drivers; install the
database driver separately. See the [package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) and [release readiness](./docs/SQLBraid_release_readiness.md).

## Development

The repository uses Node.js `>=22.18.0` and pnpm. Run the project checks from a clean checkout before making a release decision; this README records no result for the current documentation/API revision. Publication, tagging, npm provenance, Marketplace release, and Pages deployment are separate authorized operations.
