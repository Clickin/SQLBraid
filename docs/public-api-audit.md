# SQLBraid public API audit

This inventory records the stable public boundary of SQLBraid 1.x. It classifies
the API and is a compatibility reference. It is not a publication claim and not a
support claim.

SQLBraid 1.0.0 is GA. The exact-SHA records below are kept as the provenance of
the pre-GA audit. They do not certify later revisions.

- The last recorded pre-GA exact-SHA verification was revision
  `8da8167e027320fcc9bb2aac16b0903c64147940` (Runtime
  [34856051046](https://github.com/Clickin/SQLBraid/actions/runs/34856051046), Docs
  [34856051102](https://github.com/Clickin/SQLBraid/actions/runs/34856051102),
  Release [34856063326](https://github.com/Clickin/SQLBraid/actions/runs/34856063326)).
- The audited remediation baseline of the recovery is `9cdc3d8`. It contains the
  isolated pnpm Vite facade gate and the OpenTelemetry API gate without an SDK.
- The final source-audit commit is `cead8f9f522f1790bc2db501503399d62a0918b4`.
  The digest follow-up, which changed only documentation, is
  `a148f52d42599e72b393b90ce0f0f2e55441df21`.

The historical CI proof above stays in this record. The local integrated
verification of the final source audit is recorded outside this repository. It
is not a publication claim.

## Classification

- **Application** — the API to write queries, execute them, map results and configure SQLBraid.
- **SPI** — the interfaces for physical drivers, providers, binding, dialects and evidence.
- **Advanced** — the compiler, metadata, codegen, tooling and editor integration.

## `@sqlbraid/core`

**Driver SPI subpath:** `@sqlbraid/core/driver` exports `CleanupAction`,
`CleanupScope`, `createCleanupScope`, `defineResultProperty` and
`assertSavepointName`.

- Drivers register resource cleanup explicitly.
- The scope runs each cleanup once, in LIFO order.
- The scope keeps the primary failure. It aggregates cleanup failures under
  `BRAID_RESOURCE_CLEANUP`.
- `disarm()` hands ownership to a different owner.
- Synchronous cleanup stays synchronous.
- The property and savepoint helpers keep the own properties of ordinary objects.
  They reject unsafe names.

These are supported interfaces for driver authors. They are not query APIs for
applications.

**Application:** `CallQuery`, `CommandQuery`, `CommandResult`, `Database`,
`DatabaseOptions`, `ExecutableQuery`, `ExecutionEvent`, `ExecutionObserver`,
`ExecutionOptions`, `ExecutionResultOf`, `PreparedFactoryOptions`,
`PreparedQuery`, `Query`,
`QueryExecutionResult`, `QueryResultKind`, `QueryRow`, `RowQuery`,
`RowValidationOptions`, `RowsExecutionResult`, `StreamOptions`, `TransactionOptions`,
`TransactionIsolation`, `RoutineCallResult`, `RoutineContract`,
`RoutineParameterDirection`, `RoutineProcedure`, `RoutineSchema`,
`RoutineResultFromContract`, `RoutineResultSet`, `RoutineResultSetTuple`,
`StandardSchemaV1`, `UnsupportedFeatureError`, `AdapterError`,
`ResultExactnessError`, `RoutineMappingError`.

`PUBLIC_ERROR_DEFINITIONS` and its types `PublicErrorDefinition` and
`PublicErrorCategory` list the error reference that is public on purpose. They
do not make every internal `BRAID_` message a stable guarantee. The error
reference in two languages links each registry code.

`WELL_KNOWN_CAPABILITIES` and `WELL_KNOWN_CAPABILITY_IDS` are the
machine-readable capability vocabulary of core. `support/capabilities.json`
copies that vocabulary for target claims and for the
[support matrix](/SQLBraid/reference/support/). The capability status is support
evidence. `canonical` and `rawRepresentations` are representation evidence that
is attached to a claim. They are not additional capability IDs.

`isPublicUnsupportedFeatureError` is the conformance predicate for a public
`UnsupportedFeatureError` feature/code pair. If the prepared-statement protocol
is unavailable, use `statement.prepare` with `BRAID_PREPARE_UNSUPPORTED`.
`BRAID_BULK_UNSUPPORTED` is reserved for `statement.bulk`. Do not use it as an
alias for prepare.

`AUTHORING_MODULE_CATALOG` is a frozen discovery catalog that contains only
data. The compiler and tooling read it. It records the identities of supported
modules that export tags, and the dialect evidence. It is not an execution API
and not an error API.

`Database` exposes `execute`, `all`, `one`, `maybeOne`, `call`, `batch`, `bulk`,
`prepare`, `stream`, `session` and `tx`. All execution operations take trailing
options. Prepared queries know their row kind:

- Row queries expose `execute`, `all`, `one`, `maybeOne` and `stream`.
- Command and unknown queries expose `execute`.
- Call queries expose `call`.

Input factories use `prepare(name, (input) => query)`, or explicitly
`{ input: "required" }`. A factory without input must declare
`prepare(name, () => query, { input: "none" })`. Its only execution argument is
the options.

`Awaitable<T> = T | PromiseLike<T>` is exported for implementations of the
physical SPI. `QueryExecutor.query`, `call`, the optional `bulk` and the
transaction-control methods can return `Awaitable`. `stream` stays
`AsyncIterable`. `ConnectionProvider.acquire()` stays a `Promise`. Thus,
synchronous drivers do not need a Promise wrapper at the physical boundary. The
public `Database` surface stays async.

**SPI:** `BindingDescription`, `BulkBindingDescription`, `BulkExecutionMode`,
`BulkExecutionResult`, `ConnectionLease`, `ConnectionProvider`, `Dialect`,
`DialectLexicalProfile`, `DriverRoutineResult`, `DriverRoutineResultSet`,
`EnvironmentCapability`, `EnvironmentOptions`, `EnvironmentSupportTarget`,
`QueryExecutor`, `RenderedBulk`, `RenderedParameter`, `RenderedStatement`,
`RoutineMappingLocation`, `RoutineResultSource`, `StatementBindingAdapter`,
`StatementBindingContext`, `StatementBindingDescription`, `TypeMapping`,
`TypePolicy`.

`QueryExecutor` methods use `(statement, binding?, options?)`. `bulk` is
optional. The transaction-control methods are optional capabilities.

The optional SPI hook `validateTransactionOptions?(options: TransactionOptions): void`
is synchronous and pure. If it is present, it decides which exact adapter
options are permitted. `begin()` must use it again. Do not duplicate its logic.

The provider and its leases must expose the same immutable identity of the
statement-binding adapter. If a provider exposes the hook, its leases must keep
an equivalent policy. The function identity can be different. If a lease does
not have the hook, the runtime uses the hook of the provider. Otherwise the
runtime keeps its conservative capability checks.

`UnsupportedFeatureError` uses `(feature, code, message, options?)` with a
`BRAID_${string}` code.

**Binding and render helpers:** `createBoundParameter`, `createBulkBindingDescription`,
`createParameterTypeHint`, `createRenderedBulk`, `createRenderedStatement`,
`createRoutineInOutParameter`, `createRoutineOutParameter`,
`createStatementBindingDescription`, `decodeExactDecimal`, `decodeExactInteger`,
`isBoundParameter`, `isRoutineParameter`, `normalizeExactInteger`,
`parameterizedSql`, `safeDatabaseCount`.

**Advanced template types:** `BindNode`, `ChooseNode`, `ChooseWhen`, `FragmentNode`,
`IdentifierNode`, `IfNode`, `ListNode`, `RawNode`, `RenderLimits`, `SQL_FRAGMENT`,
`SourceRange`, `SqlFragment`, `SqlRenderError`, `SqlTag`, `SqlTagLike`,
`TemplateIr`, `TemplateNode`, `TextNode`, `TrimAttributes`, `TrimNode`.

The block below gives the full vocabulary, grouped by evidence family. Runtime
environment declarations use these IDs. Do not add aliases such as
`routine.resultsets` or `routine.return-status`.

<!-- sqlbraid-capability-vocabulary -->

```text
# support
sql.native-transparency
sql.generated-structure
result.rows
result.command
result.multiple-sets
result.standard-schema
dml.insert-returning
dml.update-returning
dml.delete-returning
dml.merge-returning
dml.upsert-returning
session.pinned
statement.prepare
statement.cancel
statement.stream
statement.bulk
execution.bulk-fidelity
transaction
transaction.savepoint
transaction.read-only
transaction.isolation.read-uncommitted
transaction.isolation.read-committed
transaction.isolation.repeatable-read
transaction.isolation.serializable
routine.call
routine.out
routine.inout
routine.result-sets
routine.out-cursor
routine.return-value

# representation
numeric.exact-integer
numeric.exact-decimal
numeric.approximate-float
numeric.approximate-special
numeric.bind-exact
numeric.aggregate
numeric.command-metadata
numeric.special-values
numeric.scale-greater-than-precision
numeric.negative-scale
data.json-parsed
data.json-lossless-text
data.sql-variant
data.oracle-object
data.oracle-collection
data.vector
data.binary
data.uuid
data.temporal-native
data.temporal-lossless
data.timezone

# metadata
metadata.command-safe
metadata.identity
metadata.generated
metadata.routines
metadata.types
```

## Dialect and driver packages

### `sqlbraid`

**Application:** the canonical runtime facade. The root re-exports common
interfaces and runtime constructors. It does not select a dialect.

- The subpaths that combine a driver and a dialect use the matching adapter:
  `/pg`, `/mysql2`, `/mariadb`, `/node-sqlite`, `/better-sqlite3`, `/libsql`,
  `/sqlite-wasm`, `/d1`, `/oracledb` and `/tedious`.
- The `/bun-sql` subpath is a Bun.SQL adapter for many dialects. Import `sql`
  from the root of the selected dialect, and give that dialect to
  `createBunSqlDatabase`.
- The dialect-only subpaths `/postgres`, `/mysql`, `/sqlite`, `/oracle` and
  `/mssql` support custom adapters.

The facade has no dependency on the CLI, database drivers, metadata, codegen,
tooling, compiler, editor or Vite.

**Advanced:** `sqlbraid/compiled` exposes `capture` and
`assertDirectiveCondition` from `@sqlbraid/template` for lowering that the
compiler generates. It is a public entry point for generated code. It is not an
API for applications to write queries. It does not load the compiler. Use the
same version for the compiler and the runtime.

The marked inventory below classifies each key in the export map of the
`sqlbraid` package. `tests/public-api-audit.test.ts` requires that a change which
adds or removes an export also updates this inventory.

<!-- sqlbraid-facade-exports -->

```json
{
  ".": "Application",
  "./pg": "Application",
  "./mysql2": "Application",
  "./mariadb": "Application",
  "./node-sqlite": "Application",
  "./better-sqlite3": "Application",
  "./libsql": "Application",
  "./sqlite-wasm": "Application",
  "./d1": "Application",
  "./oracledb": "Application",
  "./tedious": "Application",
  "./bun-sql": "Application",
  "./postgres": "Application",
  "./mysql": "Application",
  "./sqlite": "Application",
  "./oracle": "Application",
  "./mssql": "Application",
  "./compiled": "Advanced"
}
```

<!-- /sqlbraid-facade-exports -->

```ts
import { createBunSqlDatabase } from "sqlbraid/bun-sql";
import { sql } from "sqlbraid/postgres";

const client = new Bun.SQL(process.env.DATABASE_URL!);
const db = createBunSqlDatabase(client, { dialect: "postgres" });
const rows = await db.all(sql.rows`SELECT id FROM users`);
```

| Package              | Application surface                            | SPI / advanced surface                                                                                      |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@sqlbraid/postgres` | `sql`, `postgresParameter.refcursor()`         | dialect, TypePolicy, representation profiles, `/pg`, `/inspector`                                           |
| `@sqlbraid/mysql`    | `sql`                                          | dialect, TypePolicy, representation profiles, `/mysql2`, `/inspector`                                       |
| `@sqlbraid/mariadb`  | `sql`                                          | dialect, TypePolicy, representation profiles, `/mariadb`, `/inspector`                                      |
| `@sqlbraid/bun-sql`  | `createBunSqlDatabase`, `createBunSqlProvider` | Bun.SQL multi-dialect adapter; requires a user-selected `postgres`, `mysql`, `mariadb`, or `sqlite` dialect |
| `@sqlbraid/sqlite`   | `sql`                                          | dialect, TypePolicy, `/node-sqlite`, `/better-sqlite3`, `/libsql`, `/wasm`, `/d1`, `/inspector`             |
| `@sqlbraid/oracle`   | `sql`, `oracleParameter`                       | portable dialect/TypePolicy, `/oracledb`, `/inspector`                                                      |
| `@sqlbraid/mssql`    | `sql`, `mssqlParameter`                        | portable dialect/TypePolicy, `/tedious`, `/inspector`                                                       |

Portable dialect roots do not load optional native driver dependencies. An
adapter in a subpath must obey these rules:

- It keeps the logical value boundary.
- It exposes a stable binding adapter.
- It reports unsupported capabilities explicitly.

The Bun adapter family accepts a PostgreSQL, MySQL, MariaDB or SQLite dialect
that the user selects. It does not detect the dialect automatically. Deno uses
the existing driver subpaths where the driver API works. These runtime
statements are compatibility guidance. They are not Official support labels.

Bun.SQL MySQL and MariaDB reject explicit `readOnly: true` and `readOnly: false`
before I/O, with `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`. The
reason is that Bun 1.3.14 keeps the state of a failed read-only statement across
a rollback on the same connection. If you omit the option, the native session
default stays. This is not a forced read-write mode. SQLBraid discards
contaminated reservations. The access modes of Bun.SQL PostgreSQL and all
representation-profile options do not change.

The SQLite adapters have different boundaries on purpose. They are not
interchangeable:

- `better-sqlite3` is synchronous and blocks the event loop, although its public
  database wrapper is async. Its exact INTEGER profile uses `safeIntegers(true)`
  on each statement.
- The libSQL adapter requires an explicit `intMode: "string"` assertion. It uses
  an interactive transaction handle for continuity. It does not claim
  `session.pinned`. It does not fake `statement.stream` with a buffer.
- Local `file:` libSQL clients and libSQL clients with an unknown protocol omit
  the optional `command.insertId`. Their native ROWID metadata cannot prove
  exactness. When you need that value, use an explicit `INSERT ... RETURNING`
  row declaration. Affected-row counts and transaction support do not change.
- A local libSQL test does not certify the HTTP, WebSocket, browser or Worker
  transports. Each promoted label needs evidence for the exact runtime, driver
  version, profile and workflow.

## Runtime and tooling packages

- `@sqlbraid/runtime`: `createDatabase`, `createPooledDatabase`,
  `DatabaseCardinalityError`, `DatabaseResultKindError`,
  `DatabaseResultValidationError` and `DatabaseScopeError`.
- `@sqlbraid/template`: configured SQL tags, fragments, directives and `sql.bind`.
- `@sqlbraid/compiler`: source analysis, diagnostics, lowering, source maps,
  `transformSource` and checker contexts (`TypeScriptProjectContext`,
  `TypeScriptSourceContext`, `createProjectContext`, `createSourceContext`).
- `@sqlbraid/vite`: a Vite pre-transform. Vite stays responsible for TS and JSX.
- `@sqlbraid/metadata`: snapshots, validation, hashing, drift and the model for inspectors.
- `@sqlbraid/codegen`: the pure `generateModels` and deterministic model source.
- `@sqlbraid/tooling`: Node-first services for config, workspace and evidence.
- `@sqlbraid/operations`: fingerprints and declaration manifests.
- `@sqlbraid/cli`: the optional entry point for the CLI process. Install it
  separately for the codegen, inspect, diagnostics and drift commands.
- `@sqlbraid/language-server`: an embedded service and the standard stdio LSP transport.

Runtime packages do not get metadata, compiler, codegen, tooling, editor or Vite
dependencies. Metadata is open-world positive evidence. An absent object does
not become an invalid-SQL diagnostic.

## Deliberate nonfeatures

SQLBraid does not have these features:

- a universal input codec;
- an interceptor that rewrites SQL or results;
- automatic retry or routing;
- hidden transactions;
- a complete SQL grammar;
- ORM graph hydration;
- a universal prepared cache;
- an invented fallback for streams or calls.

`db.environment()` only observes. If no exact verified target matches, it
returns `compatible`. A neighboring runtime, server version, profile option or
local test cannot promote an unverified tuple.

## Compatibility policy

This audit classifies the public boundary. It does not make each exported
symbol a support promise. Compatibility is evaluated for each surface. It is
also evaluated for the exact tuple of database, driver, profile, runtime and
capability that the support records describe.

### Application API

During the 1.x release line, these items are compatibility guarantees:

- documented application imports and subpaths;
- call shapes;
- the rules for query and result kinds;
- trailing execution options;
- error codes that SQLBraid owns.

When a signal is already aborted, the `AbortSignal` handling keeps its `reason`.
Unsupported active cancellation and unsupported database capabilities stay
explicit errors. They do not silently change execution.

The ownership rules for sessions, transactions, savepoints and streams are part
of the guarantee. A conflicting handle fails. SQLBraid does not move the work to
a different connection, does not buffer a stream and does not change the
transaction scope.

Prepared input factories use the required-input form by default. They can
declare `{ input: "required" }`. Factories without input declare
`{ input: "none" }` explicitly, and take only options at execution. This
explicit arity declaration prevents guesses from JavaScript `Function.length`
or from the keys of the options. The lock on the logical shape is not a promise
of a server-side prepared cache.

Applications usually get application-facing types, such as `Database`,
`PreparedQuery`, `SqlTag`, query and result types and execution options, from
SQLBraid factories. But exported structural types can also occur in user mocks
and wrappers. During 1.x, do not remove their required members or change them
incompatibly.

An added required method on an exported interface is not automatically a
SemVer-minor change. It can break application mocks, wrappers and other
structural implementers. For additive features, use free helpers, new subpaths,
optional fields or separate extension interfaces. Keep the existing call
positions, especially the trailing options.

### Supported SPI implementers

The interfaces for `QueryExecutor`, providers, leases, binding,
materialization and observers are supported interfaces for implementers. They
are more than types that a factory returns.

Third-party drivers and integrations can implement `QueryExecutor`,
`ConnectionProvider`, `ConnectionLease`, `StatementBindingAdapter`, binding
descriptions and contexts, and observer interfaces. This applies where the
documentation calls the interface an implementation boundary.

Existing required members stay source-compatible during 1.x. A new driver
capability must normally use an optional SPI member or capability, or a
separate extension interface. A new required SPI method for one adapter is not
a compatible minor change. Unsupported capabilities stay explicit and come from
capabilities.

Do not silently change these items:

- the argument order `(statement, binding?, options?)`;
- the immutable shared identity of the statement-binding adapter;
- binding validation before acquisition;
- explicit ownership of cleanup;
- observers that only observe or fail.

Drivers keep their native error identity, unless SQLBraid owns the error. Missing
stream, call, cancellation, transaction or hint capabilities must continue to
use the documented `UnsupportedFeatureError` codes. A fallback that changes
physical ownership or SQL semantics is not compatible.

Transaction-option validators are an exception to option classification only
through capabilities. They must be synchronous and free of side effects. They
must reject before acquisition, with the same public error that `begin()` gives.
The runtime must reject a thenable return value. It must not await it. The
generic checks for transaction and savepoint support stay independent.

### Closed unions

Exported closed and discriminated unions are sensitive to compatibility during
1.x. A new member can break exhaustive TypeScript consumers. This includes
`QueryResultKind`, `ParameterTransportKind`, `RequestedReuse`, `EffectiveReuse`,
`ReuseOwner`, `RoutineParameterDirection`, `RoutineResultSource`,
`BulkExecutionMode`, `QueryErrorStage`, `ExecutionEvent`,
`TransactionEventPhase`, `TransactionIsolation` and the support and status
unions that the environment API exposes.

Do not make these unions wider on speculation. Put a new strategy inside an
existing semantic category only when that is true. If not, use a separate
extension surface. If a union really must become wider, it needs a compatibility
review. It does not automatically become a minor release.

### Safe additive patterns

These additive patterns are usually safe when the observable semantics stay
compatible:

- optional properties in existing options or config records;
- new free functions;
- new package or subpath exports;
- new driver adapters;
- new representation profiles;
- optional SPI members or capabilities;
- separate extension interfaces;
- additional exact support evidence.

No pattern is automatically safe if it changes ownership, errors, execution
order or other documented behavior.

### Product boundary

The 1.x boundary does not promise these features:

- behavior that is complete in the JDBC sense;
- iteration over arbitrary statements with many results;
- universal rewriting for generated keys;
- COPY, CSV or XLSX import in core;
- scrollable or updatable result sets;
- automatic retry or routing;
- hidden SQL rewriting;
- a new query result kind for operations of one transport.

### Serialized and tooling formats

Metadata snapshots use the `sqlbraid-metadata` discriminator and a versioned
`formatVersion`. Relation and type identities are qualified evidence. They are
not display names. Generated models record the metadata hash and the id and hash
of the selected TypePolicy. Thus, a change of the representation policy is a new
codegen input. It is not an invisible rewrite of the output.

RC2 adds `metadata.identityEncoding: "escaped-qualified-v1"` to new first-party
snapshots. `formatVersion` stays `1`.

- `qualifiedIdentity()` escapes the backslash, dot, colon and hash delimiters.
  Ordinary `schema.name` identities stay readable. Qualified names stay
  unambiguous.
- A historical snapshot without the marker keeps its legacy dot identity
  encoding for compatibility.
- An unknown `identityEncoding` marker is rejected.

This is a migration of the identity encoding. It is not a migration of the
format version. When you move to the escaped encoding, inspect the database
again. An old snapshot can already be missing objects whose legacy identities
collided. The snapshot alone cannot recover those objects.

`qualifiedIdentity(namespace, name, ...segments)` and
`qualifiedIdentitySegments(segments)` encode structured namespace and object
segments. Their `WithSuffix` counterparts add an overload suffix that is escaped
separately. The suffix can be empty when a driver reports no return type.
`QUALIFIED_IDENTITY_ENCODING` is the marker value. Oracle package routines keep
the optional `RoutineSnapshot.packageName` as positive catalog evidence. Tooling
matches the owner, package and routine separately. It does not split an escaped
identity.

Codegen input and output options stay deterministic. They keep their documented
diagnostic behavior. The CLI JSON output is machine-readable. Its documented
exit status is part of the tooling interface. Compiler and LSP diagnostics keep
their source positions and severity conventions. Tooling consumers must select
the matching metadata and TypePolicy versions. They must not infer support from
a neighboring database or runtime.

### Advanced and internal-facing surfaces

These surfaces can change faster than the Application and SPI layers:

- compiler lowering details;
- the coverage of metadata inspectors;
- the format of generated source;
- editor integration;
- other surfaces that are explicitly Advanced.

Their serialized boundaries still need versioning and migration notes. During
the 0.x period, SQLBraid did not use the pre-1.0 flexibility of SemVer as
permission for silent breakage. A breaking Application, SPI or serialized change
needs a new minor release, an explicit entry in the release notes and migration
guidance. Patch releases are only for compatible fixes, documentation and
corrections to evidence.
