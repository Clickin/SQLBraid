# SQLBraid v1 Product Plan

> Status: authoritative product and engineering plan  
> Project: **SQLBraid**  
> npm scope: **`@sqlbraid/*`**  
> CLI: **`sqlbraid`**  
> Dynamic SQL directive namespace: **`/*@braid ...*/`**

---

## 0. Product definition

SQLBraid is a **SQL-first data-access toolkit for TypeScript**.

It exists for developers who want to keep writing SQL as SQL while gaining the ergonomics normally missing from driver-level access:

- safe parameter binding;
- readable inline dynamic SQL;
- explicit result contracts;
- one-row result validation/transformation through Standard Schema;
- plain JavaScript/TypeScript results;
- result-kind-safe execution;
- transactions and connection-bound execution;
- execution observation for SQL/bind logging, audit and metrics;
- first-party PostgreSQL, MySQL, SQLite, Oracle and SQL Server dialects/adapters;
- optional metadata/code-generation tooling.

The primary authoring surface remains ordinary SQL:

```ts
const query = sql.rows<UserRow>`
  SELECT u.id, u.name
  FROM users u
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND u.name = ${name}
    /*@braid end*/
  /*@braid end*/
`;
```

SQLBraid should provide strong boundaries around SQL **without becoming a universal SQL compiler, ORM, validation framework or connection-pool implementation**.

---

## 1. Product thesis

### 1.1 SQL stays SQL

SQLBraid does not replace SQL with a fluent query-builder language.

### 1.2 Dynamic SQL belongs in the statement

The v1 directive set is deliberately small:

- `if`
- `choose`
- `when`
- `otherwise`
- `where`
- `set`
- `trim`

Conditions are TypeScript expressions. Do not introduce OGNL or another expression language.

### 1.3 The database owns SQL semantics

The broad SQL AST/resolver was removed in PV3. Keep it removed.

SQLBraid must not maintain complete database grammars, function/operator catalogs, cast systems, extension registries or arbitrary SQL result inference.

### 1.4 Explicit result contracts are the default

```ts
const query = sql.rows<UserRow>`SELECT id, name FROM users`;
```

`UserRow` is developer-owned. SQLBraid does not claim that arbitrary SQL was statically proved to produce it.

### 1.5 Standard Schema is the result-mapping SPI

Database and application representations often differ:

```text
VARCHAR(14) yyyyMMddHHmmss -> temporal/domain value
TEXT JSON                  -> typed object
json/jsonb                  -> validated domain object
legacy code                 -> application value object
```

SQLBraid uses the ecosystem Standard Schema protocol rather than inventing a result-map DSL.

### 1.6 Execution is observable, not freely mutable

Production systems may need:

- SQL logging;
- bind-value logging or redaction;
- audit trails;
- duration/slow-query metrics;
- success/error reporting;
- transaction lifecycle auditing.

SQLBraid therefore provides a runtime execution observer/interceptor seam. Pre-release interceptors are **observe/fail only**: they may inspect events and throw to reject/fail an operation, but they do not rewrite SQL, binds or results.

### 1.7 Dialect, driver and runtime are separate axes

Do not create a new dialect because a driver or JavaScript runtime is different.

```text
dialect     SQL surface / lexical profile / quoting / primitive DB semantics
driver      protocol/API bridge, placeholder materialization and result normalization
runtime     Node / Bun / Deno execution environment
```

A PostgreSQL `pg` adapter remains one adapter if the same public driver API works on Node, Bun and Deno. Runtime compatibility must be proved by CI before being advertised as official.

### 1.8 Logical statements and driver binding

Template rendering produces one immutable logical statement. It contains structural
SQL segments and ordered value parameters; it does not contain driver placeholders:

```ts
interface RenderedParameter {
  readonly value: unknown;
  readonly interpolation?: number;
  readonly hint?: ParameterTypeHint;
}

interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly resultKind: QueryResultKind;
  readonly dialectId: string;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}
```

`segments.length === parameters.length + 1` is mandatory. Structural helpers
(`sql.ident`, `sql.raw`, fragments, lists, joins and directives) are resolved into
segments; a `RenderedParameter` is always a value. Adapters must not interpret a
parameter as SQL, an identifier, a nested query, a driver fragment or a tagged
template command. `createRenderedStatement` validates and snapshots this boundary.

Driver packages own binding/materialization through `StatementBindingAdapter`. Its
pure `describe(statement, context)` operation selects the transport and validates
hints before connection acquisition. The resulting `StatementBindingDescription`
records adapter/dialect identity, binding metadata and requested/effective reuse:
`native-value-template`, `text-positional`, `text-named` or `typed-request`.
`parameterizedSql(statement, placeholder)` and `createStatementBindingDescription`
are diagnostic/core helpers; placeholder generation never belongs to a dialect or
template renderer. `QueryExecutor` and `ConnectionProvider` expose the same
immutable `statementBinding` object, and a provider's leases must share that exact
adapter identity.

Prepared shape identity uses `resultKind`, canonical segments and ordered hint
signatures, never `$1`, `?`, `:1` or `@p1` syntax. A prepared execution renders
once, validates the logical shape, describes the binding, then executes that exact
statement. Driver/server reuse remains adapter-owned; runtime does not add a
universal prepared cache.

---

## 2. Non-goals for pre-release/v1

The following are not pre-release/v1 goals:

- ORM entity lifecycle or relation hydration;
- query-builder-first authoring;
- complete SQL grammars or semantic inference;
- multi-row object-graph assembly;
- a SQLBraid-specific validation language;
- hard dependency on Valibot, Zod, ArkType or another Standard Schema implementation;
- application-level input mapping/codec framework;
- SQL/bind/result rewriting through interceptors;
- automatic retry/routing policy;
- built-in audit-log storage;
- mandatory DB prepare/describe verification;
- application-level input mapping/codecs before the public pre-release.

