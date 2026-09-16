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
prepared operations all take their options last. The public `Database` contract
remains asynchronous regardless of whether the underlying driver performs its
physical work synchronously or asynchronously. Materialized operations return
`Promise`; streams return `AsyncIterable`. Do not introduce a public
`Database<"sync" | "async">` mode or duplicate `SyncDatabase` surface merely to
mirror an embedded driver's calling convention.

`db.session(callback)` pins one leased physical connection when the selected
adapter guarantees `session.pinned`; nested sessions reuse it. `db.tx(callback)`
begins a transaction on the current session lease, or acquires one root execution
resource whose transaction continuity is guaranteed by the adapter. Nested
transactions use savepoints when available. `db.tx(options, callback)` applies
explicit isolation/access options only when the adapter advertises them. Nested
explicit transaction options are rejected; the runtime never silently changes an
active transaction.

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

A prepared query accepts `prepare(name, () => query, { input: "none" })` or
`prepare(name, (input) => query)`. The explicit zero-input marker determines
the options-only execution form; JavaScript function arity is not consulted.
Input factories use `(input, options?)` even with rest or default parameters.
The factory runs per execution and renders
once. The first logical result kind, dialect, segments, hint/direction/output
metadata, and cardinality become the shape lock; values may change. A shape
change fails before I/O with `BRAID_PREPARED_SHAPE`. A prepared query is a
stable application shape, not a universal server prepared cache.

## 4. Sessions, providers, and leases

`createDatabase(executor)` wraps one serialized execution ownership domain.
For ordinary physical drivers that domain is one physical connection/resource.
Adapters backed by higher-level clients may use a logical execution resource only
when their advertised capabilities remain truthful: transaction continuity and
session pinning are separate contracts and must never be inferred from object
identity alone.

`createPooledDatabase` wraps a `ConnectionProvider`; the provider owns
acquisition policy and each `ConnectionLease` owns one physical resource until
release:

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

`session.pinned` means all operations in the session closure are guaranteed to
use one pinned database session/connection according to the driver contract.
A client whose ordinary operations may use unrelated logical connections must
advertise `session.pinned` as unsupported even if it can provide a separate
interactive transaction handle.

When `transaction` is guaranteed, `begin/query/commit` (or the adapter's
underlying transaction-handle equivalent) must form one continuous transaction.
An adapter may acquire or switch to a dedicated transaction object during
`begin()`, but every subsequent transaction-scoped query, savepoint, commit and
rollback must use that same transaction resource until closure. Calling `BEGIN`,
ordinary queries and `COMMIT` through a client that may route each call to a
different logical connection is invalid.

Root use from an active session/transaction is rejected rather than escaping to
another connection. Callback handles close at scope end; parent/sibling handles
are rejected while a nested savepoint is active. Uncertain transaction cleanup
poisons direct resources and discards pooled leases.

## 5. Driver and unsupported SPI

Custom integrations implement the value-only executor SPI. Physical driver
methods may complete synchronously or asynchronously; the runtime normalizes
that difference at its async public boundary:

```ts
type Awaitable<T> = T | PromiseLike<T>;

interface QueryExecutor {
  readonly statementBinding: StatementBindingAdapter;
  query(statement: RenderedStatement, binding?: StatementBindingDescription,
    options?: ExecutionOptions): Awaitable<QueryExecutionResult>;
  stream(statement: RenderedStatement, binding?: StatementBindingDescription,
    options?: ExecutionOptions): AsyncIterable<unknown>;
  call(statement: RenderedStatement, binding?: StatementBindingDescription,
    options?: ExecutionOptions): Awaitable<DriverRoutineResult>;
  bulk?(bulk: RenderedBulk, binding: BulkBindingDescription,
    options?: ExecutionOptions): Awaitable<BulkExecutionResult>;
  begin?(options?: TransactionOptions): Awaitable<void>;
  commit?(): Awaitable<void>;
  rollback?(): Awaitable<void>;
  savepoint?(name: string): Awaitable<void>;
  rollbackTo?(name: string): Awaitable<void>;
  releaseSavepoint?(name: string): Awaitable<void>;
}
```

Keep `QueryExecutor.stream()` as `AsyncIterable`; do not widen the SPI to a
sync/async iterable union merely because an embedded SQLite driver exposes a
synchronous iterator. A synchronous driver may bridge its native iterator with
a thin async generator while preserving iterator cleanup. The public stream
lifecycle, early-return cleanup and observer semantics remain uniform.

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

