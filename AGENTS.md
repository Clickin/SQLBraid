# AGENTS.md

This file defines repository-wide rules for AI coding agents and human contributors making architectural changes to SQLBraid.

`PLAN.md` is authoritative. If implementation details or old planning artifacts conflict with `PLAN.md`, follow `PLAN.md` unless the user explicitly instructs otherwise.

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

The project is not an ORM, not query-builder-first, not a validator framework and not a parity implementation of another database library.

---

## 2. Architecture priority

Prefer, in order:

1. SQL-first authoring;
2. safe bound parameters;
3. readable/local dynamic SQL;
4. explicit application contracts;
5. Standard Schema for one-row result mapping;
6. thin dialect/driver boundaries;
7. explicit physical-connection ownership;
8. observable execution rather than hidden middleware magic;
9. offline ordinary development;
10. optional metadata/codegen outside runtime/compiler;
11. deletion/simplification over partial SQL semantics.

---

## 3. Do not rebuild database semantics

PV3 removed the broad SQL AST/resolver. Keep it removed.

Do not add complete SQL grammars, function catalogs, operator/coercion systems or arbitrary SQL-to-TypeScript inference.

When a requirement can be solved by explicit contracts, Standard Schema, driver metadata, codegen or a narrow lexical check, use that smaller mechanism.

---

## 4. Result contracts and mapping

### 4.1 Explicit contract

```ts
sql.rows<UserRow>`SELECT ...`;
```

The developer owns SQL/result correspondence unless runtime validation/mapping is attached.

### 4.2 Query-bound result mapping

```ts
sql.rows(UserSchema)`SELECT ...`;
```

uses the official Standard Schema protocol. The schema output type is the row type.

Pipeline:

```text
driver row
 -> dialect TypePolicy normalization
 -> query-bound Standard Schema
 -> optional execution-level schema
 -> application row
```

Use `@standard-schema/spec`. Do not maintain a private protocol clone and do not make Valibot, Zod, ArkType or another implementation a runtime dependency.

### 4.3 One row to one value

Result mapping may validate, transform, parse JSON/text and create temporal/domain values. It must not introduce ORM graph assembly, identity maps, relation hydration or entity lifecycle.

### 4.4 Input mapping is deferred

Before pre-release, do not implement an application input-codec framework unless the user explicitly changes the roadmap.

Ordinary `${value}` remains a driver-bound value.

---

## 5. Dynamic SQL/compiler rules

Supported directive namespace: `/*@braid ...*/`.

Supported v1 directives: `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`.

Guarded lowering must preserve:

- lexical `this`;
- evaluation order;
- once-only evaluation;
- inactive-branch laziness;
- TypeScript narrowing;
- source maps/directive prologues;
- query-bound mapper identity/output typing.

Do not add exponential variant proof.

---

## 6. Bind and structural SQL

Ordinary interpolation is always bound.

Structural SQL requires explicit APIs:

```ts
sql.ident(...)
sql.fragment`...`
sql.list(...)
sql.join(...)
sql.raw(...)
```

`sql.raw()` is trusted/unsafe. Security regressions here are release blockers.

### 6.1 Logical statement and binding boundary

Template/core rendering produces an immutable `RenderedStatement`:

```ts
interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly resultKind: QueryResultKind;
  readonly dialectId: string;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}
```

`segments.length === parameters.length + 1`. Each `RenderedParameter` is one
value plus optional interpolation and `ParameterTypeHint`. Structural helpers
are merged into segments. Keep this value-only boundary intact: a parameter is
never raw SQL, an identifier, nested query, driver fragment or tagged-template
command. `RenderedStatement` is the execution source of truth; do not retain
parallel mutable text/values/hints/maps.

Dialects describe SQL lexical/quoting/type behavior. They do not generate
placeholders. Driver packages implement `StatementBindingAdapter.describe()`
and own `text-positional`, `text-named`, `typed-request` or
`native-value-template` materialization. Use `parameterizedSql(statement,
placeholder)` only as a derived view. Read
[`docs/driver-author-guide.md`](docs/driver-author-guide.md) before adding a
custom executor, provider or binding adapter.

