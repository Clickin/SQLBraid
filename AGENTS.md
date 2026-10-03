# AGENTS.md

This file defines the rules for the whole repository. The rules apply to AI coding agents and to human contributors who make architectural changes to SQLBraid.

The architecture overview is in `docs/mental-model.md`. The Korean translation is
in `docs/mental-model.ko.md`. Each boundary has its own durable authority:

- application compatibility: `docs/public-api-audit.md`;
- driver implementation rules: `docs/driver-author-guide.md`;
- release mechanics: `docs/SQLBraid_release_readiness.md` and the release workflows;
- user-facing behavior: the README and the website;
- documentation style: `docs/writing-style.md`.

Historical planning artifacts are context. They are not authority.

---

## 1. Product identity

SQLBraid is a **SQL-first data-access toolkit for TypeScript**.

Canonical authoring:

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
  /*@braid end*/
`;
```

The project is not an ORM. It is not query-builder-first. It is not a validator framework. It is not a parity implementation of another database library.

---

## 2. Architecture priority

Use this order of priority:

1. SQL-first authoring;
2. safe bound parameters;
3. readable, local dynamic SQL;
4. explicit result declarations for the application;
5. Standard Schema for one-row result mapping;
6. thin dialect and driver boundaries;
7. explicit ownership of physical connections;
8. observable execution, not hidden middleware;
9. offline ordinary development;
10. optional metadata and codegen outside the runtime and the compiler;
11. deletion and simplification, not partial SQL semantics.

---

## 3. Do not rebuild database semantics

PV3 removed the broad SQL AST and resolver. Do not add them again.

Do not add complete SQL grammars, function catalogs, operator or coercion systems, or arbitrary SQL-to-TypeScript inference.

If a smaller mechanism can solve a requirement, use it. Smaller mechanisms are explicit declarations, Standard Schema, driver metadata, codegen and narrow lexical checks.

---

## 4. Result declarations and mapping

### 4.1 Explicit declaration

```ts
sql.rows<UserRow>`SELECT ...`;
```

The developer is responsible for the match between the SQL and the result, unless runtime validation or mapping is attached.

### 4.2 Query-bound result mapping

```ts
sql.rows(UserSchema)`SELECT ...`;
```

This form uses the official Standard Schema protocol. The output type of the schema is the row type.

Pipeline:

```text
driver row
 -> dialect TypePolicy normalization
 -> query-bound Standard Schema
 -> optional execution-level schema
 -> application row
```

Use `@standard-schema/spec`. Do not keep a private copy of the protocol. Do not make Valibot, Zod, ArkType or a different implementation a runtime dependency.

### 4.3 One row to one value

Result mapping can validate, transform, parse JSON or text, and create temporal or domain values. It must not add ORM graph assembly, identity maps, relation hydration or an entity lifecycle.

### 4.4 Input mapping stays outside the runtime

Do not implement an input-codec framework for applications, unless the user explicitly changes the roadmap.

An ordinary `${value}` stays a value that the driver binds.

---

## 5. Dynamic SQL and compiler rules

The supported directive namespace is `/*@braid ...*/`.

The supported v1 directives are `if`, `choose`, `when`, `otherwise`, `where`, `set` and `trim`.

Guarded lowering must keep these properties:

- lexical `this`;
- evaluation order;
- evaluation only once;
- no evaluation of inactive branches;
- TypeScript narrowing;
- source maps and directive prologues;
- the identity and output typing of query-bound mappers.

Do not add exponential variant proof.

---

## 6. Bind and structural SQL

Ordinary interpolation is always bound.

Structural SQL requires explicit APIs:

<!-- doc-snippet: skip -->

```ts
sql.ident(...)
sql.fragment`...`
sql.list(...)
sql.join(...)
sql.raw(...)
```

`sql.raw()` is trusted and unsafe. A security regression here blocks the release.

### 6.1 Logical statement and binding boundary

Template and core rendering produce an immutable `RenderedStatement`:

```ts
interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly nativeTemplate?: TemplateStringsArray;
  readonly dialectId: string;
  readonly resultKind: QueryResultKind;
  readonly routineProcedure?: RoutineProcedure;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}
```

`segments.length === parameters.length + 1`. Each `RenderedParameter` is one
value, with an optional interpolation and an optional `ParameterTypeHint`.
Structural helpers are merged into the segments.