Application input mapping remains explicitly deferred. JavaScript database drivers do not expose a JDBC-like universal application-input type system, so result mapping does not imply a symmetric input framework. PV13 parameter hints are not input codecs or Standard Schema validation: they select database parameter metadata and must be honored or rejected explicitly.

PV13 is an explicit user-authorized override of the earlier Oracle deferral. It adds Oracle and SQL Server portable roots plus driver subpaths without claiming Official support before real database evidence. Oracle-specific bind, OUT/IN OUT, cursor, LOB, NUMBER, DATE/TIMESTAMP, object-type, result-set and session semantics remain capability boundaries; unsupported pieces are documented as Unsupported rather than fabricated.

---

## 3. Core authoring contract

### 3.1 Values are bound

```ts
sql`WHERE id = ${id}`;
```

Ordinary interpolation is always a bind value.

### 3.2 Structure is explicit

```ts
sql.ident(name)
sql.fragment`...`
sql.raw(text)
sql.empty
sql.join(parts, separator)
sql.list(values)
```

`sql.raw()` is an explicit trusted/unsafe escape hatch.

### 3.3 Database parameter typing is explicit

Ordinary `${value}` interpolation remains a driver-bound value and uses documented driver inference. `${sql.bind(value, hint)}` supplies explicit database parameter metadata:

```ts
sql`WHERE amount = ${sql.bind(amount, oracleParameter.number())}`;
sql`WHERE display_name = ${sql.bind(name, mssqlParameter.nvarchar(200))}`;
```

SQLBraid does not infer a universal database parameter type from a TypeScript type. A `number`, `string`, `Date`, `null`, or custom object is not semantic evidence for one database type. Parameter hints are not application input validation, result mapping, or codecs. Adapters honor a hint or fail explicitly; PostgreSQL, MySQL, and SQLite reject hints with `BRAID_BIND_HINT_UNSUPPORTED` rather than silently ignoring them.

### 3.4 Result kinds are explicit

```ts
sql.rows<Row>`...`
sql.command`...`
sql.call<RoutineCallResult<Output, Sets, ReturnValue>>`...`
sql`...` // unknown
```

Adapters report the actual row/command result kind. Runtime checks it against the declaration. `BRAID_RESULT_KIND` is post-execution and does not undo side effects.

Routine contracts describe the whole result, with separate scalar `output`,
ordered heterogeneous `resultSets` tuples and a real optional `returnValue`
channel. `sql.call({ output, resultSets, returnValue })` accepts Standard Schema
per channel. Materialized driver resources close and root leases release before
asynchronous application mapping. OUT cursor sets precede implicit/emitted sets;
scalar outputs remain separate. `sql.out()` and `sql.inOut()` are logical
parameters, never structural SQL. Unsupported driver channels fail explicitly.
`sql.out()` also supports Oracle materialized `sql.rows` DML `RETURNING ... INTO`;
`sql.inOut()` remains call-only. PostgreSQL/SQLite `RETURNING` and SQL Server
`OUTPUT` use native row results, without SQL rewriting or affected-count inference.

---

## 4. Dynamic SQL/compiler boundary

Guarded interpolations require compiler lowering because JavaScript evaluates template expressions before the tag call.

Generated code must preserve:

- lexical `this`;
- evaluation order;
- once-only active expression evaluation;
- lazy inactive branches;
- TypeScript control-flow narrowing;
- source maps/directive prologues;
- query-bound mapper identity and output typing.

The compiler owns TypeScript/Braid integration, not database SQL semantics.

---

## 5. Result contracts and mapping

### 5.1 Declared row contract

```ts
const query = sql.rows<UserRow>`SELECT ...`;
```

No validation/transformation occurs unless a schema is attached.

### 5.2 Official Standard Schema dependency

`@sqlbraid/core` depends on:

```text
@standard-schema/spec
```

for protocol types. No concrete validator library is a production dependency.

### 5.3 Query-bound mapping

```ts
const query = sql.rows(UserSchema)`
  SELECT id, created_at AS "createdAt", payload
  FROM events
`;
```

The Standard Schema output type becomes the row type.

Pipeline:

```text
driver result
  -> dialect TypePolicy normalization
  -> plain normalized row
  -> query-bound Standard Schema
  -> optional execution-level schema
  -> application row
```

Mapping is one input row to one output value. It may validate, reshape, parse JSON/text or construct temporal/domain values. It does not merge multiple rows into ORM graphs.

### 5.4 Mapper execution must not unnecessarily own a connection

For materialized query results, physical DB I/O and application mapping are separate phases.

A root operation should release its leased physical connection after the driver result has been fully materialized and before potentially asynchronous Standard Schema mapping/validation runs.

This prevents application mappers from holding scarce pool connections and permits safe re-entry into the root database when a separate connection can be acquired.

Streaming is the exception: the stream owns its physical lease until iteration closes because the driver cursor/result stream is still active.

### 5.5 Application input mapping remains deferred

Ordinary `${value}` continues through the dialect/driver bind boundary. Do not add `sql.bind(value, codec)` or a general input-mapper framework before pre-release.

### 5.6 PV17/PV18 value-fidelity boundary

PV17 makes raw value semantics explicit before application mapping:

```text
exact database integer/decimal → string
IEEE-754 approximate binary    → number
```