Binding description is pure and pre-acquire. `QueryExecutor` and
`ConnectionProvider` expose the same `statementBinding` object; leases must
preserve that identity. Prepared shape is logical (`resultKind`, canonical
segments and ordered hint signature), and each prepared invocation renders
once before binding and execution. Driver/server reuse remains adapter-owned.

`db.bulk()` accepts homogeneous command factories only. Preflight every input
before acquisition; shape mismatch fails rather than grouping or rewriting.
Root bulk has no portable atomicity promise; `tx.bulk()` uses the pinned lease.
Keep one logical statement plus a value matrix and one bulk observer lifecycle.

---

## 7. Result-kind invariants

Canonical tags:

```ts
sql.rows<Row>`...`
sql.command`...`
sql.call<RoutineCallResult<Output, Sets, ReturnValue>>`...`
sql`...` // unknown
```

Adapters report actual row/command kind. Runtime enforces the declaration centrally.

Kind mismatch is post-execution. Never claim it prevents side effects.

Routine result generics describe the whole result, never one shared row type.
`output`, heterogeneous `resultSets` and actual `returnValue` channels have
separate Standard Schema contracts. Collect/close all materialized driver
resources, release root leases, then map application values. OUT cursor sets
come first in descriptor order, followed by implicit/emitted sets in driver
order. Scalar output never occupies a result set.

`sql.out()`/`sql.inOut()` are value-only logical parameters. `sql.out()` also
supports materialized Oracle `sql.rows` RETURNING INTO; INOUT remains call-only.
Oracle positional OUT ordinals are independent of intervening IN parameters.
PostgreSQL refcursors
require an existing `db.tx()`. MySQL emitted sets are supported, but mysql2's
insufficient OUT carrier evidence means descriptors fail explicitly; never guess
the final set or rewrite through session variables. Tedious native procedure
metadata exposes actual OUTPUT/RETURN, not a fabricated wrapper status. SQLite
calls and direct SQL Server cursor OUT remain Unsupported. `callStream()` is
reserved, not an implemented API.

---

## 8. Physical connection and transaction invariants

### 8.1 QueryExecutor means one physical execution resource

A direct `QueryExecutor` must not secretly multiplex unrelated physical connections across `begin/query/commit`.

### 8.2 Pools use a provider/lease boundary

PV6 provides `ConnectionProvider` / `ConnectionLease` and explicit `createPooledDatabase`, PostgreSQL pool and MySQL pool factories. The stable semantic model is:

```text
root operation
 -> acquire one physical lease
 -> driver DB I/O
 -> release lease
 -> application post-processing
```

Do not adapt a pool by exposing pool-level `begin/query/commit` as a `QueryExecutor` if those calls can use different physical connections.

### 8.3 Transaction closure pins one connection

The canonical transaction boundary is the `db.tx(...)` closure; `transaction(...)` has been removed:

```ts
await db.tx(async (tx) => {
  await tx.execute(...);
  await tx.execute(...);
});
```

Requirements:

- acquire one lease;
- begin on that lease;
- every `tx.*` call uses that lease;
- commit/rollback on the same lease;
- release only after transaction completion;
- nested transactions use savepoints on the same lease;
- outer/root `db` calls from the same transaction async context must fail rather than silently escape onto another connection.

Outside `db.tx`, each root operation may use any connection supplied by the provider.

### 8.4 Result mapping and lease lifetime

For materialized results, release the root lease after DB I/O/result materialization and before asynchronous Standard Schema mapping/validation.

Do not hold scarce pool connections while application mapping runs.

Streaming is different: a live stream/cursor retains its lease until iteration closes.

`QueryExecutor.stream()` and `call()` are explicit methods; unsupported custom
capabilities reject, never buffer or simulate. Every stream returns/closes its
driver iterator before releasing the lease. Native paths are pg-cursor, mysql2
prepared Execute stream, SQLite iterate, Oracle ResultSet and bounded Tedious
row events. MySQL break drains for reuse; abort destroys/discards. Cleanup
failure poisons/discards the physical resource. No SQLBraid full-result array is
permitted on `db.stream()`.