Keep this boundary of values only. A parameter is never raw SQL, an identifier,
a nested query, a driver fragment or a tagged-template command.
`RenderedStatement` is the source of truth for execution. Do not keep parallel
mutable text, values, hints or maps.

Dialects describe the lexical, quoting and type behavior of SQL. They do not
generate placeholders. Driver packages implement
`StatementBindingAdapter.describe()`. They own the materialization of
`text-positional`, `text-named`, `typed-request` or `native-value-template`.
Use `parameterizedSql(statement, placeholder)` only as a derived view. Read
[`docs/driver-author-guide.md`](docs/driver-author-guide.md) before you add a
custom executor, provider or binding adapter.

The binding description is pure and occurs before acquisition. `QueryExecutor`
and `ConnectionProvider` expose the same `statementBinding` object. Leases must
keep that identity.

The prepared shape is logical: `resultKind`, the canonical segments and the
signature of the ordered hints. Each prepared invocation renders once, before
binding and execution. The adapter owns driver and server reuse.

`db.bulk()` accepts only homogeneous command factories.

- Preflight each input before acquisition.
- A shape mismatch fails. Do not group or rewrite the inputs.
- Root bulk has no portable promise of atomicity. `tx.bulk()` uses the pinned lease.
- Keep one logical statement, one value matrix and one bulk observer lifecycle.

---

## 7. Result-kind invariants

Canonical tags:

```ts
sql.rows<Row>`...`;
sql.command`...`;
sql.call<RoutineCallResult<Output, Sets, ReturnValue>>`...`;
sql`...`; // unknown
```

Adapters report the actual kind: row or command. The runtime enforces the declaration in one central place.

A kind mismatch is found after execution. Never claim that it prevents side effects.

Routine result generics describe the whole result. They never describe one shared row type.

- The `output`, the heterogeneous `resultSets` and the actual `returnValue`
  channels each have their own Standard Schema declaration.
- Collect and close all materialized driver resources. Release root leases. Then
  map the application values.
- OUT cursor sets come first, in descriptor order. Implicit or emitted sets
  follow, in driver order.
- Scalar output never takes a place in a result set.

`sql.out()` and `sql.inOut()` are logical parameters that carry only values.
`sql.out()` also supports materialized Oracle `sql.rows` RETURNING INTO. INOUT
stays call-only. Oracle positional OUT ordinals do not depend on the IN
parameters between them.

Driver-specific rules:

- PostgreSQL refcursors require an existing `db.tx()`.
- MySQL emitted sets are supported. But mysql2 does not give sufficient evidence
  for OUT carriers. Thus, descriptors fail explicitly. Never guess the final set.
  Never rewrite through session variables.
- Tedious native procedure metadata exposes the actual OUTPUT and RETURN. It does
  not invent a wrapper status.
- SQLite calls and direct SQL Server cursor OUT stay Unsupported.
- `callStream()` is reserved. It is not an implemented API.

---

## 8. Physical connection and transaction invariants

### 8.1 QueryExecutor is one serialized domain of execution ownership

For ordinary direct drivers, a `QueryExecutor` owns one physical execution
resource. A higher-level client can be a direct executor only when its
advertised capabilities stay true. Do not infer `session.pinned` or transaction
continuity only because calls share one JavaScript object.

If ordinary client operations can use unrelated logical connections,
`session.pinned` is unsupported. If `transaction` is guaranteed, the adapter must
keep one continuous transaction from `begin`, through each scoped query and
savepoint, to `commit` or `rollback`. A change to one dedicated transaction
handle during `begin()` is valid. To route transaction statements across
unrelated connections is not valid.

Physical driver methods can be synchronous or asynchronous. The public
`Database` stays async. The materialized and control methods of `QueryExecutor`
use the `Awaitable<T>` type that the driver-author guide defines. Keep
`stream()` as `AsyncIterable`. Bridge synchronous native iterators inside the
adapter. Do not make the stream SPI wider.

### 8.2 Pools use a provider/lease boundary

PV6 gives `ConnectionProvider` / `ConnectionLease` and the explicit factories `createPooledDatabase`, the PostgreSQL pool and the MySQL pool. The stable semantic model is:

```text
root operation
 -> acquire one physical lease
 -> driver DB I/O
 -> release lease
 -> application post-processing
```