`TypeMapping.numeric` separates the database `semantics`, SQLBraid
`representation`, and transport `fidelity` (`lossless`, `guarded`, `lossy`, or
`unsupported`), with optional `binaryPrecision: 32 | 64`. Exact output must not
vary with the current value and must never use `bigint` or JavaScript `number`
as a convenience fallback. `decodeExactInteger` is an opt-in application
helper; arbitrary-precision Decimal, Money, and domain values remain
application-owned Standard Schema transforms. There is no global `numericMode`.

The same rule applies to JSON and temporal values. Lossless JSON text is
distinct from a parsed object whose nested numbers may already be JavaScript
`number`; temporal text is distinct from native `Date`, which can lose
fractional precision, offsets, zones, or local/date-only meaning. Driver options
and query-authored casts/format expressions are separate profiles. SQLBraid
never rewrites SQL to manufacture fidelity.

`null` means SQL `NULL`. Ordinary `undefined` IN parameters are programming
errors and fail with `BRAID_BIND_VALUE_UNSUPPORTED` before acquisition across
execute, prepared, bulk, stream, and routine paths. Database-generated IDs and
affected-row metadata are audited separately from runtime cardinality counters;
database values remain exact text or fail closed, while operational counts use
safe-range checks.

Scalar guarantees do not automatically apply to arrays, domains, ranges,
multiranges, composites, Oracle objects/collections, SQL Server `sql_variant`,
vectors, or other containers. Such values are `unclassified` or `unsupported`
until a recursive transport test proves otherwise. Native SQL remains
transparent: `MERGE` and UPSERT/REPLACE/ON CONFLICT are distinct support
capabilities (`merge-returning` versus `upsert-returning`).

PV18 makes representation profiles first-class evidence. PostgreSQL, mysql2,
and MariaDB expose immutable profile descriptors and
`typePolicyForProfile({ json, temporal })`; runtime and codegen must reuse the
same descriptor. Driver raw values and SQLBraid canonical values are separate
facts. Exact string IDs and generated IDs are canonical decimal text, while
`affectedRows`, `rowCount`, procedure status, and bulk input counts are
safe-range operational numbers. Native JSON roots use `unknown` unless narrowed
by explicit driver evidence, and temporal mappings are per database type rather
than one broad Date mapping. A supported container path is not a recursive
guarantee for every nested member.

---

## 6. Execution and connection ownership

### 6.1 Physical executor

`QueryExecutor` represents one physical execution resource/session when used directly.

Direct connection examples include a `pg.Client`, `mysql2.Connection`, or `node:sqlite` database wrapper.

### 6.2 Connection provider / pool

PV6 provides an explicit pool/provider boundary:

```ts
interface ConnectionProvider {
  acquire(): Promise<ConnectionLease>;
}

interface ConnectionLease extends QueryExecutor {
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}
```

`createPooledDatabase(provider, options?)`, `createPgPoolDatabase(pool, options?)` and `createMysql2PoolDatabase(pool, options?)` use this contract:

- ordinary root query/call: acquire one lease, perform physical DB I/O, release it;
- materialized result mapping: run after release;
- batch: one logical batch uses one lease unless a driver capability explicitly defines otherwise;
- stream: keep one lease until iterator completion/error/cancel;
- no global serialization across independent pool leases.

### 6.3 Transaction boundary

The canonical transaction API is the `db.tx(...)` closure boundary. The former `transaction(...)` name is removed.

```ts
await db.tx(async (tx) => {
  await tx.execute(insertAudit);
  await tx.execute(updateAccount);
});
```

Semantics:

1. acquire exactly one physical connection/lease;
2. begin on that lease;
3. every `tx.*` operation reuses the same physical connection;
4. commit or rollback;
5. release the lease.

Nested `tx` uses savepoints on the same physical connection when supported.

Using the outer/root `db` from within its own transaction async context must not silently escape the transaction onto another pool connection. Fail deterministically instead.

Outside an explicit transaction boundary, each root operation may use any connection obtained from the provider.

### 6.4 Pool adapters are providers, not fake executors

Never model `pg.Pool`, `mysql2.Pool`, Bun.SQL or another pool as a `QueryExecutor` whose `begin/query/commit` may run on unrelated connections.

Pool support must go through the lease/provider abstraction.

### 6.5 Binding identity and materialization

Binding description is computed before `acquire()`. A provider advertises an
immutable `statementBinding` adapter and every lease uses that same adapter
object; a provider/lease identity mismatch is an integration error, not a
silent fallback. `describe()` performs no database I/O and keeps driver-specific
request types inside the driver package.

The execution pipeline is:

```text
render once
  -> logical shape/prepared validation
  -> pure binding description/materialize
  -> observer ready event
  -> acquire lease
  -> driver execution
  -> release materialized lease
  -> application mapping
```

Deterministic placeholder, hint, typed-request or transport-selection failures
are `QueryErrorStage: "materialize"` with both execution flags false. Driver,
server and network failures remain `"driver"`. PV14 adds no retry policy.

---

## 7. Execution observer/interceptor SPI

PV6 provides a deterministic observer SPI around the central runtime execution pipeline.

The public observer contract uses a single discriminated event callback:

```ts
interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}
```

Events cover physical execution, application mapping and connection-scoped lifecycles without exposing mutable driver internals.

Required event coverage:

- query rendered/ready for execution;
- before physical execution;
- after physical driver result;
- after result mapping;
- query failure with pipeline stage;
- call lifecycle;
- stream start/end/error and yielded-row count;
- transaction begin/commit/rollback;
- savepoint / rollback-to / release-savepoint;
- prepared query name when applicable;
- batch lifecycle.

Events should expose useful immutable metadata such as:

