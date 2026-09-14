# SQLBraid v1 Product Plan

> Status: authoritative product and engineering plan
> Scope: SQL-first TypeScript data access under `@sqlbraid/*`
> Dynamic SQL namespace: `/*@braid ...*/`

## 1. Product definition

SQLBraid keeps SQL as SQL while adding safe value binding, bounded dynamic SQL, explicit result contracts, Standard Schema row mapping, physical connection ownership, transaction-safe execution, observation, and first-party dialect/driver integrations. It is not an ORM, query-builder-first language, complete SQL compiler, validation framework, or pool implementation.

The durable boundaries are:

```text
dialect  SQL surface, quoting, lexical profile, primitive database semantics
driver   protocol/API bridge, binding/materialization, result normalization
runtime  execution, leases, sessions, transactions, mapping, observation
host     Node / Bun / Deno / browser / Worker deployment evidence
```

A new driver or JavaScript runtime does not automatically create a dialect. A
new support label requires executable evidence for the exact database, driver,
profile, runtime, and relevant capability tuple.

## 2. Authoring contract

Ordinary interpolation is always a value bind. Structure is explicit:
`sql.ident`, `sql.fragment`, `sql.raw`, `sql.empty`, `sql.join`, and `sql.list`.
The supported directive set is `if`, `choose`, `when`, `otherwise`, `where`,
`set`, and `trim`; conditions are TypeScript expressions. The compiler owns
lowering and source maps, not database SQL semantics.

Rendering produces one immutable logical statement:

```ts
interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly resultKind: "rows" | "command" | "call" | "unknown";
  readonly dialectId: string;
}
```

`segments.length === parameters.length + 1` is mandatory. A rendered parameter
is always a value, never SQL, an identifier, a nested query, or a driver
fragment. Adapters own placeholder materialization and transport selection.
Prepared shape identity uses logical segments, result kind, and ordered parameter
metadata; `$1`, `?`, `:1`, and `@p1` are never shape identity.

## 3. Public execution contract

The runtime exports one trailing-options convention:

```ts
interface ExecutionOptions { signal?: AbortSignal }
interface RowValidationOptions<Row> extends ExecutionOptions {
  schema?: StandardSchemaV1<unknown, Row>;
}
interface StreamOptions<Row> extends RowValidationOptions<Row> {}

type TransactionIsolation =
  | "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";
interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}
```

`execute`, `all`, `one`, `maybeOne`, `call`, `batch`, `bulk`, `stream`, and
prepared operations all take their options last. `db.session(callback)` pins
one leased physical connection for the callback; nested sessions reuse it.
`db.tx(callback)` begins a transaction on the current session lease, or acquires
one root lease, and nested transactions use savepoints when available.
`db.tx(options, callback)` applies explicit isolation/access options only when
the adapter advertises them. Nested explicit transaction options are rejected;
the runtime never silently changes an active transaction.

A pre-aborted signal rejects with its reason. An active signal is honored only
when the adapter exposes `statement.cancel`; otherwise SQLBraid rejects with
`UnsupportedFeatureError` and `BRAID_CANCEL_UNSUPPORTED`. This is a
capability boundary, not a promise of cancellation for every adapter.

Result APIs are kind-safe:

- row queries expose `execute`, `all`, `one`, `maybeOne`, and `stream`;
- command and unknown queries expose `execute`;
- call queries expose `call`;
- `BRAID_RESULT_KIND` is checked after driver execution and cannot undo a root
  side effect.

A prepared query accepts `prepare(name, () => query)` or
`prepare(name, (input) => query)`. The factory runs per execution and renders
once. The first logical result kind, dialect, segments, hint/direction/output
metadata, and cardinality become the shape lock; values may change. A shape
change fails before I/O with `BRAID_PREPARED_SHAPE`. A prepared query is a
stable application shape, not a universal server prepared cache.

## 4. Sessions, providers, and leases

`createDatabase(executor)` wraps one physical resource. `createPooledDatabase`
wraps a `ConnectionProvider`; the provider owns acquisition policy and each
`ConnectionLease` owns one physical resource until release:

```ts
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  acquire(): Promise<ConnectionLease>;
}
interface ConnectionLease extends QueryExecutor {
  release(options?: { discard?: boolean }): void | Promise<void>;
}
```

Providers are not physical connections and must not be modeled as fake
executors. Every pooled root operation acquires one lease, performs DB I/O,
releases it, then maps materialized results. Streams retain the lease through
cursor/request cleanup. Providers and leases expose the same immutable
`statementBinding` adapter object. A mismatch is an integration error, not a
fallback.

Root use from an active session/transaction is rejected rather than escaping to
another connection. Callback handles close at scope end; parent/sibling handles
are rejected while a nested savepoint is active. Uncertain transaction cleanup
poisons direct resources and discards pooled leases.

## 5. Driver and unsupported SPI

Custom integrations implement the value-only executor SPI:

```ts
interface QueryExecutor {
  readonly statementBinding: StatementBindingAdapter;
  query(statement: RenderedStatement, binding?: StatementBindingDescription,
    options?: ExecutionOptions): Promise<QueryExecutionResult>;
  stream(statement: RenderedStatement, binding?: StatementBindingDescription,
    options?: ExecutionOptions): AsyncIterable<unknown>;
  call(statement: RenderedStatement, binding?: StatementBindingDescription,
    options?: ExecutionOptions): Promise<DriverRoutineResult>;
  bulk?(bulk: RenderedBulk, binding: BulkBindingDescription,
    options?: ExecutionOptions): Promise<BulkExecutionResult>;
  begin?(options?: TransactionOptions): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  savepoint?(name: string): Promise<void>;
  rollbackTo?(name: string): Promise<void>;
  releaseSavepoint?(name: string): Promise<void>;
}
```