## 6. Database, driver, runtime, and compatibility policy

First-party roots cover PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL
Server. Adapter subpaths own `pg`, `mysql2`, MariaDB Connector/Node.js,
`node:sqlite`, `better-sqlite3`, libSQL, SQLite WASM, D1, node-oracledb Thin,
and Tedious integration. SQLite remains one dialect: adding another SQLite
JavaScript driver does not duplicate dialect/type-policy logic.

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

Versioned capability records in `support/targets/` remain exact certification
evidence for database + driver + profile + runtime + capability tuples. Do not
inflate that dataset with every install/runtime compatibility combination.
Package/runtime compatibility is a separate concern and may use a dedicated
machine-readable compatibility manifest as CI input.

Node policy separates four independent concepts:

1. **Contributor/build Node**: the modern Node version required by pnpm, tsdown,
   Vitest, TypeScript and repository tooling. It may be newer than the published
   library floor.
2. **Minimum compatible Node**: the oldest Node version on which the packed
   published runtime artifacts are actually installable/importable/executable.
   Determine it from runtime syntax/API/dependency evidence, not from the age of
   SQLBraid or the newest LTS.
3. **Recommended Node**: currently supported Node LTS releases. EOL runtimes may
   remain compatible without being recommended.
4. **Driver-specific compatibility**: each first-party adapter is tested against
   exact driver/runtime versions. A driver's higher Node requirement must not
   raise unrelated SQLBraid package floors.

Compatibility CI must build/package once on the contributor toolchain and then
install the real packed tarballs under each target runtime. Do not require old
Node releases to run the repository build toolchain or Vitest. Use small
consumer smoke/integration programs with exact runtime and driver versions so a
tool dependency cannot masquerade as a library runtime requirement. Floating
`latest`, broad semver ranges, or an upstream `engines` declaration alone are
not executable compatibility evidence.

The initial Node floor investigation targets Node 16.20 as a candidate, not an
assumed guarantee. Remove or replace newer runtime-only APIs where doing so is
small and semantics-preserving, then adopt the oldest version that passes the
packed consumer gate. Keep the build target/library definitions aligned with the
chosen floor so TypeScript cannot silently permit unsupported runtime APIs.

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
query transformers, and retry/routing remain future candidates; this plan does
not create speculative transaction profiles or support matrices.

The optional `@sqlbraid/opentelemetry` package provides observe-only DB client
traces and the stable `db.client.operation.duration` metric through the
execution observer SPI. It has no built-in logger or SDK/exporter dependency,
keeps bind values and literalized SQL out of telemetry, and does not add a
facade dependency. Stream and transaction spans, pool metrics, and OTel Logs
remain future work until the OTel JS Logs signal reaches the stability level
SQLBraid requires.

Compatibility matrices added for runtime/driver verification must report only
executed combinations and must not invent capability certification for untested
tuples.

## 8. Phase history and current documentation update

PV1–PV18 established the contracts above: explicit result kinds, Standard
Schema mapping, logical binding transport, observer diagnostics, streaming,
routines, bulk, representation profiles, metadata/codegen, LSP, Vite, MariaDB,
Oracle/SQL Server roots, Browser WASM, and D1.

The RC SPI retains the async public `Database` contract while permitting sync or
async physical driver completion through `Awaitable`. SQLite first-party support
expands beyond `node:sqlite` to better-sqlite3 and libSQL without introducing a
second SQLite dialect or public sync database API. Runtime compatibility floors
are evidence-driven and separate from recommended LTS versions and exact
capability certification targets.

[Versioned support records](support/targets/) are authoritative for exact
tuple/revision/workflow certification, not this plan's implementation history.
Every changed final revision requires fresh Runtime, Documentation, and Release
gates. No tag, npm publication, Pages deployment, or release authorization
follows from implementation progress or an earlier revision's results.

## 9. Release definition

A release candidate requires a clean exact revision, executable runtime and
adapter evidence for every claimed tuple/capability, packed compatibility
evidence for every advertised runtime/driver combination, documentation and
translation freshness, package/export audit, and an immutable release dry-run.
The release workflow must run before publication. User acceptance and explicit
release authorization remain separate gates.