```text
parameterized SQL diagnostic view (derived by the effective adapter)
literalizedSql(options?) diagnostic view, reconstructed from segments
readonly bind-value array
binding map when available
effective adapter/dialect/transport/reuse plan
declared result kind
actual result kind when known
row count / command metadata where safe
durationMs (milliseconds)
transaction depth
prepared name
variant fingerprint
error + error stage
```

### 7.1 Bind values and privacy

Observers may receive original bind values because audit/debugging sometimes requires them. SQLBraid must not log them by default.

Documentation examples should redact by default. Applications decide whether sensitive values may be persisted.

### 7.2 No mutation in pre-release

Observer event objects are readonly API contracts. Interceptors may observe and may throw, but pre-release does not support:

- SQL rewrite;
- bind replacement;
- result replacement;
- skip-and-return-arbitrary-result;
- retry/routing mutation.

If mutable query transformation is ever needed, design a separate explicit `QueryTransformer` phase with fingerprint/audit/prepared-statement semantics.

### 7.3 Observer failure semantics

Observers execute in registration order.

- failure before DB execution prevents DB execution;
- failure after DB execution propagates, but cannot undo a root side effect;
- inside `db.tx`, propagated observer failure participates in transaction rollback;
- an observer error while reporting an existing error must not silently erase the original failure; preserve both causes.

No built-in logger/audit backend is required. pino, winston, console, OTEL or application-specific audit storage may implement the observer SPI.

`literalizedSql(options?)` is lazy and cached, and is diagnostic-only: it may
not equal the protocol text and must never be sent for execution. It reconstructs
`segment[0] + literal(parameter[0]) + ...` directly from the logical statement,
never by replacing placeholders in materialized SQL. Redaction is the default;
callers may choose inline/redacted values, a maximum value length, binary summary
or full form, and a parameter redactor. The result reports completeness and
redacted/truncated counts. Unsupported objects use a safe descriptive marker
instead of accidental `toString()` execution.

---

## 8. Dialect / driver / runtime architecture

### 8.1 Dialects

First-party pre-release dialects:

- PostgreSQL;
- MySQL;
- MariaDB, independently tested with its official connector;
- SQLite;
- Oracle;
- SQL Server.

A new driver does not imply a new dialect.

### 8.2 First-party adapters

Current primary adapters:

```text
PostgreSQL -> pg
MySQL      -> mysql2
MariaDB    -> mariadb
SQLite     -> node:sqlite
SQLite     -> @sqlite.org/sqlite-wasm OO1 / Cloudflare D1
Oracle     -> node-oracledb Thin
SQL Server -> Tedious
```

Future adapters may be added only when they provide real value. `QueryExecutor`/provider SPIs remain the escape hatch for other drivers.

First-party transports are adapter-owned: pg materializes
`text-positional` `$1..$N` with fresh unnamed simple execution; mysql2
materializes `text-positional` `?` and uses driver-owned reuse for every
request; node:sqlite prepares documented `?` text with fresh simple execution;
node-oracledb Thin uses text-positional `:1..:N` plus bind descriptors and its
driver cache; Tedious uses `typed-request` `@p1..@pN` with `TYPES.*` and facets,
creating a fresh request with simple execution. These are physical transport
details, not logical shape identity. The same adapter object may receive
multiple dialect contexts. Requested reuse is policy input; never infer the
effective result from the request alone.
MariaDB uses its connector's text execution and native batch API. SQLite WASM
uses OO1 prepared statements; D1 uses materialized results and remote batch.
Neither adapter introduces a native driver dependency into a dialect root.

### 8.3 Runtime support policy

Use four support labels:

- **Official**: exercised in SQLBraid CI on that runtime + driver combination;
- **Compatible**: expected from public APIs but not an SQLBraid CI gate;
- **Custom**: user integrates through executor/provider SPI.
- **Unsupported**: a required capability is absent or SQLBraid's checks fail.

PV7 provides packed-consumer smoke and source/distribution audit gates. Local
Node 22.18.0/24.21.0, Bun 1.3.14 and Deno 2.9.3 pass core/template/runtime, PostgreSQL/pg
8.23.0 and MySQL/mysql2 3.24.4 checks against PostgreSQL 16.4 and MySQL 8.4.2.
Node/Deno pass node:sqlite; Bun 1.3.14 lacks that module and is Unsupported.
The pinned GitHub workflow passes all three jobs on PV7 revision `f6e8952`; the
README links the observed run. Node 22.18.0, Bun 1.3.14 and Deno 2.9.3 are
Official for the passing combinations above. Node 24.21.0 remains Compatible
with local evidence only. Node keeps `>=22.18.0`; Bun/Deno promises cover exact
tested versions only.

Template UTF-8 byte counting is allocation-free and browser-safe. Runtime
transaction context uses an internal conditional-import boundary: Node and
workerd select `node:async_hooks`, while browsers use conservative direct-resource
ownership. Browser concurrency is not advertised as AsyncLocalStorage-equivalent.
SQLBraid-owned public runtime declarations compile without Node ambient types.
Tooling (`compiler`, CLI, metadata/codegen, LSP) remains Node-first.

### 8.4 Reserved transaction-profile architecture

This is a design constraint for a later runtime phase, **not a PV11 runtime API**.
Keep four concerns independent:

- **Dialect:** SQL syntax, lexical behavior and identifiers.
- **Driver adapter:** wire protocol/client API and result materialization.
- **Transaction profile:** DBMS transaction characteristics and capabilities.
- **Execution runtime:** physical lease ownership, pinning, savepoints and scope.

Node/Bun/Deno host support is separately tested deployment evidence. A
MySQL-protocol driver with Oracle-compatible SQL may legitimately use MariaDB
transaction semantics. PostgreSQL wire compatibility likewise does not prove
PostgreSQL transaction semantics (for example, CockroachDB).