Do not adapt a pool by exposing the pool-level `begin/query/commit` as a `QueryExecutor` if those calls can use different physical connections.

### 8.3 The transaction closure pins transaction continuity

The canonical transaction boundary is the `db.tx(...)` closure. `transaction(...)` has been removed:

```ts
await db.tx(async (tx) => {
  await tx.execute(first);
  await tx.execute(second);
});
```

Requirements:

- Acquire or establish one transaction resource.
- Begin on that resource, or get the dedicated interactive transaction handle of the driver.
- Each `tx.*` call uses the same domain of transaction continuity.
- Commit or roll back on the same transaction resource.
- Release or close only after the transaction is complete.
- Nested transactions use savepoints on the same transaction resource.
- Outer or root `db` calls from the same transaction async context must fail. They must not silently escape to a different connection.

Outside `db.tx`, each root operation can use any connection that the provider or the higher-level client supplies.

`db.session(fn)` requires `session.pinned`. It pins one lease or session and does
not start a transaction.

- Nested sessions, `session.tx()` and `tx.session()` use the current pinned
  resource where the capability exists.
- Scoped database handles and prepared handles expire with their callback.
- Started streams close before the lease release.
- `db.prepare()` accepts row, command or call factories with zero inputs or one
  required input.
- Keep rendering once and the logical shape checks.

### 8.4 Result mapping and lease lifetime

For materialized results, release the root lease after the DB I/O and the result materialization. Release it before the asynchronous Standard Schema mapping and validation.

Do not hold limited pool connections while application mapping runs.

Streaming is different. A live stream or cursor keeps its lease until the iteration closes.

`QueryExecutor.stream()` and `call()` are explicit methods. Unsupported custom
capabilities reject. They never buffer or simulate.

- Each stream returns or closes its driver iterator before it releases the lease.
- The native paths are pg-cursor, the mysql2 prepared Execute stream, SQLite
  iterate, the Oracle ResultSet and bounded Tedious row events.
- MySQL `break` drains the stream so that the connection can be reused. Abort
  destroys or discards it.
- A cleanup failure poisons or discards the physical resource.
- `db.stream()` must not use a full-result array in SQLBraid.

Numeric and data representation (PV17):

- Exact SQL numerics are raw `string`. IEEE-754 approximate types are `number`.
- TypeMapping separates database semantics, representation and transport
  fidelity.
- Application BigInt, Decimal and Money transformations belong to Standard
  Schema.
- SQLite uses bigint internally for int64 transport. It is not public output.
- D1 stays limited to the values that its Number transport keeps.
- Reject lossy exact decimal transport. Do not stringify a Number that is already
  rounded.

Parameters and conversions:

- Ordinary `undefined` IN parameters reject before acquisition. `null` is SQL NULL.
- JSON text and parsed JSON have separate fidelity claims.
- The temporal Date convenience does not prove fractional precision or zone
  fidelity.
- Where the native driver transport is lossy, the SQL that the user writes owns
  the explicit text conversions. SQLBraid never rewrites SQL to supply them.
- Capability fixtures prove driver input, output and resource ownership with
  native SQL. They do not prove database syntax support.

---

## 9. Execution observer and interceptor rules

PV6 gives a seam for execution observers and interceptors. It is for SQL logging, bind logging and redaction, audit and metrics.

Use a single discriminated event API, such as:

```ts
interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}
```

The required coverage includes:

- the derived parameterized SQL, the lazy diagnostic `literalizedSql(options?)`,
  the binds and the effective adapter, dialect, transport and reuse plan;
- before physical execution;
- after the driver result;
- the completion of result mapping;
- the lifecycle of queries, calls, batches and prepared queries;
- stream start, end and error;
- transaction begin, commit and rollback;
- the savepoint lifecycle;
- durations, result kind, row count and error stage.

### 9.1 Observers can only observe or fail

Observer interfaces are readonly.

Do not let the observer API rewrite these items:

- SQL;
- bind values;
- result objects;
- the transaction target;
- retry or routing decisions.

Observers can throw.

- A failure before execution prevents the DB execution.
- A failure after execution propagates. It cannot undo a side effect of a root operation. Inside a transaction, it takes part in the rollback.
- If an observer fails while it reports an existing failure, keep the original error too.