`StatementBindingAdapter.describe` and `describeBulk` are pure pre-acquire
materialization steps. They validate hints and return the effective transport
and reuse plan. Custom drivers must implement `stream` and `call` explicitly;
unsupported paths throw `UnsupportedFeatureError` with a stable `BRAID_*` code
(for example `BRAID_STREAM_UNSUPPORTED` or `BRAID_CALL_UNSUPPORTED`). They must
not buffer a query to fake streaming, guess routine carriers, silently ignore
hints, or invent transaction/cancellation support. See the driver-author guide.

The public unsupported class is:

```ts
new UnsupportedFeatureError(
  feature: string,
  code: `BRAID_${string}`,
  message: string,
  options?: ErrorOptions,
);
```

## 6. Database and capability policy

First-party roots cover PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL
Server. Adapter subpaths own `pg`, `mysql2`, MariaDB Connector/Node.js,
`node:sqlite`, SQLite WASM, D1, node-oracledb Thin, and Tedious integration.
Bun uses one first-party SQL adapter family with explicit user-selected
`dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`; it does not infer a
dialect from the connection. On Bun 1.3.14, active cancellation is unsupported
(`BRAID_CANCEL_UNSUPPORTED`), and stream/routine carriers are unsupported.
`result.rows`/`result.command` is guarded by `bun-sql.result-kind-metadata`; for
MySQL/MariaDB, empty `SELECT` and zero-affected DML/DDL are
`BRAID_RESULT_KIND_AMBIGUOUS` after execution because `command` is null and
`affectedRows` is zero, so side effects may already have occurred. Deno reuses
existing adapter paths where the public API works; no Deno-specific dialect is
invented.

Runtime support labels are evidence labels:

- **Official**: exact executable CI evidence for the complete tuple;
- **Compatible**: no exact certified target, though public APIs may work;
- **Custom**: user-provided executor/provider integration;
- **Unsupported**: a required capability is absent or checks reject it.

`db.environment({ targets?, refresh? })` is an observed snapshot, not a support
manifest. An unmatched or incomplete tuple remains `compatible`. Prose, a
neighboring version, a local binding check, or a type assertion never promotes
an unverified tuple.

The canonical capability identifiers are:

```text
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

The environment catalog owns these keys and their conditions. Do not add
obsolete aliases such as `execution.prepared`, `execution.stream`,
`routine.resultsets`, or `routine.return-status`.

## 7. Deliberate nonfeatures

Pre-release does not include ORM hydration, query-builder-first authoring,
complete SQL grammar/semantic inference, multi-row object graphs, a concrete
validator dependency, universal input codecs, SQL/bind/result rewriting,
automatic retry/routing, audit-log storage, hidden transactions, fake cursors,
or a universal prepared cache. DML `RETURNING`/`OUTPUT` remains authored SQL;
materialization and rollback behavior are adapter capabilities. Numeric fidelity,
JSON/temporal representation, and nested-container behavior remain separate
transport evidence boundaries. Bun 1.3.14 configures `{ bigint: true }` for
PostgreSQL/MySQL/MariaDB and `{ safeIntegers: true }` for SQLite; absent column
metadata means integral and integral-approximate `Number` rows are rejected as
ambiguous. PostgreSQL decimal output is text; MySQL/MariaDB DECIMAL and binary
outputs have indistinguishable byte carriers and reject unless the user authors
SQL text/hexadecimal conversion. SQLite native decimal is unsupported.
MariaDB/SQLite JSON is text; PostgreSQL/MySQL native JSON can round nested
numbers. Bun SQLite result kinds remain guarded by its native mixed-quote SQL
classifier limitation; bind JSON values rather than rewriting SQL.
Metadata is positive open-world evidence.

Application input mapping/codecs, richer database verification, pipeline/COPY,
query transformers, retry/routing, and OpenTelemetry remain future candidates;
this plan does not create speculative transaction profiles or support matrices.

## 8. Phase history and current documentation update

PV1–PV18 established the contracts above: explicit result kinds, Standard
Schema mapping, logical binding transport, observer diagnostics, streaming,
routines, bulk, representation profiles, metadata/codegen, LSP, Vite, MariaDB,
Oracle/SQL Server roots, Browser WASM, and D1.

The last exact-SHA PV18 verification used revision
`8da8167e027320fcc9bb2aac16b0903c64147940` and succeeded in Runtime
([34856051046](https://github.com/Clickin/SQLBraid/actions/runs/34856051046)),
Documentation ([34856051102](https://github.com/Clickin/SQLBraid/actions/runs/34856051102)),
and Release ([34856063326](https://github.com/Clickin/SQLBraid/actions/runs/34856063326)).
Those runs are historical evidence for that exact revision. The current phase-J
API/documentation tree requires new exact-final evidence before any support label
or release claim is updated. No tag, npm publication, Pages deployment, or
release authorization follows from those past runs.

## 9. Release definition

A release candidate requires a clean exact revision, executable runtime and
adapter evidence for every claimed tuple/capability, documentation and
translation freshness, package/export audit, and an immutable release dry-run.
The release workflow must run before publication. User acceptance and explicit
release authorization remain separate gates.