The future conceptual isolation union is `read-uncommitted | read-committed |
repeatable-read | snapshot | serializable`. Access mode is separate:
`read-write | read-only`. PostgreSQL DEFERRABLE, SQLite
DEFERRED/IMMEDIATE/EXCLUSIVE and MySQL WITH CONSISTENT SNAPSHOT belong to
profile-specific options, not the isolation union.

A future `TransactionProfile<Isolation, Extra>` should expose `id`,
`supportedIsolationLevels`, `documentedDefaultIsolation`, `supportedAccessModes`
and optional per-level `availability: "always" | "server-config"`. Its narrowed
isolation type and profile-specific extra options should guide factory inference.
Omitting isolation in `db.tx(...)` preserves the real database/session default;
the documented default is intelligence, never a command to reset the session.

The design must represent at least:

| Future profile | Explicit portable isolation concepts | Separate caveat |
| --- | --- | --- |
| PostgreSQL | read-committed, repeatable-read, serializable | READ UNCOMMITTED aliases RC; DEFERRABLE is separate |
| MySQL/InnoDB | read-uncommitted, read-committed, repeatable-read, serializable | Consistent snapshot is separate |
| SQLite | serializable | Begin mode is separate; read_uncommitted/shared-cache is not a normal portable tx option |
| Oracle | read-committed, serializable | Read-only is an access mode |
| SQL Server | read-uncommitted, read-committed, repeatable-read, snapshot, serializable | SNAPSHOT may require database/server configuration |

Normal factories will choose their ordinary profile (PostgreSQL, MySQL,
SQLite respectively), while advanced configurations may override the profile
independently of dialect and driver. Oracle/MSSQL factories follow the same
rule. Exact behavior requires official DB documentation and real integration
tests before an Official label. PV11 exports no transaction-profile/isolation API.

The future Astro Starlight + MDX website should render a
`<TransactionIsolationMatrix />` from those profile definitions: documented
default, omitted-option behavior, supported explicit levels, server-config
requirements and DB-specific characteristics. This conceptual table reserves
the design; it is not a second runtime capability source. No website is built
in PV11.

---

## 9. Metadata and code generation

Database metadata is optional development tooling and not a requirement for normal execution.

PV8 establishes `@sqlbraid/metadata`: `MetadataSnapshot` / `MetadataInspector`,
with `format: "sqlbraid-metadata"` and `formatVersion: 1`. It records database
facts, not application TypeScript type guesses or compiler/TypePolicy identity.
Discriminator-less snapshots are rejected. There is no migration API until a
real second public format exists. Hash/drift identity excludes capture timestamps.

Inspectors live at `@sqlbraid/{postgres,mysql,sqlite}/inspector`, with type-only
metadata imports and an optional metadata peer. Dialect runtime roots neither
export inspectors nor require metadata installation. CLI drift and LSP
`options.metadata` consume the neutral metadata model separately.

Column identity means a proven identity/autoincrement mechanism, not a primary
key. Generated/write flags are evidence, with absence meaning unknown.
Standard Schema owns application row validation/transformation; TypePolicy owns
runtime primitive representation. Neither belongs inside metadata inspection.

PV9 adds optional:

```text
@sqlbraid/codegen
```

PV9 provides pure, offline `generateModels(metadata, { typePolicy })`, returning
deterministic standalone TypeScript source, model identities, diagnostics and
metadata/TypePolicy provenance. PV10 extends this core with exact filters,
explicit model-name and database-type/column overrides, independently resolved
input/output representations and generation-options provenance. The generator
still performs no filesystem writes, live inspection or config lookup.

Row uses TypePolicy output representation. Insert uses input representation plus
DB null/default/identity/generated/write evidence; Update uses input representation
plus DB generated/update evidence. Column nullability is authoritative. Only
tables receive write models; identity alone makes Insert optional without
excluding Update. Unknown evidence becomes `unknown` plus a diagnostic, including
SQLite non-STRICT declared types without explicit overrides. Explicit column and
exact DB-type overrides still apply independently to each input/output side;
only automatic affinity-based TypePolicy mapping is disabled. PostgreSQL qualified types resolve through
metadata type-name evidence; MySQL policy matching is case-insensitive.
It does not promise arbitrary SELECT/JOIN result inference.

---

## 10. Database verification

Prepare/describe verification is not a pre-release core requirement. If later justified, it remains optional development tooling based on real database evidence.

---

## 11. CLI and LSP

Pre-release CLI priorities include TypeScript/Braid checking, guarded-template
build and `sqlbraid codegen`. Codegen loads executable Node `.mjs`/`.js`/`.cjs`
configuration, resolves paths relative to that config, validates all selected
targets before writing, preserves unchanged outputs, and supports repeated
`--target`, `--check` and `--json`. TypeScript config files, watch mode, live
database inspection and column renaming are not supported.

The LSP focuses on SQLBraid diagnostics, mapper/declaration hover and metadata-backed completion, not its own SQL semantic engine.

PV11 makes standard LSP the primary agent interface. `@sqlbraid/tooling` owns
the shared Node-first config/workspace and semantic evidence service; CLI and
language-server depend on it. Its dependencies are core/compiler/metadata/codegen,
never runtime, drivers, CLI, LSP or VS Code. The existing `@sqlbraid/cli/config`
import deliberately reexports the shared config contract. Pure codegen consumes
only TypePolicy `id`/`hash`/`mappings`; it never needs runtime encode/decode methods.