### 9.2 Sensitive bind values

Observers can see the original bind values, because audit systems sometimes need them. SQLBraid must never log them by default.

Examples and docs must redact by default. The application policy controls storage and retention.

`literalizedSql()` reconstructs the SQL from the logical segments and
parameters. It never searches or replaces placeholders. It is only for
diagnostics. Never use it as execution input.

- Redaction is the default.
- It supports a maximum value length, a summary or full mode for binary values
  and a custom redactor.
- Unsupported objects get a safe descriptive marker. This prevents an accidental
  `toString()` execution.

### 9.3 No built-in logger backend

Do not add mandatory pino, winston or OTel dependencies to core or runtime.

The optional `@sqlbraid/opentelemetry` observer gives DB client tracing and the
stable duration metric through the readonly observer SPI.

- It owns no logger, SDK, exporter or driver instrumentation.
- It does no SQL rewriting and no context injection.
- It must isolate its own telemetry failures, so that they cannot change
  SQLBraid execution.

---

## 10. Dialect, driver and runtime separation

A dialect is about SQL and database behavior. It is not about the JavaScript driver or the runtime.

```text
dialect: PostgreSQL / MySQL / SQLite / Oracle / SQL Server
driver:  pg / mysql2 / node:sqlite / better-sqlite3 / libSQL / node-oracledb / Tedious / future alternatives
runtime: Node / Bun / Deno / browser / Worker
```

Do not duplicate PostgreSQL dialect logic only because `pg`, postgres.js and Bun.SQL are different. Do not duplicate SQLite dialect or type-policy logic for `node:sqlite`, better-sqlite3, libSQL, WASM or D1.

Runtime support labels:

- Official — SQLBraid CI covers the exact tuple of runtime and driver.
- Compatible — there is no exact certified capability target. This is true even if broader host or compatibility checks pass.
- Custom — a user integration through the executor or provider SPI.
- Unsupported — a required capability is absent, or the checks of SQLBraid fail.

Existing pinned certification evidence applies only to the exact recorded tuple.

- Do not infer a minimum Node version for a package from one Official target.
- A packed-consumer compatibility pass on a low Node version does not promote a
  database/driver capability tuple to Official.
- `support/targets/` stays the evidence for capability certification.
- Install compatibility of runtimes and drivers uses a separate machine-readable
  matrix and exact CI cells.

Keep these Node policies separate:

- the Node version for contributors and builds;
- the minimum compatible Node version;
- the recommended supported-LTS Node version;
- the requirements of each driver.

The repository toolchain can stay on a modern Node release. The published
runtime tarballs are tested on older Node versions. If a driver raises its own
minimum Node version, it must not raise the floors of unrelated `@sqlbraid/*`
packages. The published runtime packages currently declare `node >=16.20.2`. The
tooling packages (CLI, compiler, codegen, metadata, tooling, language server and
Vite) declare `node >=22.18.0`. Change a floor only to a version that the packed
consumer gate proves.

Compatibility tests must use this procedure:

1. Build and pack on the contributor runtime.
2. Install the tarballs under the target Node, with exact driver versions.
3. Run small plain-JavaScript smoke and integration programs.

Do not require old Node versions to run pnpm, tsdown, TypeScript or Vitest. The
recommended runtimes are the LTS releases that are currently supported. EOL
runtimes can stay compatible, but they are not recommended.

Limit Bun and Deno support to the exact tested versions. Do not infer floors.

- Keep the runtime source and packed audit.
- The template byte counting is safe for browsers.
- The runtime uses conditional internal async-context backends. It does not use
  an ALS polyfill for browsers.
- The direct pg and mysql2 factories accept only physical clients.

Tooling can stay Node-first while the runtime libraries become portable.

---

## 11. Oracle, SQL Server and explicit parameter types

Oracle/node-oracledb Thin and SQL Server/Tedious are established first-party
adapter surfaces. Driver subpaths stay separate from the portable dialect roots.
Official support requires real-database CI evidence from the same revision. Unit
mocks and host inference are not sufficient.

`sql.bind(value, hint)` describes a database parameter type that the user
selected explicitly. It is not an input codec and not Standard Schema
validation. JavaScript and TypeScript types are never universal evidence of a DB
type.

