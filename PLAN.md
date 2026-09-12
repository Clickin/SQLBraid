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
- first-party PostgreSQL, MySQL and SQLite dialects/adapters;
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
dialect     SQL surface / placeholders / quoting / primitive DB semantics
driver      protocol/API bridge and result normalization
runtime     Node / Bun / Deno execution environment
```

A PostgreSQL `pg` adapter remains one adapter if the same public driver API works on Node, Bun and Deno. Runtime compatibility must be proved by CI before being advertised as official.

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
- Oracle/node-oracledb support before the public pre-release.

Input mapping is explicitly deferred. JavaScript database drivers do not expose a JDBC-like universal application-input type system, so result mapping does not imply a symmetric input framework.

Oracle is a post-release dialect/driver project because `node-oracledb` requires Oracle-specific bind, OUT/IN OUT, cursor, LOB, NUMBER, DATE/TIMESTAMP, object-type, result-set and session semantics.

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

### 3.3 Result kinds are explicit

```ts
sql.rows<Row>`...`
sql.command`...`
sql.call<Row>`...`
sql`...` // unknown
```

Adapters report the actual row/command result kind. Runtime checks it against the declaration. `BRAID_RESULT_KIND` is post-execution and does not undo side effects.

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
final SQL text
readonly bind-value array
binding map when available
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

---

## 8. Dialect / driver / runtime architecture

### 8.1 Dialects

First-party pre-release dialects:

- PostgreSQL;
- MySQL/MariaDB-compatible MySQL surface where supported by mysql2 tests;
- SQLite.

A new driver does not imply a new dialect.

### 8.2 First-party adapters

Current primary adapters:

```text
PostgreSQL -> pg
MySQL      -> mysql2
SQLite     -> node:sqlite
```

Future adapters may be added only when they provide real value. `QueryExecutor`/provider SPIs remain the escape hatch for other drivers.

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
The README matrix is Compatible pending observed GitHub CI; a workflow file
alone is not a CI pass. Node keeps `>=22.18.0`; Bun/Deno promises cover exact
tested versions only. The workflow pins the Node floor and those Bun/Deno versions.

Reviewed compatibility imports are `node:buffer` for allocation-free UTF-8 byte
counting and `node:async_hooks` for transaction context. SQLBraid-owned public
runtime declarations compile without Node ambient types. Tooling (`compiler`,
CLI, metadata/codegen, LSP) remains Node-first.

---

## 9. Metadata and code generation

Database metadata is optional development tooling and not a requirement for normal execution.

PV8 renames/reframes:

```text
@sqlbraid/schema -> @sqlbraid/metadata
```

PV9 adds optional:

```text
@sqlbraid/codegen
```

Initial codegen scope is deterministic table metadata to TypeScript `Row`/`Insert`/`Update` models. It does not promise arbitrary SELECT/JOIN result inference.

---

## 10. Database verification

Prepare/describe verification is not a pre-release core requirement. If later justified, it remains optional development tooling based on real database evidence.

---

## 11. CLI and LSP

Pre-release CLI priorities are TypeScript/Braid checking and guarded-template build. Metadata/codegen commands come later.

The LSP focuses on SQLBraid diagnostics, mapper/declaration hover and metadata-backed completion, not its own SQL semantic engine.

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

### PV7 — Runtime portability — implemented locally; CI promotion pending

- reject pools in official direct PostgreSQL/MySQL factories, including runtime guards;
- observer `cardinality` stage and `durationMs` public timing fields, without aliases;
- packed Node/Bun/Deno smoke, concurrent ALS isolation, source/distribution audit;
- real pg/mysql2 direct/pool matrix and node:sqlite capability/full adapter smoke;
- pinned GitHub Actions release/runtime jobs; publish observed CI before Official labels;
- README uses Official/Compatible/Custom/Unsupported labels with exact tested versions;
- no new runtime-specific drivers, including when an existing adapter is Unsupported.

### PV8 — Metadata package cleanup

- `@sqlbraid/schema` -> `@sqlbraid/metadata`;
- preserve deterministic snapshots, inspectors and drift functionality.

### PV9 — Optional `@sqlbraid/codegen`

- metadata -> `Row` / `Insert` / `Update` models;
- deterministic output;
- TypePolicy-aware primitive mapping.

### PV10 — Codegen CLI and overrides

- naming/custom type policies;
- filters;
- generated-file stability.

### PV11 — LSP metadata/codegen integration

- metadata-backed completion/hover;
- generated-model navigation;
- bounded caches/cancellation.

### PV12 — Public pre-release/Product Hunt hardening

- five-minute quickstart;
- package/API cleanup;
- result mapping and audit/logging examples;
- runtime support matrix;
- packed consumer gates;
- release notes/product positioning.

### Post-release candidates

- Oracle dialect + `node-oracledb` adapter;
- application input mapping/codecs;
- optional DB verifier tooling;
- Bun.SQL/postgres.js/bun:sqlite adapters where justified;
- cancellation;
- bulk/pipeline/COPY/LOAD DATA;
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
6. use PostgreSQL/MySQL/SQLite first-party adapters on the runtimes explicitly marked official;
7. optionally generate table-oriented TypeScript models from metadata;
8. use compiler/CLI/LSP without mandatory live-DB semantics;
9. trust unsupported analysis to remain unknown rather than guessed.

The success metric is **how little SQLBraid gets in the way of SQL while providing strong TypeScript and execution boundaries around it**.