Metadata is open-world positive evidence. Missing relations/columns/routines/types
never alone cause invalid-SQL diagnostics. Built-ins, extension functions, runtime
UDFs, temp/session objects and CTEs remain opaque legal SQL. Routine
`argumentsComplete?: boolean` is additive metadata v1 evidence:
PostgreSQL/MySQL inspectors set false; SQLite emits no routines. Only true
permits exact signatures, never incomplete empty arrays.

Compiler `checkSourceDetailed` separates Braid, native TS, mapped overlay TS and
overlay-only diagnostics using mapped source evidence. LSP/CLI inspection expose
Braid plus overlay-only diagnostics; ordinary TS stays with TypeScript.
The existing full `sqlbraid check` behavior remains available.

The generic stdio transport uses `vscode-languageserver`, consumes initialize
root/workspace folders and project tsconfig, and advertises standard diagnostics,
hover, completion, definition, references, document/workspace symbols and
completeness-gated signature help. It recognizes all four first-party SQL imports.
Completion owns only static SQL, never ordinary TS or interpolation expressions.
Lexical ambiguity yields less intelligence, not invented SQL semantics.

Definitions prefer real current generated TS declarations/properties indexed by
the TS parser, then reliable metadata JSON ranges. Stale or absent generated
files never receive made-up offsets. References require positive lexical identity
and omit CTE/alias ambiguity. Results are filtered/bounded and provenance-aware.
Per-workspace source/config/metadata/generated caches are bounded and invalidated;
pending async work is coalesced/cancellable, stale document/workspace results are
discarded, and synchronous TypeScript work is not claimed to be preemptible.

`sqlbraid inspect query|symbol|diagnostics --json` is the focused fallback for
non-LSP agents, backed by that same service. A portable skill ships at
`skills/sqlbraid/SKILL.md`. MCP remains optional and is not implemented.
The thin VS Code client keeps native TypeScript language support, activates
the server on SQLBraid project evidence, bundles matching server/CLI versions,
and exposes generate/check/reload commands without duplicating semantics.
Actual stdio, external packed tooling and real editor-host gates are mandatory.

---

## 12. Testing strategy

Retain:

- Vitest fast tests;
- PostgreSQL/MySQL Testcontainers;
- native SQLite tests;
- Standard Schema interop with Valibot, Zod and a handwritten implementation;
- packed external consumer validation;
- `publint` and Are The Types Wrong;
- source-map/compiler regression tests.

PV6 regression gates cover connection lease lifetime, transaction pinning, observer event ordering/failure behavior, bind visibility and mapper re-entry.

PV7 adds Bun and Deno runtime smoke/CI gates before any support claim becomes official.

---

## 13. Security and correctness rules

Non-negotiable:

- interpolation stays bound;
- structural SQL remains explicit;
- dynamic directives never reach the DB;
- SQLBraid does not stringify binds into SQL;
- observers never log values by default;
- result mappers do not own physical connections after materialized DB I/O completes;
- transactions pin one physical connection;
- outer root DB calls do not silently escape their own transaction context;
- failed transaction-control cleanup poisons uncertain direct/leased resources;
- unsupported analysis becomes unknown rather than fabricated proof.

---

## 14. Roadmap

### PV1 — Explicit query/result-kind contracts ✅
### PV2 — Compiler SQL semantic inference removal ✅
### PV3 — Broad SQL AST/resolver removal ✅
### PV4 — Runtime result-kind enforcement + execution-time Standard Schema validation ✅
### PV5 — Query-bound Standard Schema result mapping ✅

### PV6 — Execution boundary, connection leasing and interceptor/observer SPI — implemented

- fix PV5 materialized-mapper lock/lease lifetime;
- centralize physical execution vs post-processing;
- add `ConnectionProvider` / leased physical executor semantics;
- canonical closure transaction boundary with one pinned connection;
- deterministic root-db escape protection inside a transaction;
- nested savepoints on the same lease;
- query/call/batch/stream/prepared execution events;
- transaction lifecycle events;
- SQL/bind/duration/result/audit visibility;
- observe/fail-only interceptor semantics;
- no SQL/bind/result mutation.

### PV7 — Runtime portability — complete; same-revision CI verified

- reject pools in official direct PostgreSQL/MySQL factories, including runtime guards;
- observer `cardinality` stage and `durationMs` public timing fields, without aliases;
- packed Node/Bun/Deno smoke, concurrent ALS isolation, source/distribution audit;
- real pg/mysql2 direct/pool matrix and node:sqlite capability/full adapter smoke;
- pinned GitHub Actions release/runtime jobs, all green on final PV7 revision `f6e8952`;
- explicit root workspace test dependencies preserve native ESM and TypeScript resolution in clean checkouts;
- bounded compiler/CLI integration timeouts leave runtime and deadlock deadlines unchanged;
- README uses Official/Compatible/Custom/Unsupported labels with exact tested versions;
- no new runtime-specific drivers, including when an existing adapter is Unsupported.

### PV8 — Metadata boundary stabilization — implemented

- replaced the unreleased `@sqlbraid/schema` package with `@sqlbraid/metadata`, without aliases;
- metadata v1 discriminator, DB-fact-only types and deterministic hash/drift;
- no speculative migration or TypeScript-model/TypePolicy fields;
- PostgreSQL identity/generated evidence, MySQL auto_increment rather than PK, conservative SQLite rowid identity;
- explicit inspector subpaths and optional metadata peers keep runtime installs metadata-free;
- CLI drift, metadata-backed LSP completion and packed runtime/tooling consumer gates;
- codegen remains PV9.

### PV9 — Optional `@sqlbraid/codegen` — implemented