- An adapter must obey a hint or reject it explicitly before execution.
- Ordinary binds keep the driver behavior.
- Executable fingerprints and prepared shape guards include the structure of the
  hint. They never include the values.

Oracle NUMBER, LOB and temporal semantics, and SQL Server precision and scale
semantics, need handling that is specific to the driver. Unsupported call, OUT
or streaming capabilities must stay explicit. Do not simulate them.

Certifications in `support/targets/` name the tested revision and the CI run. A
changed revision requires fresh Runtime, Docs and Release dry-run evidence.
Progress in the implementation alone does not set new support labels. SQLBraid
is GA. But publishing, tagging, support promotion and release actions stay
operations that need separate authorization.

---

## 12. Metadata and codegen

Database metadata is optional tooling.

PV8 gives `@sqlbraid/metadata`. It contains:

- database facts in `MetadataSnapshot` (`format: "sqlbraid-metadata"`,
  `formatVersion: 1`);
- deterministic identity and drift;
- `MetadataInspector`.

Old snapshots without the discriminator are rejected.

Dialect inspectors belong only at `/inspector` subpaths. Their import of
metadata is type-only, with an optional peer. Runtime roots must install and run
without metadata. Keep the packed runtime-only gate and the metadata-tooling
consumer gate.

- Identity means proven identity or autoincrement generation. It does not mean
  membership in the primary key.
- Generated and write flags require database evidence. If evidence is absent,
  the value is unknown.
- Metadata contains DB types. It does not contain TypeScript guesses or
  TypePolicy or compiler fields.

Standard Schema owns the validation and transformation of application rows.
TypePolicy owns the runtime primitive representation.

PV9 `@sqlbraid/codegen` gives the pure, offline
`generateModels(metadata, { typePolicy })`. It produces table-oriented `Row`,
`Insert` and `Update` declarations.

- TypePolicy is a selected input. It is never embedded in metadata snapshots.
- Row uses the output representation. Insert and Update use the input
  representation and explicit DB evidence for null, default, identity,
  generated and write.
- Identity alone makes Insert optional. It does not exclude Update.
- Only tables get write models.
- Unknown types and SQLite non-STRICT columns stay `unknown` with diagnostics.
  There is never an `any` fallback.
- Keep the exact DB column keys, deterministic model names that cannot collide,
  and the provenance of metadata and TypePolicy.
- The generator does no filesystem writes, no config lookup, no live inspection
  and no arbitrary SELECT inference.

PV10 owns the CLI, config, filters, naming and type overrides.

- Filters are exact metadata selectors.
- The precedence of overrides is column > database type > TypePolicy. Input and
  output are resolved independently.
- Column names stay exact DB keys.
- Unknown evidence stays unknown. It never becomes `any`.
- Runtime and compiler must not get metadata or codegen dependencies. Keep the
  packed runtime-only exclusion gates.
- CLI config and filesystem behavior never move into codegen core.
- Unchanged outputs are not written again. Validation of multiple targets
  completes before any write.
- Config files are executable Node code. They are not sandboxed.
- Runtime packages never depend on the CLI, codegen or metadata.

### 12.1 Agent-native tooling

PV11 `@sqlbraid/tooling` owns the config, the workspace and the semantic
evidence for standard LSP and for CLI `inspect ... --json`.

- Keep `@sqlbraid/cli/config` as the intentional re-export of the shared config
  interface.
- Tooling depends on core, compiler, metadata and codegen. It never depends on
  the runtime, drivers, CLI, LSP or VS Code.
- Codegen needs only the id, hash and mappings of TypePolicy. It does not need
  runtime encode or decode.

Metadata is open-world positive evidence. A miss is unresolved. It is not invalid
SQL. Built-ins, extensions, UDFs, temporary and session objects and CTEs stay
legal opaque SQL.

- Only `RoutineSnapshot.argumentsComplete === true` permits exact signatures.
  The first-party pg and mysql inspectors currently report false.
- Keep the optional boolean validation and the canonical, hash and drift
  evidence without a bump of the metadata version.

Diagnostics and editor features:

- Use the provenance of compiler diagnostics. Publish Braid diagnostics and the
  TS diagnostics that exist only in the overlay. Do not duplicate native TS
  diagnostics.
- Completion owns only static SQL. It never owns normal TS or `${...}`.
- Navigation uses positive lexical identity and the current ranges in real
  files. Omit ambiguous references and stale generated offsets.