SQLite `integerMode` is explicit (`number` default, `bigint` for exact int64).
Use the matching `typePolicyForIntegerMode()` for generated models; do not
silently coerce bigint through number or claim JSON serializability.

---

## 9. Execution observer/interceptor rules

PV6 provides an execution observer/interceptor seam for SQL logging, bind logging/redaction, audit and metrics.

Prefer a single discriminated event API such as:

```ts
interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}
```

Required coverage includes:

- derived parameterized SQL, lazy diagnostic `literalizedSql(options?)`, binds and
  effective adapter/dialect/transport/reuse plan;
- before physical execution;
- after driver result;
- result mapping completion;
- query/call/batch/prepared lifecycle;
- stream start/end/error;
- transaction begin/commit/rollback;
- savepoint lifecycle;
- durations/result kind/row count/error stage.

### 9.1 Pre-release observers are observe/fail only

Observer contracts are readonly.

Do not allow the observer API to rewrite:

- SQL;
- bind values;
- result objects;
- transaction target;
- retry/routing decisions.

Observers may throw. A pre-execution failure prevents DB execution. A post-execution failure propagates but cannot undo a root side effect; inside a transaction it participates in rollback.

If an observer fails while reporting an existing failure, preserve the original error as well.

### 9.2 Sensitive bind values

Observers may see original bind values because audit systems sometimes require them. SQLBraid must never log them by default.

Examples/docs should redact by default. Application policy controls storage and retention.

`literalizedSql()` reconstructs from logical segments and parameters, never by
searching or replacing placeholders. It is diagnostic-only and must never be
used as execution input. Redaction is the default; max value length, binary
summary/full mode and a custom redactor are supported. Unsupported objects use
a safe descriptive marker rather than accidental `toString()` execution.

### 9.3 No built-in logger backend

Do not add mandatory pino/winston/OTEL dependencies. Those integrate through the observer SPI. OpenTelemetry remains post-release unless explicitly reprioritized.

---

## 10. Dialect / driver / runtime separation

A dialect is about SQL/database behavior, not the JavaScript driver or runtime.

```text
dialect: PostgreSQL / MySQL / SQLite / Oracle / SQL Server
driver:  pg / mysql2 / node:sqlite / node-oracledb / Tedious / future alternatives
runtime: Node / Bun / Deno
```

Do not duplicate PostgreSQL dialect logic merely because `pg`, postgres.js or Bun.SQL differ.

Runtime support labels:

- Official — SQLBraid CI covers runtime + driver;
- Compatible — no exact certified target, even if broader host or local-binding checks pass;
- Custom — user integration through executor/provider SPI.
- Unsupported — a required capability is absent or SQLBraid's checks fail.

PV7's pinned CI gates establish Official support on Node 22.18.0, Bun 1.3.14
and Deno 2.9.3 for core/template/runtime and pg/mysql2. Node/Deno node:sqlite
passes; Bun 1.3.14 lacks that module. Node 24.21.0 remains Compatible with
full-suite/finance CI evidence but no separate certified target. README links
the same-revision CI evidence.
Keep Bun/Deno support scoped to exact tested versions, not inferred floors.
Preserve the runtime source/packed audit. Template byte counting is browser-safe;
runtime uses conditional internal async-context backends, not a browser ALS
polyfill. Direct pg/mysql2 factories accept physical clients only.

Tooling can remain Node-first while runtime libraries become portable.

---

## 11. Oracle, SQL Server and explicit parameter types

PV13 brings Oracle/node-oracledb Thin and SQL Server/Tedious into the RC scope.
Driver subpaths remain separate from portable dialect roots. Official support
requires same-revision real-database CI evidence, not unit mocks or host inference.

