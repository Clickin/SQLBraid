# SQLBraid public API audit

This inventory records the stable SQLBraid 1.x public boundary. It is an API
classification and compatibility reference, not a publication or support claim.
SQLBraid 1.0.0 is GA; the exact-SHA records below are retained as pre-GA audit
provenance and do not by themselves certify later revisions. The last recorded
pre-GA exact-SHA verification was revision
`8da8167e027320fcc9bb2aac16b0903c64147940` (Runtime
[34856051046](https://github.com/Clickin/SQLBraid/actions/runs/34856051046), Docs
[34856051102](https://github.com/Clickin/SQLBraid/actions/runs/34856051102),
Release [34856063326](https://github.com/Clickin/SQLBraid/actions/runs/34856063326)).
The recovery audited remediation baseline is `9cdc3d8`. It carries the
isolated pnpm Vite facade gate and no-SDK OpenTelemetry API gate. The final
source-audit commit is `cead8f9f522f1790bc2db501503399d62a0918b4`; the
documentation-only digest follow-up is `a148f52d42599e72b393b90ce0f0f2e55441df21`.
The historical CI proof above remains retained; local integrated verification
for the final source audit is recorded externally and is not a publication
claim.

## Classification

- **Application** — intended query authoring, execution, mapping, and configuration API.
- **SPI** — physical driver, provider, binding, dialect, and evidence contracts.
- **Advanced** — compiler, metadata, codegen, tooling, and editor integration.

## `@sqlbraid/core`

**Driver SPI subpath:** `@sqlbraid/core/driver` exports `CleanupAction`,
`CleanupScope`, `createCleanupScope`, `defineResultProperty`, and
`assertSavepointName`. Drivers explicitly register resource cleanup; the scope
runs it once in LIFO order, preserves primary failures, aggregates cleanup
failures under `BRAID_RESOURCE_CLEANUP`, and supports ownership handoff through
`disarm()`. Synchronous cleanup remains synchronous. The property and savepoint
helpers preserve ordinary-object own properties and reject unsafe names.
These are supported driver-author contracts, not application query APIs.

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

`PUBLIC_ERROR_DEFINITIONS` and its `PublicErrorDefinition` /
`PublicErrorCategory` types enumerate the deliberately public error reference.
They do not promote every internal `BRAID_` message to a stable contract.
The bilingual error reference links every registry code. `WELL_KNOWN_CAPABILITIES`
and `WELL_KNOWN_CAPABILITY_IDS` are the core machine-readable capability
vocabulary; `support/capabilities.json` mirrors that vocabulary for target
claims and the [support matrix](/SQLBraid/reference/support/). Capability
status is support evidence, while `canonical` and `rawRepresentations` are
representation evidence attached to a claim, not additional capability IDs.
`isPublicUnsupportedFeatureError` is the conformance predicate for a public
`UnsupportedFeatureError` feature/code pair.
For an unavailable prepared-statement protocol, use
`statement.prepare` with `BRAID_PREPARE_UNSUPPORTED`; `BRAID_BULK_UNSUPPORTED`
is reserved for `statement.bulk` and must not be used as a prepare alias.

`AUTHORING_MODULE_CATALOG` is a frozen data-only discovery catalog consumed by
compiler and tooling; it records supported tag-exporting module identities and
dialect evidence. It is not an execution or error API.

`Database` exposes `execute`, `all`, `one`, `maybeOne`, `call`, `batch`, `bulk`,
`prepare`, `stream`, `session`, and `tx`. All execution operations take trailing
options. Prepared queries are row-kind aware: row queries expose `execute`,
`all`, `one`, `maybeOne`, and `stream`; command/unknown queries expose `execute`;
call queries expose `call`. Input factories use
`prepare(name, (input) => query)` (or explicitly
`{ input: "required" }`). Zero-input factories must declare
`prepare(name, () => query, { input: "none" })` and use options as their only
execution argument.

`Awaitable<T> = T | PromiseLike<T>` is exported for physical SPI
implementations. `QueryExecutor.query`, `call`, optional `bulk`, and
transaction-control methods may return `Awaitable`; `stream` remains
`AsyncIterable`, and `ConnectionProvider.acquire()` remains a `Promise`.
Synchronous drivers therefore avoid a needless Promise wrapper at the
physical boundary, while the public `Database` surface remains async.

**SPI:** `BindingDescription`, `BulkBindingDescription`, `BulkExecutionMode`,
`BulkExecutionResult`, `ConnectionLease`, `ConnectionProvider`, `Dialect`,
`DialectLexicalProfile`, `DriverRoutineResult`, `DriverRoutineResultSet`,
`EnvironmentCapability`, `EnvironmentOptions`, `EnvironmentSupportTarget`,
`QueryExecutor`, `RenderedBulk`, `RenderedParameter`, `RenderedStatement`,
`RoutineMappingLocation`, `RoutineResultSource`, `StatementBindingAdapter`,
`StatementBindingContext`, `StatementBindingDescription`, `TypeMapping`,
`TypePolicy`.

`QueryExecutor` methods use `(statement, binding?, options?)`; `bulk` is optional,
and transaction-control methods are optional capabilities. The optional
`validateTransactionOptions?(options: TransactionOptions): void` SPI hook is
synchronous and pure; when present it is authoritative for exact adapter
option admissibility and must be reused by `begin()`, not duplicated. Provider
and leases must expose the same immutable statement-binding adapter identity;
providers exposing the hook must keep equivalent lease policy, but no function
identity is required. Runtime inherits a provider hook when a lease omits it
and otherwise retains conservative capability checks. `UnsupportedFeatureError`
uses `(feature, code, message, options?)` with a `BRAID_${string}` code.

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

The exhaustive vocabulary is grouped by evidence family below. Runtime
environment declarations use these IDs; do not add aliases such as
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
contracts and runtime constructors without selecting a dialect. Combined
driver+dialect/query subpaths use the matching adapter:
`/pg`, `/mysql2`, `/mariadb`, `/node-sqlite`, `/better-sqlite3`, `/libsql`,
`/sqlite-wasm`, `/d1`,
`/oracledb`, and `/tedious`. The `/bun-sql` subpath is a multi-dialect Bun.SQL
adapter; import `sql` from the selected dialect root and pass that dialect to
`createBunSqlDatabase`. Dialect-only subpaths
`/postgres`, `/mysql`, `/sqlite`, `/oracle`, and `/mssql` support custom
adapters. The facade has no CLI, database-driver, metadata, codegen, tooling,
compiler, editor, or Vite dependency.

**Advanced:** `sqlbraid/compiled` exposes `capture` and
`assertDirectiveCondition` from `@sqlbraid/template` for compiler-generated
lowering. It is a public generated-code entrypoint, not an application query
authoring API, and does not load the compiler. Use matching compiler and runtime
versions.

The marked inventory below classifies every key in `sqlbraid`'s package export
map. `tests/public-api-audit.test.ts` requires export additions or removals to
update this inventory in the same change.

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

Portable dialect roots do not load optional native driver dependencies. A
subpath adapter must preserve the logical value boundary, expose a stable
binding adapter, and report unsupported capabilities explicitly. Bun's adapter
family accepts a user-selected PostgreSQL/MySQL/MariaDB/SQLite dialect; it does
not auto-detect. Deno uses existing driver subpaths where the driver API works.
These runtime statements are compatibility guidance, not Official support labels.

Bun.SQL MySQL/MariaDB reject explicit `readOnly: true` and `readOnly: false`
before I/O with `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`.
Bun 1.3.14 retains failed read-only statement state across rollback on the same
connection. Omitting the option preserves the native session default, not a
forced read-write mode; contaminated reservations are discarded. Bun.SQL
PostgreSQL access modes and all representation-profile options are unchanged.

SQLite-specific boundaries are intentionally not interchangeable:
`better-sqlite3` is synchronous and event-loop blocking even though its public
database wrapper is async; its exact INTEGER profile uses statement-local
`safeIntegers(true)`. The libSQL adapter requires an explicit
`intMode: "string"` assertion, uses an interactive transaction handle for
continuity, does not claim `session.pinned`, and does not fake `statement.stream`
by buffering. Local `file:` and protocol-unknown libSQL clients omit optional
`command.insertId`: their native ROWID metadata cannot establish exactness.
Use explicit `INSERT ... RETURNING` row contracts when that value is needed;
affected-row counts and transaction support remain unchanged.
A local libSQL test does not certify HTTP/WebSocket or
browser/Worker transports; every promoted label needs exact runtime, driver
version, profile, and workflow evidence.

## Runtime and tooling packages

- `@sqlbraid/runtime`: `createDatabase`, `createPooledDatabase`,
  `DatabaseCardinalityError`, `DatabaseResultKindError`,
  `DatabaseResultValidationError`, and `DatabaseScopeError`.
- `@sqlbraid/template`: configured SQL tags, fragments, directives, and `sql.bind`.
- `@sqlbraid/compiler`: source analysis, diagnostics, lowering, source maps,
  `transformSource`, and checker contexts (`TypeScriptProjectContext`,
  `TypeScriptSourceContext`, `createProjectContext`, `createSourceContext`).
- `@sqlbraid/vite`: Vite pre-transform; Vite remains responsible for TS/JSX.
- `@sqlbraid/metadata`: snapshots, validation, hashing, drift, and inspectors' model.
- `@sqlbraid/codegen`: pure `generateModels` and deterministic model source.
- `@sqlbraid/tooling`: Node-first config/workspace/evidence services.
- `@sqlbraid/operations`: fingerprints and declaration manifests.
- `@sqlbraid/cli`: optional CLI process entry point; install it separately for
  codegen, inspect, diagnostics, and drift commands.
- `@sqlbraid/language-server`: embedded service and standard stdio LSP transport.

Runtime packages do not acquire metadata, compiler, codegen, tooling, editor, or
Vite dependencies. Metadata is open-world positive evidence; absent objects do
not become invalid-SQL diagnostics.

## Deliberate nonfeatures

There is no universal input codec, SQL/result rewriting interceptor, automatic
retry/router, hidden transaction, complete SQL grammar, ORM graph hydration,
universal prepared cache, or fabricated stream/call fallback. `db.environment()`
is observational and returns `compatible` when no exact verified target matches.
A neighboring runtime, server version, profile option, or local test cannot
promote an unverified tuple.

## Compatibility policy

This audit classifies the public boundary; it does not turn every exported
symbol into a support promise. Compatibility is evaluated by surface and by
the exact database, driver, profile, runtime, and capability tuple described in
the support records.

### Application API

Throughout the 1.x release line, documented application imports, subpaths, call
shapes, query/result-kind contracts, trailing execution options, and
SQLBraid-owned error codes are compatibility contracts. `AbortSignal` handling
preserves an already-aborted signal's `reason`; unsupported active cancellation
and unsupported database capabilities remain explicit errors rather than
silently changing execution. Session, transaction, savepoint, and stream
ownership rules are part of the contract: a conflicting handle fails instead
of moving work to another connection, buffering a stream, or changing
transaction scope. Prepared input factories default to the required-input form
(and may declare `{ input: "required" }`); zero-input factories explicitly
declare `{ input: "none" }` and remain options-only at execution. This explicit
arity declaration avoids JavaScript `Function.length` and options-key guesses.
The logical shape lock is not a promise of a server-side prepared cache.

Application-facing contracts such as `Database`, `PreparedQuery`, `SqlTag`,
query/result types, and execution options are primarily consumed through
SQLBraid factories, but exported structural types can still appear in user
mocks and wrappers. Throughout 1.x, do not remove or incompatibly change their
required members. Adding a required method to an exported interface is not
automatically a SemVer-minor change: it can break application mocks, wrappers,
and other structural implementers. Prefer free helpers, new subpaths, optional
fields, or separate extension interfaces for additive functionality, and
preserve existing call positions (especially trailing options).

### Supported SPI implementers

`QueryExecutor`, provider, lease, binding/materialization, and observer
interfaces are supported implementer contracts, not merely types returned by a
factory. Third-party drivers and integrations may implement
`QueryExecutor`, `ConnectionProvider`, `ConnectionLease`,
`StatementBindingAdapter`, binding descriptions/contexts, and observer
interfaces where the interface is documented as an implementation boundary.
Existing required members remain source-compatible throughout 1.x. New driver
capabilities should normally use optional SPI members/capabilities or a
separate extension interface; adding a required SPI method for one adapter is
not a compatible minor change. Unsupported capabilities remain explicit and
capability-driven.

The `(statement, binding?, options?)` argument order, immutable shared
statement-binding adapter identity, pre-acquire binding validation, explicit
cleanup ownership, and observe/fail-only observer behavior must not be changed
silently. Drivers retain their native error identity unless SQLBraid owns the
error. Missing stream, call, cancellation, transaction, or hint capabilities
must continue to use documented `UnsupportedFeatureError` codes; a fallback
that changes physical ownership or SQL semantics is not compatible.
Transaction-option validators are an exception to capability-only option
classification: they must be synchronous, side-effect free, and reject before
acquisition with the same public error that `begin()` would produce. Runtime
must reject thenable returns rather than await them; generic transaction and
savepoint support checks remain independent.

### Closed unions

Exported closed/discriminated unions are compatibility-sensitive throughout
1.x: adding a member can break exhaustive TypeScript consumers. This includes
`QueryResultKind`, `ParameterTransportKind`, `RequestedReuse`, `EffectiveReuse`,
`ReuseOwner`, `RoutineParameterDirection`, `RoutineResultSource`,
`BulkExecutionMode`, `QueryErrorStage`, `ExecutionEvent`,
`TransactionEventPhase`, `TransactionIsolation`, and support/status unions
exposed by the environment API. Do not widen these unions speculatively.
Represent a new strategy inside an existing semantic category only when
truthful; otherwise use a separate extension surface. A genuinely required
union widening needs compatibility review rather than automatic minor-release
status.

### Safe additive patterns

Generally safe additive patterns, when observable semantics remain compatible,
are optional properties in existing options/config records, new free functions,
new package/subpath exports, new driver adapters, new representation profiles,
optional SPI members/capabilities, separate extension interfaces, and
additional exact support evidence. None is automatically safe if it changes
ownership, errors, execution order, or another documented behavior.

### Product boundary

The 1.x boundary does not promise JDBC-complete behavior, arbitrary
multi-result statement iteration, universal generated-key rewriting,
COPY/CSV/XLSX import in core, scrollable/updatable result sets, automatic
retry/routing, hidden SQL rewriting, or a new query result kind for
transport-specific operations.

### Serialized and tooling contracts

Metadata snapshots use the `sqlbraid-metadata` discriminator and a versioned
`formatVersion`; relation and type identities are qualified evidence, not
display names. Generated models record the metadata hash and the selected
TypePolicy id/hash, so changing representation policy is a new codegen input,
not an invisible output rewrite.

RC2 adds `metadata.identityEncoding: "escaped-qualified-v1"` to new
first-party snapshots while keeping `formatVersion: 1`. `qualifiedIdentity()`
escapes backslash, dot, colon, and hash delimiters, so ordinary
`schema.name` identities remain readable while qualified names remain
unambiguous. An unmarked historical snapshot retains its legacy dot identity
encoding for compatibility; an unknown `identityEncoding` marker is rejected.
This is an identity-encoding migration, not a format-version migration.
Re-inspect the database when moving to the escaped encoding: an old snapshot
may have already lost objects whose legacy identities collided, and those
objects cannot be recovered from the snapshot alone.

`qualifiedIdentity(namespace, name, ...segments)` and
`qualifiedIdentitySegments(segments)` encode structured namespace/object
segments. Their `WithSuffix` counterparts add a separately escaped overload
suffix, including an empty suffix where a driver reports no return type.
`QUALIFIED_IDENTITY_ENCODING` is the marker value. Oracle package routines
retain optional `RoutineSnapshot.packageName` as positive catalog evidence;
tooling matches owner, package, and routine separately rather than splitting
an escaped identity.

Codegen input/output options remain deterministic and preserve their documented
diagnostic behavior. CLI JSON output is machine-readable and its documented
exit status is part of the tooling contract. Compiler and LSP diagnostics keep
their source positions and severity conventions. Tooling consumers should
select the matching metadata and TypePolicy versions rather than infer support
from a neighboring database or runtime.

### Advanced and internal-facing surfaces

Compiler lowering details, metadata inspector coverage, generated source
formatting, editor integration, and other explicitly Advanced surfaces may
evolve more aggressively than the Application and SPI layers. Their serialized
boundaries still require versioning and migration notes. During the 0.x period,
SQLBraid does not use SemVer's pre-1.0 flexibility as permission for silent
breakage: breaking Application, SPI, or serialized changes require a new minor
release, an explicit release-note entry, and migration guidance. Patch releases
are reserved for compatible fixes, documentation, and evidence corrections.