- Keep caches for each workspace. Keep them bounded and invalidated.
- Discard results that are cancelled or from a stale version. Do not claim
  synchronous preemption of TypeScript.

Standard LSP is primary. The portable skill is `skills/sqlbraid/SKILL.md`. VS
Code stays a thin client with a matching version. Native TypeScript is the
authority. Keep the actual stdio gate, the packed agent-consumer gate and the
editor-host gate in `test:all`. Runtime-only packed installs must exclude
metadata, codegen, tooling, CLI, LSP and the editor.

Keep the dialect, driver, transaction-profile and execution-runtime concerns
independent, as the public API audit and the release-readiness records document
them. Node, Bun and Deno host compatibility is separate deployment evidence.

The stable 1.x API supports standard transaction isolation and read-only
options. If the options are omitted, the actual DB or session default stays.
Richer transaction profiles and vendor-specific modes stay outside this API.

---

## 13. Testing requirements

PV15 adds the publishable package `@sqlbraid/vite`. It is tooling, not a
runtime dependency.

- The compiler `transformSource` lowers guarded templates. It does not transpile
  TS or JSX. Vite owns transpilation.
- Keep the original TS/TSX maps, the evidence for dev, build, HMR and SSR, and
  the packed TanStack Start finance gate.
- TanStack Start database drivers and execution stay server-only.
- Browser SQLite uses the separate WASM adapter. It does not use shims of Node
  drivers.

PV16 adds the publishable package `@sqlbraid/mariadb`, and the SQLite WASM and
D1 subpaths.

Use Vitest for fast tests. Use Testcontainers for PostgreSQL and MySQL. Use real
native SQLite drivers for their adapter suites. `node:sqlite`, better-sqlite3,
libSQL, SQLite WASM and D1 must share behavioral conformance where their native
capabilities overlap. Do not act as if unsupported streaming or session features
exist.

Keep the packed-consumer validation: `publint`, Are The Types Wrong, ESM and type
resolution, executables, engine metadata and no leakage of monorepo paths.

Keep the PV6 regression gates for:

- mapper re-entry without a root-lock deadlock;
- a lease that is acquired and released exactly once for each root materialized operation;
- one lease for a complete transaction closure;
- nested savepoints on the same lease;
- the rejection of root-db escape inside a transaction context;
- the lease lifetime of streams;
- the registration order of observers;
- an observer failure before execution prevents the DB call;
- the semantics of an observer failure after execution;
- the preservation of original errors;
- the visibility of SQL and binds, and no built-in logging;
- transaction lifecycle events.

Regressions for sync-aware executors must prove the equivalence of these cases:
plain-value success, a synchronous throw, Promise success and rejection, bulk
and transaction control. Existing async adapters must compile without change.
`QueryExecutor.stream()` stays AsyncIterable. It must keep the semantics of
early return, iterator cleanup and cleanup-error aggregation.

Compatibility CI must test the actual packed package artifacts with exact Node
and driver versions.

- Old-runtime lanes use plain JavaScript consumer tests. They do not use the
  repository test runner.
- The gate includes installation, import, a real query where the driver is
  available, result fidelity and transaction semantics.
- Floating dependency versions are not evidence.

PV7 must use actual Bun and Deno smoke tests and CI before it marks combinations
official. For changes to packed runtimes or drivers, run
`pnpm run test:runtime`. It needs Docker, Bun and Deno, or dedicated test DB
URLs. The observer taxonomy uses `cardinality` separately from `result-kind`.
The public elapsed-time fields are `durationMs`.

PV14 regressions must cover:

- the `segments`/`parameters` invariant;
- prepared execution that renders once;
- shape identity that does not depend on the transport;
- all adapter materializers;
- `materialize` failures before acquisition;
- the binding identity of the provider and the lease;
- immutable observer execution plans;
- direct `literalizedSql()` reconstruction from segments, with redaction and
  truncation;
- large SQL;
- the security fixture for native templates that carry only values.

These are verification requirements. They are not evidence of a passing SHA
until the exact final revision is checked.