`sql.bind(value, hint)` describes an explicitly selected database parameter type;
it is not an input codec or Standard Schema validation. JavaScript/TypeScript
types are never universal DB-type evidence. Hints must be honored or explicitly
rejected before execution; ordinary binds retain driver behavior. Include hint
structure, never values, in executable fingerprints and prepared shape guards.

Oracle NUMBER/LOB/temporal and SQL Server precision/scale semantics require
driver-specific handling. Unsupported call/OUT or streaming capabilities must
remain explicit rather than simulated.

PV16 certifications in `support/targets/` name the tested revision and CI run.
Require fresh Runtime, Docs and Release dry-run evidence for a changed revision;
implementation progress alone does not establish new support labels.
RC publication remains deferred until user acceptance and explicit release
authorization.

---

## 12. Metadata/codegen

Database metadata is optional tooling.

PV8 provides `@sqlbraid/metadata`: database facts in `MetadataSnapshot`
(`format: "sqlbraid-metadata"`, `formatVersion: 1`), deterministic identity/drift
and `MetadataInspector`. Old discriminator-less snapshots are rejected.

Dialect inspectors belong only at `/inspector` subpaths. Their metadata import
is type-only with an optional peer; runtime roots must install/run without
metadata. Preserve the packed runtime-only and metadata-tooling consumer gates.

Identity means proven identity/autoincrement generation, not primary-key
membership. Generated/write flags require database evidence; absence is unknown.
Metadata contains DB types, not TypeScript guesses or TypePolicy/compiler fields.

Standard Schema owns application row validation/transformation. TypePolicy owns
runtime primitive representation. PV9 `@sqlbraid/codegen` provides pure, offline
`generateModels(metadata, { typePolicy })` for table-oriented `Row`/`Insert`/`Update`
declarations. TypePolicy is selected input, never embedded in metadata snapshots.
Row uses output representation; Insert/Update use input representation and explicit
DB null/default/identity/generated/write evidence. Identity alone makes Insert
optional but does not exclude Update. Only tables receive write models.

Unknown types and SQLite non-STRICT columns remain `unknown` with diagnostics,
never an `any` fallback. Keep exact DB column keys, deterministic collision-safe
model names and metadata/TypePolicy provenance. The generator performs no
filesystem writes, config lookup, live inspection or arbitrary SELECT inference.
PV10 owns CLI/config/filters/naming/type overrides. Filters are exact metadata
selectors; override precedence is column > database type > TypePolicy, with
input/output resolved independently. Column names remain exact DB keys. Unknown
evidence remains unknown, never `any`. Runtime/compiler must not acquire
metadata/codegen dependencies; retain packed runtime-only exclusion gates.
CLI config/filesystem behavior never moves into codegen core. Unchanged outputs
are not rewritten, and multi-target validation completes before writes. Config
files are executable Node code and are not sandboxed. Runtime packages never
depend on CLI, codegen or metadata.

### 12.1 Agent-native tooling

PV11 `@sqlbraid/tooling` owns config/workspace and semantic evidence for standard
LSP and CLI `inspect ... --json`. Preserve `@sqlbraid/cli/config` as the intentional
reexport of the shared config contract. Tooling depends on core/compiler/metadata/
codegen, never runtime, drivers, CLI, LSP or VS Code. Codegen needs only TypePolicy
id/hash/mappings, not runtime encode/decode.

Metadata is open-world positive evidence. A miss is unresolved, not invalid SQL:
built-ins, extensions, UDFs, temp/session objects and CTEs remain legal opaque SQL.
`RoutineSnapshot.argumentsComplete === true` alone permits exact signatures;
first-party pg/mysql inspectors currently say false. Preserve optional boolean
validation and canonical/hash/drift evidence without a metadata version bump.

Use compiler diagnostic provenance: publish Braid plus overlay-only TS diagnostics,
not native TS duplicates. Completion owns static SQL only, never normal TS or
`${...}`. Navigation uses positive lexical identity and current real-file ranges;
omit ambiguous references and stale generated offsets. Keep caches per-workspace,
bounded and invalidated; discard cancellation/stale-version results without
claiming synchronous TypeScript preemption.