- validated metadata + selected TypePolicy -> `Row` / `Insert` / `Update` models;
- pure programmatic API with deterministic source, safe names and provenance;
- output/input representation separation and explicit DB write/nullability facts;
- unknown fallback and stable diagnostics, conservative SQLite dynamic typing;
- external strict TypeScript compilation, real inspector integrations and packed
  12-package/runtime-only dependency boundaries.

### PV10 — Codegen CLI and overrides — implemented

- exact namespace/relation/kind filters;
- explicit model-name and suffix overrides with collision diagnostics;
- exact database-type/column type overrides with column > database type > TypePolicy precedence;
- independent input/output representation resolution and options provenance;
- typed executable config at `@sqlbraid/cli/config`;
- multi-target codegen, stable no-op/atomic writes, `--check` and structured JSON output;
- full preflight before selected output writes; JSON reports `written` only after successful I/O;
- final declaration names are globally collision-checked after suffix application;
- resolved output collision keys are case-folded on Windows.

### PV11 — Agent-native LSP and editor tooling — implemented

- starts after PV10 closure `2eb663f0702177622358b87c734e9ce9d6e6de6b`,
  with all predecessor [Node/Bun/Deno CI jobs green](https://github.com/Clickin/SQLBraid/actions/runs/34741363531);
- shared tooling/config/evidence core with structured diagnostic ownership;
- open-world metadata and honest routine argument completeness;
- contextual SQL completion, bounded hover, real definitions, conservative
  references and query/workspace symbols;
- standard stdio transport, workspace initialization, invalidation and cancellation;
- CLI JSON fallback, portable agent skill and thin version-matched VS Code client;
- 13 scoped npm packages plus a separately packaged editor extension; runtime-only
  installs remain free of development tooling;
- transaction-profile design is reserved in §8.4; no runtime isolation API,
  MCP requirement, docs website or PV12 release/marketing work.

### PV12 — Public pre-release/Product Hunt hardening — release candidate

- closes PV11 from `1615311149cce6290976df3ed6e63e41dfe795d7`: deterministic
  identifier folding, ancestor CLI config discovery, exhaustive lazy project
  references with bounded caches/cancellation, narrow evidence watchers, and
  native workspace-relative VS Code selectors;
- schema-qualified completion immediately after `FROM public.` returns table
  evidence rather than routine candidates; the editor host verifies actual SQL
  metadata completions separately from native TypeScript word suggestions;
- canonical MIT license and compact README/public metadata for the 13-package
  pre-PV13 baseline; explicit [public API/SPI audit](docs/public-api-audit.md);
- Astro 7.3.2 / Starlight 0.42.0 / MDX documentation in `website/`, with
  internal-link/anchor validation and GitHub Pages deployment;
- packed SQLite/PostgreSQL/MySQL/codegen examples, including the literal SQLite
  documentation snippet, direct/pool execution and deterministic codegen checks;
- tarball manifest/source/hash/dependency validation and actual installed-VSIX
  clean-profile tests, native TypeScript coexistence and unrelated-workspace checks;
- dependency-derived immutable pack-only RC and tag-gated npm provenance workflow;
  every release gate runs before publication;
- release notes and [external administration checklist](docs/SQLBraid_release_readiness.md).
  npm scope/bootstrap/trusted-publisher readiness remains an external prerequisite;
  no `v0.1.0` tag or npm/Marketplace publication is implied by this candidate;
- no stretch database/driver packages or transaction-profile runtime API.

### PV13 — Five-DB typed parameters, localized/versioned docs, and npm bootstrap — implemented baseline

- `sql.bind(value, hint)` descriptors, aligned rendered `parameterHints`, and
  prepared-query hint shape protection (the PV13 historical representation;
  PV14 derives these views from atomic `RenderedParameter` records);
- PostgreSQL/MySQL/SQLite explicit hint rejection; no silent ignore path;
- Oracle and SQL Server portable roots with parameter factories and
  Node driver subpaths, while real database evidence remains a release-gate
  prerequisite for Official labels;
- conservative/open-world Oracle and SQL Server inspector/tooling identities;
- English/Korean getting-started and parameter-hint docs, four-label five-DB
  support evidence matrix, package map, and version/locale documentation contract;
- 15 scoped packages plus the unscoped `sqlbraid` CLI convenience package;
- prerelease/OIDC publication bootstrap and restart-safe release registry.

### PV14 — Logical binding transport and observer diagnostics — implemented baseline

- logical immutable `RenderedStatement` (`segments` plus atomic `parameters`) is
  the only execution source of truth;
- driver-owned placeholder/materialization SPI for all five first-party paths,
  with pure pre-acquire binding descriptions and provider/lease identity checks;
- one-render prepared execution with transport-neutral shape identity and
  adapter-owned effective reuse;
- observer effective execution plans, distinct `"materialize"` errors, and lazy
  cached diagnostic `literalizedSql()` with redaction/truncation;
- custom-driver author guide and native-template value-only security/conformance
  guidance.

### PV15 — Pre-RC streaming, routines and Vite — implemented baseline

- explicit executor `stream()`/`call()` capabilities with no buffered fallback;
- cleanup-before-release on exhaustion, break, mapper failure and abort; cleanup
  failures discard pooled resources and poison direct connections;
- native pg-cursor, mysql2 prepared Execute stream, SQLite iteration, Oracle
  ResultSet and bounded Tedious streaming;
- heterogeneous routine tuples and per-channel Standard Schema mapping;
- PostgreSQL scalar OUT and transaction-owned refcursors; Oracle scalar OUT/INOUT,
  REF CURSORs and implicit results; MySQL emitted result sets; Tedious native
  OUTPUT/RETURN and emitted sets;
- MySQL OUT/INOUT descriptors remain Unsupported because mysql2 does not expose
  sufficient carrier metadata; no session-variable rewrite or guessed last set;
- SQLite calls and SQL Server direct cursor OUT remain explicitly Unsupported;
  table/set-returning functions use ordinary row queries; `callStream()` is reserved;
- `@sqlbraid/vite` pre-transform and compiler `transformSource` original-source maps,
  with Vite owning TS/JSX transpilation;
- packed TanStack Start / Node 24 finance acceptance with Korean STRICT tables,
  native SQLite int64 transport and canonical string output, and server-only
  database dependencies;
- prepared factory/shape errors are observable before execution, with dialect,
  parameter direction/output identity and hint structure in logical shape.

### PV16 — Native capabilities, bulk, browser and D1 — implementation verified

- native materialized DML returning, including Oracle OUT ordinal normalization;
- separate `@sqlbraid/mariadb` dialect and official-connector adapter;
- homogeneous command-only `db.bulk()` with complete pre-acquire shape/bind
  validation, one operation lifecycle and truthful native/prepared-loop modes;
- browser-safe template/runtime, SQLite WASM OO1 adapter and real worker preview;
- D1 materialized queries and native batch; callback transactions and streaming
  remain explicitly Unsupported;
- named native SQL capability gates and structural bulk benchmarks.
- numeric fidelity helpers and driver representation profiles;
- support manifests as the machine-readable evidence source, with EN/KO
  translation freshness checks across all paired prose pages, without blanket opt-outs;
- bilingual data-representation documentation covering exact integers/decimals,
  custom parser caveats, and the distinction between native SQL transparency and
  grammar support;
- `db.environment({ targets? })` is an optional observed, cached snapshot; an
  unmatched or incomplete tuple remains Compatible rather than a guessed
  Official claim.

The PV16 records above are historical evidence only. PV18 starts from review
baseline `2119d9676b05fb2531eaf7aac1ef37741600ba40`; its profile/container
contract requires new exact-SHA Runtime, Docs and Release dry-run gates. No
current run ID, final SHA, or support-label promotion is claimed here. D1 remains
Compatible because its managed SQLite version is unreported, and Oracle Free
23.9 evidence does not certify Oracle 19c.

The workspace has 18 publishable packages. Certification records name the
verified implementation revision; subsequent changes require their own exact-SHA
Runtime, Docs and Release dry-run gates. User acceptance and explicit release
authorization remain required. No tag, publication or dist-tag mutation is
authorized by implementation progress.

### PV18 — Profile-coherent fidelity, containers, and RC certification — pending

- every effective PostgreSQL, mysql2, and MariaDB representation profile has a
  stable descriptor (`id`, JSON/temporal modes, TypePolicy, and exact connection
  options where relevant);
- portable `typePolicyForProfile({ json, temporal })` selectors are reused by
  runtime and codegen, with immutable mappings and provenance hashes;
- driver raw representation is recorded separately from SQLBraid canonical
  representation. Exact string IDs and generated IDs remain canonical decimal
  text; affected/row counts and bulk input counts remain safe operational
  numbers;
- PostgreSQL native JSON roots are `unknown` unless a narrower root contract is
  proven. Native temporal mappings are per type (`date`/`timestamp`/
  `timestamptz` versus `time`/`timetz`/`interval`), not one broad Date mapping;
- scalar fidelity does not recursively certify arrays, domains, ranges,
  composites, Oracle objects, SQL Server `sql_variant`, vectors, or parsed
  JSON roots. Container claims require container-specific transport and codegen
  evidence;
- SQL Server exact decimal/money output remains fail-closed under Tedious
  Number transport; exact input uses a character hint plus authored CAST/CONVERT;
- EN/KO data-representation, driver setup, support, limitations, roadmap,
  release notes, driver-author, README, public API, and readiness docs remain
  synchronized. Free-only support policy and contributor-owned CI are required;
- final Runtime, Docs, benchmark, and Release dry-run gates must pass on one
  exact final SHA before any RC readiness or support-label promotion claim.

### Post-release candidates

- application input mapping/codecs;
- optional DB verifier tooling;
- Bun.SQL/postgres.js/bun:sqlite adapters where justified;
- cancellation;
- pipeline/COPY/LOAD DATA;
- query transformer/rewrite SPI if demanded;
- routing/retry policy;
- OpenTelemetry integration implemented on the observer SPI;
- additional codegen helpers.

---

## 15. Pre-release definition

SQLBraid is ready for public pre-release when a developer can:

1. write normal SQL with safe binds and `@braid` dynamic clauses;
2. declare row contracts or attach a Standard Schema result mapper;
3. execute rows/commands/calls with honest result-kind behavior;
4. use a pool for ordinary operations while an explicit transaction closure pins one physical connection;
5. audit/log SQL, binds, duration, results and transaction boundaries through the observer SPI without SQLBraid imposing a logger;
6. use PostgreSQL/MySQL/SQLite first-party adapters on the runtimes explicitly marked Official;
7. distinguish the exact Oracle Free/SQL Server Developer profiles from
   unverified server lines and Unsupported capabilities;
8. optionally generate table-oriented TypeScript models from metadata;
9. use compiler/CLI/LSP without mandatory live-DB semantics;
10. trust unsupported analysis to remain unknown rather than guessed.

PV16's verified implementation includes transport materialization, observer
effective-plan diagnostics and custom-driver conformance. Exact-SHA gate
success is not user acceptance or publication authorization. RC publication
remains deferred; the existing package version is unchanged.

The success metric is **how little SQLBraid gets in the way of SQL while providing strong TypeScript and execution boundaries around it**.