Before a substantial change is complete, run the applicable gates:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:db:sqlite
pnpm run test:db:postgres
pnpm run test:db:mysql
pnpm run test:consumer
pnpm run test:all
pnpm run pack:check
```

If DB or runtime infrastructure is unavailable, report the gate as not run. Never report it as passed.

---

## 14. Repository discipline

- Contributor and build tooling can keep a modern Node floor. The Node floors of published runtime packages are compatibility claims that need evidence. Do not raise them only because one driver or one CI tool requires a newer Node.
- ESM is the default.
- Keep package exports narrow.
- Do not bundle TypeScript or DB drivers by accident.
- Keep the CLI and LSP shebangs and the packed executable tests.
- Use tsdown for builds and `tsc --noEmit` for semantic checks.
- Inspect the current HEAD before broad changes.
- Keep dependency ownership explicit. Test-only drivers, fixtures, integration scripts and native consumers belong to the private `tests` package. Root and package manifests declare a dependency where the code that imports it runs, not only where orchestration starts it.
- Remove obsolete paths. Do not keep parallel implementations.
- Do not publish, tag, release or force-push unless the user explicitly requests it.
- Never change non-test databases.
- The root `package.json` owns the orchestration of build, release, lint, format and test. The private `tests/package.json` explicitly owns test-only drivers, fixtures, integration scripts and native consumers. Package manifests own their declared runtime and peer dependencies.
- The browser, D1 and Bun SQL integration implementations are under `tests/scripts`. Root package commands can keep stable names while they run those paths in `tests`. CI and workflow references must use the moved paths. Do not restore root copies or add wrappers.
- Node ESM resolves bare imports from the location of the importing module, not from the process cwd. When an integration script moves, update each caller and import path to the moved file. Do not depend on cwd changes, wrappers or compatibility shims.
- Oxlint runs the correctness, suspicious and performance categories without type-aware or TypeScript 7 analysis. Correctness stays an error globally.
  - An exception must be a path-scoped override for a deliberate rule. Examples are intentional async generators without yield for unsupported features, cleanup-error aggregation that must throw from a stream finalizer, a control-character sanitizer, literals that show precision loss, and assertions that exist only at compile time.
  - Never demote a rule globally. Never use a warning budget.
  - Runtime package imports must be declared in production, peer or optional dependencies. Type-only imports can use devDependencies.
  - Oxfmt checks are separate from formatting changes. Do not mass-format unrelated legacy files.
- Write documentation in the style that `docs/writing-style.md` defines: Simplified Technical English at about 80% strictness. This applies to all Markdown: READMEs, `docs/`, website pages in both languages, package READMEs, examples and skills.
- Documentation must state facts that the current code proves. Before you write or change a page, check each claim against the source:
  - file paths and links exist, and point to the file that actually contains the code;
  - symbols, options, CLI commands and flags, error codes and capability IDs exist with the exact spelling;
  - interface and type snippets match the current definitions in `packages/core/src/`;
  - versions, support labels and capability statuses match `support/targets/` and the package manifests;
  - tables that list adapters cover every first-party adapter.
- When a change moves, renames or removes code, update the documentation that describes it in the same change. Search all Markdown, including the Korean pages, for the old name or path.
- After `pnpm run build`, run `pnpm run docs:snippets`. It type-checks each TypeScript and JavaScript code block in the Markdown against the built packages. If a block is a signature sketch and not code, put `<!-- doc-snippet: skip -->` on the line before the fence. Give free variables in examples a real type in `tests/doc-snippets/globals.d.ts`; do not use `any` to hide an error.
- When an example claims runtime behavior of a database (a value representation, an error code, a capability), verify it on the real database. The Testcontainers DB suites (`pnpm run test:db:*`) and a direct run of the example are both acceptable evidence. Report infrastructure that is unavailable as not run.
- Make sure that Mermaid diagrams parse. Quote node labels that contain `@`, `/` or other special characters. Use a top-to-bottom layout for chains of more than four nodes.

---

## 15. Public positioning

SQLBraid has its own product story:

> **Write SQL. Keep TypeScript.**

Do not describe the repository as a clone or a parity implementation of another TypeScript database product.

---

## 16. Final decision rule

When complexity grows, use this order of preference:

1. an explicit declaration;
2. Standard Schema result mapping;
3. a thin driver or runtime boundary;
4. optional metadata or codegen;
5. narrow lexical or static checks;
6. only then, additional semantic machinery.

Complexity must earn its place in the product.