Standard LSP is primary; the portable skill is `skills/sqlbraid/SKILL.md`.
VS Code stays a thin matching-version client, with native TypeScript authoritative.
Keep actual stdio, packed agent-consumer and editor-host gates in `test:all`.
Runtime-only packed installs must exclude metadata/codegen/tooling/CLI/LSP/editor.

Preserve PLAN §8.4's independent dialect, driver, transaction-profile and execution
runtime concerns. Node/Bun/Deno host compatibility is separate deployment evidence.
PV11 implements no transaction-isolation/profile runtime API; omitted future
isolation options must preserve the actual DB/session default.

---

## 13. Testing requirements

PV15 adds `@sqlbraid/vite` as the seventeenth publishable package. It is tooling,
not a runtime dependency: compiler `transformSource` lowers guarded templates
without transpiling TS/JSX; Vite owns transpilation. Keep original TS/TSX maps,
dev/build/HMR/SSR evidence and the packed TanStack Start finance gate.
TanStack Start database drivers and execution stay server-only. Browser SQLite
uses the separate WASM adapter, not Node-driver shims. PV16 adds MariaDB as the
eighteenth publishable package and the SQLite WASM/D1 subpaths.

Use Vitest for fast tests, Testcontainers for PostgreSQL/MySQL and native `node:sqlite` for SQLite.

Retain packed-consumer validation (`publint`, Are The Types Wrong, ESM/type resolution, executables, engine metadata, no monorepo path leakage).

Retain the PV6 regression gates for:

- mapper re-entry without root-lock deadlock;
- lease acquired/released exactly once per root materialized operation;
- one lease for an entire transaction closure;
- nested savepoints on the same lease;
- root-db escape rejection inside transaction context;
- stream lease lifetime;
- observer registration order;
- pre-execution observer failure prevents DB call;
- post-execution observer failure semantics;
- preservation of original errors;
- SQL/bind visibility and no built-in logging;
- transaction lifecycle events.

PV7 must use actual Bun/Deno smoke/CI before marking combinations official.
Run `pnpm run test:runtime` for packed runtime/driver changes (Docker, Bun and
Deno required, or dedicated test DB URLs). Observer taxonomy uses `cardinality`
separately from `result-kind`; public elapsed fields are `durationMs`.

PV14 regressions must cover the `segments`/`parameters` invariant, one-render
prepared execution, transport-neutral shape identity, all five adapter
materializers, pre-acquire `materialize` failures, provider/lease binding
identity, immutable observer execution plans, direct segment-based
`literalizedSql()` reconstruction with redaction/truncation, large SQL, and the
native-template value-only security fixture. These are verification requirements,
not evidence of a passing SHA until the exact final revision is checked.

Before substantial changes are complete, run applicable gates:

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

Report unavailable DB/runtime infrastructure as not run, never passed.

---

## 14. Repository discipline

- current package floor is Node `>=22.18.0` until PV7 intentionally changes support metadata;
- ESM is default;
- package exports stay narrow;
- do not bundle TypeScript or DB drivers accidentally;
- preserve CLI/LSP shebangs and packed executable tests;
- use tsdown for builds and `tsc --noEmit` for semantic checking;
- inspect current HEAD before broad changes;
- keep the root private test package's workspace dependencies explicit: Vite aliases do not cover native generated ESM or internal TypeScript Programs;
- remove obsolete paths rather than keeping parallel implementations;
- do not publish/tag/release/force-push unless explicitly requested;
- never mutate non-test databases.

---

## 15. Public positioning

SQLBraid stands on its own product story:

> **Write SQL. Keep TypeScript.**

Do not frame the repository as a clone/parity implementation of another TypeScript database product.

---

## 16. Final decision rule

When complexity grows, prefer:

1. explicit contract;
2. Standard Schema result mapping;
3. thin driver/runtime boundary;
4. optional metadata/codegen;
5. narrow lexical/static checks;
6. only then additional semantic machinery.

Complexity must earn its place in the product.
