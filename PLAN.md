# SQLBraid — Full v1 Implementation Plan

> Status: implementation plan
>
> Project: **SQLBraid**
>
> npm scope: **`@sqlbraid/*`**
>
> CLI: **`sqlbraid`**
>
> SQL template directive namespace: **`/*@braid ...*/`**
>
> Reference baseline: `external SQL reference` public behavior and documentation as of 2026-09-10.
>
> This project is an **independent implementation**. `SQLBraid external reference` is a behavioral and architectural reference, not a source-code dependency, fork, port, or code donor.

---

## 0. Mission

Build **SQLBraid**, a TypeScript SQL compiler/runtime that combines:

1. **SQL-first authoring**: application developers write SQL as SQL, not as a fluent query-builder AST.
2. **MyBatis-style dynamic SQL**: conditional SQL is written inline in the SQL flow using a tiny preprocessing directive language embedded in reserved SQL block comments.
3. **SQLBraid external reference-grade static analysis**: infer result rows and bound parameter requirements from a real database schema snapshot, SQL grammar, join nullability, routine signatures, database types, and dialect rules.
4. **Plain TypeScript results**: `SELECT` results must be statically typed ordinary TS objects/arrays; no ORM entity, generated query wrapper, or driver-specific row object leaks into application code.
5. **Offline normal development**: ordinary type-checking/editor analysis must use a deterministic schema snapshot and must not require a live database connection.
6. **Fail-closed behavior**: unsupported, ambiguous, stale, dynamically unknowable, or unproven semantics must become a diagnostic or `unknown`, never an optimistic fabricated type.
7. **Independent dialect architecture**: PostgreSQL, MySQL, and SQLite are first-party dialects; adding another dialect later must not require modifying the compiler core.
8. **Runtime/static parity**: inferred TS types and actual runtime decoding must be derived from the same type policy.

The central product idea is:

```text
TypeScript source
      │
      ▼
sql` ... SQL + @braid directives ... `
      │
      ├────────────── compile/editor path ──────────────┐
      │                                                │
      ▼                                                ▼
Template IR                                      Schema Snapshot
      │                                          + Type Policy
      ▼                                                │
SQL semantic analysis ◄────────────────────────────────┘
      │
      ├─ row inference
      ├─ bind expectation inference
      ├─ routine resolution
      ├─ dependency/semantics evidence
      └─ diagnostics
      │
      ▼
Virtual TypeScript semantic overlay
      │
      ▼
Query<Row> / plain typed TS objects

At runtime:

Template IR + captured JS values
      │
      ▼
Dynamic renderer
      │
      ├─ final ordinary SQL text
      └─ ordered driver bind values
      │
      ▼
Database adapter
```

The database must **never receive `@braid` directives**.

---

## 1. Non-negotiable design rules

### 1.1 SQL stays SQL

Do not replace SQL clauses with APIs such as:

```ts
query.select(...)
  .from(...)
  .where(...)
```

The primary authoring surface is always:

```ts
const query = sql`
  SELECT ...
  FROM ...
  WHERE ...
`;
```

The developer should be able to read the statement top-to-bottom as SQL.

### 1.2 Dynamic composition stays inside SQL flow

Prefer:

```ts
const query = sql`
  SELECT u.id, u.name
  FROM users u
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND u.name = ${name}
    /*@braid end*/
  /*@braid end*/
  ORDER BY u.id
`;
```

over JS-side predicate assembly.

Reusable fragments remain available, but must not become the normal mechanism for ordinary optional predicates.

### 1.3 Ordinary interpolation is always a bound value

```ts
sql`WHERE id = ${id}`
```

must render a driver placeholder and bind `id`.

It must never concatenate the value into SQL text.

Structural interpolation requires an explicit API:

```ts
sql.ident(name)
sql.fragment`...`
sql.raw(...)
sql.empty
sql.join(...)
sql.list(...)
```

`sql.raw()` is an explicitly unsafe/trusted escape hatch and must be visibly named and documented as such.

### 1.4 The DB metadata is authoritative when it can prove a type

Do not require developers to duplicate table columns, routine argument types, result nullability, enums, domains, etc. in handwritten TS interfaces.

If metadata can prove the type, infer it.

### 1.5 A generic type is a contract, not an override

If public syntax supports:

```ts
sql<UserRow>`SELECT ...`
```

`UserRow` means:

> verify that the inferred SQL result is compatible with this contract.

It must **not** mean:

> trust `UserRow` regardless of the SQL.

A mismatch is a compile diagnostic.

If a developer genuinely wants to bypass proof, require an explicit API such as:

```ts
sql.unsafeType<UserRow>`...`
```

or equivalent. Keep this separate from normal `sql<T>`.

### 1.6 Do not lie about opaque routine result sets

Routine input/output metadata should be inferred automatically when the catalog exposes it.

A cursor/dynamic result set whose row shape does not exist in catalog metadata must remain `unknown` unless the developer provides an explicit result contract or validator.

Do not attempt to become a PL/pgSQL/MySQL stored-program whole-program analyzer merely to guess a cursor shape.

### 1.7 Runtime decoding and static inference share one TypePolicy

A DB type may not be inferred as a JS type that the runtime adapter does not actually return.

Static type policy and runtime codec/decoder registration must use the same logical mapping identity and hash.

### 1.8 No hidden live DB dependency in normal builds/editors

The normal workflow is:

```text
DB
 │
 └─ inspect/generate snapshot (explicit)
           │
           ▼
   schema.snapshot.json
           │
    ┌──────┴──────┐
    ▼             ▼
  editor         CI/build
```

Live DB operations are explicit commands only.

---

## 2. Reference baseline and clean-room rule

Use the public `SQLBraid external reference` repository documentation, public API behavior, database behavior, and independently written test cases as a capability reference.

Reference repository:

- https://github.com/external SQL reference

Important public reference areas:

- root README
- `docs/concepts/type-safety.md`
- `docs/concepts/architecture.md`
- `docs/guides/composition.md`
- `docs/guides/execution.md`
- `docs/guides/result-validation.md`
- `docs/guides/query-manifests.md`
- `docs/guides/live-verification.md`
- `docs/guides/query-plan-governance.md`
- `docs/guides/migration-compatibility.md`
- `docs/guides/routing-and-retries.md`
- `docs/guides/bulk-data.md`
- `docs/guides/observability.md`
- `docs/guides/editors.md`
- `docs/extending/custom-grammars.md`
- PostgreSQL/MySQL/SQLite dialect references

Rules for the agent:

- Do **not** copy implementation source from `SQLBraid external reference`.
- Do **not** import any `@SQLBraid external reference/*` package in production packages.
- Do **not** port internal types mechanically.
- Re-derive the implementation from SQL/database behavior and the public capability contract.
- An optional development-only black-box comparison harness may invoke an installed/reference `SQLBraid external reference` CLI in isolated fixtures, but production and unit-test correctness must not depend on it.
- Every parity test committed to this project must state the SQL/database behavior it verifies rather than merely asserting “same as SQLBraid external reference”.

---

## 3. Workspace/package architecture

Branding is fixed for this project:

- project/product name: **SQLBraid**
- npm organization/scope: **`@sqlbraid`**
- CLI executable: **`sqlbraid`**
- dynamic SQL directive namespace: **`@braid`**
- primary tag exported by dialect packages: **`sql`**

Do not introduce alternative public names such as `tsql`, `SQLBraid external reference`, `sql-braid`, or `braidsql`.
Internal implementation identifiers may use `SqlBraid*` where a branded name is genuinely useful, but ordinary domain types should keep precise names such as `Query`, `TemplateIr`, `Dialect`, and `SchemaSnapshot`.

Recommended workspace boundaries:

```text
packages/
  core/                # @sqlbraid/core
  template/            # @sqlbraid/template
  ast/                 # @sqlbraid/ast
  schema/              # @sqlbraid/schema
  compiler/            # @sqlbraid/compiler
  config/              # @sqlbraid/config
  conformance/         # @sqlbraid/conformance
  language-server/     # @sqlbraid/language-server
  postgres/            # @sqlbraid/postgres (+ /pg subpath)
  mysql/               # @sqlbraid/mysql (+ /mysql2 subpath)
  sqlite/              # @sqlbraid/sqlite (+ /node-sqlite subpath)
  opentelemetry/       # @sqlbraid/opentelemetry
  cli/                 # @sqlbraid/cli, exposes `sqlbraid`

editors/
  vscode/
  zed/

test/
  conformance/
  fixtures/
  differential/
  integration/
```

Public package names are part of the v1 contract. Prefer dialect-owned adapter subpath exports over additional top-level npm packages:

```text
@sqlbraid/postgres
@sqlbraid/postgres/pg

@sqlbraid/mysql
@sqlbraid/mysql/mysql2

@sqlbraid/sqlite
@sqlbraid/sqlite/node-sqlite
```

The root `sqlbraid` unscoped npm name, if available and intentionally reserved, must not become a second competing API surface. The canonical libraries live under `@sqlbraid/*`; the executable remains `sqlbraid`.

Responsibilities:

### `core` — `@sqlbraid/core`

Stable public contracts only:

- `Query<Row, ...>`
- `SqlFragment`
- SQL tag runtime contract
- rendered query contract
- database execution interfaces
- transaction interfaces
- diagnostics
- query semantics
- observer contract
- result validation contract
- capability tokens
- cancellation/deadline contracts
- prepared query contracts

No SQL dialect grammar.

### `template` — `@sqlbraid/template`

The MyBatis-like template frontend:

- scans tagged template static strings and interpolation positions
- recognizes `@braid` directive comments
- builds Template IR
- renders Template IR at runtime
- preserves exact source ranges
- contains no database-specific SQL semantics

### `ast` — `@sqlbraid/ast`

Shared bounded lexer/parser infrastructure:

- source cursor
- tokens
- source ranges
- Pratt expression framework
- AST visitor/toolkit
- parser resource limits
- error recovery sufficient for editor diagnostics

Do not put database catalog semantics here.

### `schema` — `@sqlbraid/schema`

Versioned deterministic schema snapshot model:

- namespaces
- database types
- relations
- columns
- constraints
- indexes
- routines
- server/capability evidence
- dialect extension evidence
- canonical serialization
- snapshot hash/identity
- schema drift primitives
- snapshot migration between format versions

### `compiler` — `@sqlbraid/compiler`

Dialect-neutral TypeScript/template compiler:

- discover SQL tag usage from TS AST/import identity
- parse Template IR
- expand/fold structural variants when required
- request SQL analysis from selected dialect
- infer row and binding contracts
- build source-mapped diagnostics
- build virtual TS semantic overlay
- query fingerprints
- query manifests
- live verification comparison
- plan evidence comparison
- migration compatibility analysis

### `config` — `@sqlbraid/config`

Project configuration loading:

- selected dialect
- snapshot path/provider
- type policy module
- compiler limits
- source include/exclude
- runtime compatibility policy
- extension/custom routine declarations

### `conformance` — `@sqlbraid/conformance`

Public executable contract for first-party and third-party dialects.

A dialect is not considered supported unless it passes this suite.

### dialect packages

First-party public packages are:

```text
@sqlbraid/postgres
@sqlbraid/mysql
@sqlbraid/sqlite
```


`postgres`, `mysql`, `sqlite` own:

- lexical profile
- grammar
- SQL AST extensions
- name resolution
- operator/function/routine catalogs
- coercion rules
- nullability
- parameter expectation inference
- result type inference
- server version/capability gates
- introspection provider
- type policy
- runtime codecs
- semantic classification
- retry classification
- plan normalization
- live verification translation

### driver adapter subpaths

Driver adapters are exported from dialect-owned subpaths and load application-owned drivers lazily. They must not force driver dependencies into the root dialect package.

First-party adapter entrypoints:

- PostgreSQL: `@sqlbraid/postgres/pg` → application-owned `pg`
- MySQL: `@sqlbraid/mysql/mysql2` → application-owned `mysql2`
- SQLite: `@sqlbraid/sqlite/node-sqlite` → built-in `node:sqlite`

Optional PostgreSQL packages such as cursor/COPY support must remain lazy/opt-in.

---

## 4. Public authoring syntax

### 4.1 Static query

```ts
const q = sql`
  SELECT u.id, u.name
  FROM users u
  WHERE u.id = ${id}
`;
```

Expected editor type:

```ts
Query<{
  id: bigint;
  name: string;
}>
```

and:

```ts
const rows = await db.all(q);
// readonly { id: bigint; name: string }[]
```

### 4.2 Directive namespace and collision rule

SQLBraid directives use the short project-owned namespace `@braid`. A directive is recognized **only** when a block comment starts with the exact byte sequence:

```text
/*@braid
```

after the opening `/*`.

Therefore these are ordinary SQL comments and must be preserved:

```sql
/* ordinary comment */
/* @braid not-a-directive */
/*+ INDEX(users idx_users_name) */
/*! MySQL version comment */
-- @braid not-a-directive
```

Only these are reserved:

```sql
/*@braid ...*/
```

Do not recognize line comments as directives.

Do not heuristically reinterpret similar comments.

All valid `@braid` comments are compile/render-time control tokens and are removed before final SQL reaches the driver.

### 4.3 `if`

```ts
sql`
  SELECT ...
  FROM users u
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND u.name = ${name}
    /*@braid end*/
  /*@braid end*/
`;
```

The condition position must contain exactly one TypeScript interpolation expression.

Malformed directive bodies are diagnostics.

### 4.4 `choose`

```ts
sql`
  SELECT ...
  FROM users u
  /*@braid where*/
    /*@braid choose*/
      /*@braid when ${id != null}*/
        AND u.id = ${id}
      /*@braid when ${email != null}*/
        AND u.email = ${email}
      /*@braid otherwise*/
        AND u.active = TRUE
    /*@braid end*/
  /*@braid end*/
`;
```

Rules:

- first true `when` wins
- at most one `otherwise`
- `when` only inside `choose`
- `otherwise` only inside `choose`
- empty choose is allowed only if it renders no invalid SQL

### 4.5 `where`

```ts
/*@braid where*/
  ...
/*@braid end*/
```

After child rendering:

- if empty/whitespace-only, emit nothing
- otherwise emit `WHERE `
- remove exactly one leading top-level `AND` or `OR`, case-insensitively
- comments/hints are not accidentally deleted
- do not alter tokens inside strings, quoted identifiers, nested expressions, or nested comments

### 4.6 `set`

```ts
UPDATE users
/*@braid set*/
  /*@braid if ${patch.name !== undefined}*/
    name = ${patch.name},
  /*@braid end*/
  /*@braid if ${patch.email !== undefined}*/
    email = ${patch.email},
  /*@braid end*/
/*@braid end*/
WHERE id = ${id}
```

After child rendering:

- if nothing remains, emit a diagnostic/runtime construction error rather than invalid `UPDATE ... WHERE`
- emit `SET `
- remove the final top-level comma
- preserve commas inside expressions/function calls/subqueries

### 4.7 Generic `trim`

Support a generic trim primitive so `where` and `set` are not special one-off engines.

Syntax:

```sql
/*@braid trim prefix="WHERE " prefixOverrides="AND|OR" suffix="" suffixOverrides=""*/
...
/*@braid end*/
```

and equivalent for SET.

Implement a small, explicit attribute grammar. Do not evaluate arbitrary JS in attributes.

### 4.8 Reusable structural helpers

Provide:

```ts
sql.fragment`...`
sql.empty
sql.ident(name)
sql.raw(trustedText)
sql.join(...)
sql.list(values)
```

Recommended semantics:

- `fragment`: trusted nested static SQL structure; nested ordinary interpolations remain binds
- `empty`: zero structure
- `ident`: dialect-quoted identifier, not raw text
- `raw`: trusted verbatim SQL, no escaping claim
- `join`: combine structural fragments with an explicit separator
- `list`: bind a collection as multiple placeholders with explicit empty-list behavior

Do not provide implicit array-to-SQL-structure conversion.

### 4.9 No separate OGNL/bind language

Conditions are normal TypeScript expressions.

Do not implement MyBatis OGNL.

Do not implement a second expression language in comment text.

### 4.10 No directive-level `foreach` in initial implementation

Use TypeScript lexical scope plus structural helpers:

```ts
sql`
  INSERT INTO users (id, name)
  VALUES ${sql.join(
    users.map((u) => sql.fragment`(${u.id}, ${u.name})`),
    sql.fragment`, `
  )}
`;
```

Optionally add a typed `sql.rows()` convenience after the core model is sound.

Do not invent loop-variable declarations inside SQL comments.

---

## 5. Template IR

The runtime/compiler must share one versioned Template IR.

Minimum nodes:

```ts
type TemplateNode =
  | TextNode
  | BindNode
  | FragmentNode
  | IdentifierNode
  | RawNode
  | ListNode
  | IfNode
  | ChooseNode
  | TrimNode;
```

Required properties:

- stable node kind
- original source range
- template interpolation index where applicable
- child nodes
- no captured secret values in serializable compiler artifacts
- deterministic traversal order

`WhereNode` and `SetNode` may exist as ergonomic AST nodes but should lower to generic `TrimNode` semantics.

The IR must be usable in:

1. runtime rendering
2. compile-time structural analysis
3. editor diagnostics
4. query fingerprint/variant calculation

---

## 6. Runtime renderer

The SQL tag must create a compact immutable runtime representation.

It may cache parsing by `TemplateStringsArray` identity using a `WeakMap`.

Do not reparse directive syntax on every execution if the same template literal site is reused.

Rendering output:

```ts
interface RenderedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}
```

Requirements:

- directives are fully removed
- disabled branches contribute neither SQL nor values
- driver placeholders are allocated only for active ordinary binds
- nested fragments preserve source order
- identifiers are quoted by dialect renderer
- no value string concatenation
- empty/malformed structural constructs fail deterministically
- enforce maximum rendered SQL bytes
- enforce maximum bind count
- enforce maximum repeated-fragment/list cardinality

Add golden renderer tests before SQL semantic analysis work begins.

---

## 7. Structural analysis strategy

Correctness first, then eliminate exponential behavior for the common MyBatis case.

### Stage A: bounded complete-statement variants

Initially, for structures whose semantic effect cannot yet be analyzed locally:

- identify independent runtime conditions
- correlate repeated identical condition expressions where safe
- fold literal `true` / `false`
- render bounded complete SQL variants with synthetic placeholders
- analyze each complete statement
- merge row/parameter/semantic evidence conservatively

Set a configurable structural variant limit.

Exceeding it is a diagnostic, not an unbounded operation.

This is the initial correctness path for:

- conditional projections
- conditional CTEs
- optional joins
- conditionally different statement clauses
- arbitrary valid structural fragments

### Stage B: guarded/local clause analysis before v1 release

Do **not** ship with ordinary optional predicates suffering `2^n`.

Implement specialized local analysis for:

- `@braid where` independent predicates
- `@braid set` independent assignments
- `choose` alternatives inside WHERE/SET
- repeated list elements with a stable SQL skeleton

The release gate must include a query with at least 100 independent optional predicates and prove analysis is approximately linear in predicate count, not exponential.

Fallback variant expansion remains available for shape-changing SQL.

### Conditional result typing

For shape-changing projections:

```ts
const q = sql`
  SELECT id
  /*@braid if ${includeEmail}*/
    , email
  /*@braid end*/
  FROM users
`;
```

Infer:

- exact row when the condition is statically/literally true or false
- a safe union/conditional row type when it is runtime boolean
- preserve correlation when the same condition controls multiple structural regions

Never collapse a conditionally absent property into an always-present property merely for convenience.

---

## 8. TypeScript semantic integration

A normal TypeScript type system cannot infer arbitrary SQL from a tagged template by generics alone. Implement a source-analysis/overlay system.

### 8.1 Source discovery

Use the TypeScript compiler AST to discover imports/aliases of the configured dialect's `sql` tag.

Do not identify SQL tags by variable name alone.

Support:

```ts
import { sql } from "...";
import { sql as dbSql } from "...";
```

and stable supported re-export patterns.

Fail closed for dynamic aliasing that cannot be proven.

### 8.2 Virtual semantic overlay

Do not rewrite source files on disk.

Generate an in-memory source overlay for checking/editor services.

The overlay must:

- assign the inferred `Query<Row, ...>` type to the original tagged expression
- verify every bind expression against its SQL-inferred expected type
- preserve source ranges for diagnostics/hovers
- avoid treating directive conditions as database binds
- preserve TypeScript control-flow narrowing implied by `@braid if` / `when`

For condition-based narrowing, generate overlay-only TS control flow representing the directive:

Conceptually:

```ts
if (name != null) {
  __expect<string>(name);
}
```

or a semantically equivalent nested conditional expression.

The source code remains unchanged.

Do not reject:

```ts
name: string | null

/*@braid if ${name != null}*/
  AND name = ${name}
/*@braid end*/
```

merely because the original source lacks a real JavaScript `if`. The directive condition must narrow the guarded expression for checking.

### 8.3 CLI type check

Provide:

```bash
sqlbraid check
sqlbraid check --file ...
sqlbraid check --project ...
```

It must use the same compiler analysis service as the language server.

No separate editor inference implementation.

### 8.4 Language server/editor

Implement:

- SQL/TS diagnostics
- inferred query hover
- column/type hover
- definition navigation from table/column/routine references to snapshot metadata where practical
- completion for visible tables/columns/routines
- quick fixes for safe structural mistakes
- snapshot reload
- stale-analysis suppression
- cancellation
- bounded caches

VS Code is the first editor target.

Zed can follow through the same LSP.

Do not fork inference logic inside editor extensions.

---

## 9. Type contracts

### 9.1 Query

Public type shape may evolve, but it must preserve at least:

```ts
interface Query<Row> {
  // phantom static row contract
  // immutable runtime template representation
}
```

A second generic may be used for bind/source contracts only if it remains semantically honest for dynamic templates.

Do not expose a misleading “final ordered parameter tuple” if a single dynamic template can render multiple different bind lists.

If necessary, model dynamic binding metadata separately:

```ts
Query<Row, BindingContract>
```

where `BindingContract` describes source binding sites/variants rather than pretending there is one fixed runtime tuple.

### 9.2 Result helpers

Provide:

```ts
type QueryRow<Q> = ...
```

Potentially:

```ts
type QueryResult<Q> = ...
```

Execution APIs:

```ts
db.all(query)       // readonly Row[]
db.one(query)       // Row, cardinality checked
db.maybeOne(query)  // Row | undefined
db.execute(query)   // appropriate command/result contract
```

Rows returned from adapters must be normalized to ordinary objects.

### 9.3 Handwritten result contract

Support:

```ts
sql<UserRow>`SELECT ...`
```

only as verified expected contract.

Compare:

- property names
- property requiredness
- nullability
- compatible TS output type

Decide and document whether extra SQL columns are allowed. Recommended default: exact object shape for query contracts, with a separate “satisfies/assignable” mode only if a real use case requires it.

### 9.4 Unknown

`unknown` is a first-class sound outcome.

Never use `any` for failed inference.

---

## 10. Schema snapshot

Define snapshot format v1 before implementing full inference.

It must be versioned and deterministic.

Minimum top-level model:

```ts
interface SchemaSnapshot {
  readonly formatVersion: number;
  readonly dialect: string;
  readonly dialectVersion: string;
  readonly server: ServerEvidence;
  readonly namespaces: Record<string, NamespaceSnapshot>;
  readonly types: Record<string, TypeSnapshot>;
  readonly relations: Record<string, RelationSnapshot>;
  readonly routines: Record<string, readonly RoutineSnapshot[]>;
  readonly metadata: SnapshotMetadata;
}
```

### Relations

Record at least:

- schema/catalog namespace
- table/view/materialized/foreign/virtual kind where supported
- ordered columns
- DB type identity
- TS type under selected type policy
- nullability and evidence source
- defaults
- generated/identity behavior
- insertable/updatable eligibility
- charset/collation where applicable
- constraints
- indexes
- dialect extension evidence

### Types

Represent enough structure for each dialect:

- scalar
- enum
- domain
- composite/record
- array/collection
- range/multirange
- opaque/unknown
- dialect-specific extensions

### Routines

First-class routine model:

```ts
interface RoutineSnapshot {
  name: string;
  schema?: string;
  identity: string;
  kind: "function" | "procedure" | "aggregate" | "window";
  arguments: RoutineArgument[];
  result: RoutineResult;
  volatility?: ...;
  deterministic?: ...;
  dataAccess?: ...;
  nullInput?: ...;
  versionRange?: ...;
}
```

Argument modes:

```text
in
out
inout
variadic
```

Results:

```text
scalar
set
record
table
void
command
unknown/opaque
```

Allow dialect extension fields for information not portable across PostgreSQL/MySQL/SQLite.

### Snapshot identity

Canonical serialization must sort semantically unordered maps/collections.

Generate cryptographic hashes for:

- complete snapshot
- dialect grammar/catalog revision
- type policy
- normalized server capability evidence
- selected introspection scope

Secrets, connection strings, role names where sensitive, absolute paths, SQL text, and runtime values must not enter portable artifacts unless explicitly intended.

---

## 11. Schema inspection workflow

CLI:

```bash
sqlbraid inspect
sqlbraid drift
```

`inspect` is the explicit live-DB step.

Normal `check`, editor use, and ordinary builds are offline.

### PostgreSQL inspector

Capture at least:

- server version/major
- relevant lexical/session settings
- effective search path
- installed extension identities/versions
- tables/views/materialized views/foreign tables
- columns/defaults/generated/identity
- constraints/indexes
- arrays
- enums
- domains
- composites
- ranges/multiranges
- user routines and argument/result metadata

### MySQL inspector

Capture at least:

- actual Oracle MySQL product identity
- version
- normalized SQL mode
- connection/server charset/collation evidence
- selected databases
- tables/views
- columns/generated/invisible/auto-increment
- enum/set/numeric/temporal metadata
- constraints/indexes
- routine arguments/results/determinism/data access
- creation SQL mode/charset/collation evidence where needed

Do not silently treat MariaDB as MySQL.

### SQLite inspector

Capture:

- SQLite library version
- compile options
- attached schemas
- tables/views/virtual tables
- STRICT / WITHOUT ROWID
- columns and rowid aliases
- generated/hidden columns
- indexes
- foreign keys
- check/trigger fingerprints where available
- configured application routines

SQLite application-defined routine signatures require explicit registry evidence because SQLite catalog metadata cannot prove them.

### Permission-limited introspection

Optional/secondary metadata failures should become explicit incomplete-evidence diagnostics, not silently positive assumptions.

Essential target discovery failure aborts inspection.

---

## 12. SQL lexer/parser architecture

Implement independently.

Do not rely on TypeScript conditional types to parse SQL.

Recommended implementation:

- hand-written bounded lexer
- recursive-descent statement parser
- Pratt parser for expressions/operators
- exact source ranges
- dialect lexical profiles and parser extension hooks

Reasons:

- predictable source mapping
- editor error recovery
- dialect version gates
- dynamic-template token integration
- no native parser dependency requirement
- no need to reconstruct SQL from a query-builder AST

### Common statement AST

Support enough common nodes for:

- `SELECT`
- CTE
- compound queries
- INSERT
- UPDATE
- DELETE
- RETURNING/result clauses
- routine call statement where supported
- transaction/session classification where required for semantics/routing
- expressions/subqueries

Dialect packages can extend statement/expr nodes.

### Parser limits

Bound:

- source bytes
- token count
- nesting depth
- CTE count
- select item count
- expression depth
- structural variants
- generated overlay size

Resource-limit breaches are diagnostics.

---

## 13. Semantic resolver

Separate parsing from semantic/type resolution.

Inputs:

```text
SQL AST
SchemaSnapshot
Dialect built-in catalog
TypePolicy
Server/capability evidence
```

Outputs:

- result columns
- expected bind types
- nullability
- statement result kind
- dependencies
- cardinality evidence where provable
- volatility
- locking
- connection affinity/session state
- diagnostics

### Scope resolution

Implement:

- schemas/catalogs
- relation aliases
- column ambiguity
- stars
- join namespace
- CTE scope
- recursive CTE scope
- derived/subquery scope
- correlated subqueries
- lateral semantics
- function/table-function relations where dialect supports them

### Nullability

At minimum:

- declared column nullability
- outer-join nullable side
- aggregate empty-input behavior
- scalar subquery nullability
- CASE branches
- COALESCE
- routine result nullability
- dialect-specific operator/function nullability

### Bind inference

Infer an ordinary `${value}` expected type from:

- comparison operands
- casts
- DML target columns
- INSERT target positions
- UPDATE assignments
- BETWEEN/ranges
- LIMIT/OFFSET
- function/routine overload arguments
- operator overloads
- array/list element context
- row comparisons
- compound query coercion where meaningful

A parameter with insufficient evidence becomes `unknown`.

### Overload/coercion engine

Create a dialect-owned candidate selection engine for:

- functions
- routines
- operators
- casts
- polymorphic families

Candidate resolution must be deterministic and fail closed on ambiguity.

---

## 14. First-party dialect parity goals

The functional baseline is the public `SQLBraid external reference` capability set current at implementation time. Re-check its current docs before declaring parity because it may evolve after this plan.

### 14.1 PostgreSQL

Target the currently supported stable major lines at implementation time.

Coverage target includes, where supported by those server versions:

- SELECT / DISTINCT / DISTINCT ON
- schemas, aliases, stars, USING
- inner/outer/cross joins
- ordinary/recursive CTE
- SEARCH/CYCLE version gates
- derived/correlated/scalar subqueries
- UNION/INTERSECT/EXCEPT
- grouping, grouping sets, ROLLUP, CUBE
- aggregates including FILTER and ordered forms
- named/inline windows and frames
- lateral/function relations
- ROWS FROM / WITH ORDINALITY
- ordering
- TABLESAMPLE
- LIMIT/OFFSET/FETCH
- CASE/casts
- scalar/row IN
- quantified comparisons
- arrays
- enum/domain/composite
- range/multirange
- JSON/JSONB/JSONPATH
- modern SQL/JSON forms with version gates
- common catalog/built-in functions
- INSERT/UPDATE/DELETE
- ON CONFLICT
- MERGE with version gates
- RETURNING
- function/routine overload resolution
- dialect type coercions/operator families
- extension manifests for types/routines/operators/casts/codecs where feasible

Unknown extensions remain conservative.

### 14.2 MySQL

Target current supported Oracle MySQL LTS lines at implementation time.

Coverage:

- aliases/stars/joins
- recursive CTE
- derived/correlated/lateral subqueries
- compound SELECT/TABLE/VALUES
- grouping/ROLLUP
- aggregates/windows
- CASE
- EXISTS/IN/BETWEEN
- JSON functions/operators
- INSERT VALUE(S), VALUES ROW, SET, SELECT/TABLE sources
- inserted-row aliases
- ON DUPLICATE KEY UPDATE
- REPLACE
- single/multi-table UPDATE/DELETE
- mode-aware lexical semantics
- charset/collation/coercibility
- signed/unsigned numeric rules
- decimal policy
- routine metadata
- version-gated built-ins/types
- explicit unsupported syntax diagnostics

MariaDB is not implicitly supported by the MySQL dialect.

### 14.3 SQLite

Target the current tested stable SQLite feature band at implementation time.

Coverage:

- dynamic storage typing with sound ordinary-table inference
- STRICT tables
- rowid aliases / WITHOUT ROWID
- joins including RIGHT/FULL when version available
- ordinary/recursive CTE
- subqueries
- grouping/windows/FILTER
- CASE/casts
- JSON/JSONB gates
- compound queries
- INSERT/UPDATE/DELETE RETURNING
- conflict algorithms/ON CONFLICT
- UPDATE FROM
- core function catalog with version/compile-option gates
- application-defined routine registry
- virtual table/table-function evidence where declared
- compile-option capability evidence

Do not infer ordinary non-STRICT columns as their declared affinity alone. Runtime storage-class reality must remain sound.

---

## 15. Stored functions and procedures

Routine support is first-class, not an afterthought.

### 15.1 Functions used in expressions

Resolve:

```sql
SELECT some_function(${x})
```

against:

- built-in routine catalog
- snapshot routines
- extension/application routine registry

Infer:

- overload
- argument expectations
- result type
- nullability
- volatility/determinism semantics

### 15.2 Set/table-returning functions

Treat record/table-returning functions as relation sources where the dialect supports them.

Expose the result columns to normal scope resolution.

### 15.3 Procedure calls

Add grammar/runtime support for procedure invocation where the target DB/driver exposes it.

Do not force procedure calls through the ordinary SELECT row model if the database semantics differ.

A public API may expose:

```ts
db.call(query)
```

or a result-kind-sensitive `execute()`.

The compiler should infer catalog-visible OUT/INOUT scalar outputs.

### 15.4 Opaque cursor/dynamic result sets

If catalog metadata says only “cursor” or otherwise lacks row columns:

- output row type is `unknown`
- allow an explicit local contract/validator for that output only
- do not require the entire call result to be handwritten
- do not parse procedure bodies to guess arbitrary dynamic SQL

Example conceptual API:

```ts
sql.out.cursor<UserRow>("rows")
```

or an equivalent declaration mechanism.

The concrete syntax can be adjusted to fit each driver's actual call API, but the type-safety policy must remain.

### 15.5 Multiple result sets

Design the internal call result representation to handle:

- OUT parameters
- zero or more result sets
- driver-specific metadata

Normalize the public result to typed ordinary JS objects and arrays.

Unknown result-set shapes remain unknown unless explicitly contracted.

---

## 16. Runtime type policy and codecs

Each dialect exports a default TypePolicy and allows explicit customization.

A policy must define:

- DB type identity
- accepted input TS types
- output TS type
- encoder where needed
- decoder where needed
- array/collection handling
- null handling

Changing type policy changes snapshot/compiler identity.

Examples requiring explicit policy:

- PostgreSQL bigint/numeric/temporal
- MySQL bigint/decimal/date/JSON/tinyint(1)
- SQLite integer number-vs-bigint and flexible storage classes

Runtime adapters must reject driver configuration that contradicts the active policy when that contradiction would make static inference false.

---

## 17. Database runtime API

Build a grammar-neutral database contract.

Minimum:

```ts
database.execute(query)
database.all(query)
database.one(query)
database.maybeOne(query)

database.transaction(async (tx) => ...)
database.batch([...])
database.prepare(name, factory)
database.stream(query, options)
```

Where a backend can safely support it:

```ts
database.pipeline([...])
```

Requirements:

- plain object rows
- nested transactions via savepoints when supported
- strict transaction scope ownership
- cancellation/deadline contract only where it can be implemented honestly
- prepared structural-shape drift detection
- bounded caches
- no hidden multi-statement string concatenation
- stable normalized adapter errors
- no SQL text/bound values in redacted error/observer metadata by default

---

## 18. Prepared statements

`prepare(name, factory)` must:

- keep exact query/result inference
- freeze allowed structural skeletons
- reject duplicate logical names
- reject unexpected structural drift
- bound per-factory dynamic-cardinality variants
- integrate with driver-native prepared caches where applicable
- invalidate appropriately after schema/session changes that make prepared metadata unsafe

Dynamic predicates may produce multiple legitimate structural variants. Cache them by variant fingerprint with an explicit bound.

---

## 19. Streaming

Support typed async iteration.

PostgreSQL:

- lazy optional cursor dependency
- leased connection for cursor lifetime
- explicit close/early break cleanup
- transaction scope reuses transaction connection

MySQL:

- protocol-backed streaming
- honest semantics for early consumer break/drain/cancellation

SQLite:

- adapt synchronous native iteration to common async iterator contract
- document event-loop blocking
- do not claim asynchronous cancellation if the API cannot deliver it

---

## 20. Batch/pipeline

`batch()`:

- sequential statements on one leased connection
- not implicit atomicity
- explicit transaction for atomic batch

PostgreSQL may provide explicit `pipeline()` where the chosen `pg` version and public API support it.

Do not emulate a pipeline by concatenating SQL.

---

## 21. Native bulk operations

Match the reference feature class without forcing it into core execution.

PostgreSQL:

- COPY FROM typed INSERT factory
- COPY TO typed static SELECT
- backpressure
- no arbitrary server path/PROGRAM injection
- lazy optional dependency

MySQL:

- typed LOAD DATA LOCAL INFILE path using application-provided stream only
- no arbitrary local path from SQL input
- reject types that cannot be serialized soundly

SQLite:

- no fake native bulk capability; ordinary transaction/batched insertion is sufficient unless the native API exposes a real distinct protocol.

Bulk APIs must preserve type checking from the normal SQL factory.

---

## 22. Result validation

Static inference does not validate untrusted runtime data.

Support optional Standard Schema V1-compatible result validators without taking a hard dependency on a validator library.

Conceptual:

```ts
const checked = sql.validateResult(query, schema);
```

Requirements:

- validator output must be statically compatible with inferred SQL row
- validation occurs after runtime DB decoding
- unvalidated path pays no validator dependency/runtime cost
- validation errors do not expose SQL or secret values by default

---

## 23. Query semantics evidence

Analysis should produce a versioned semantics object.

At minimum:

- statement operation/read/write
- schema dependencies
- routine dependencies
- cardinality evidence where provable
- volatility
- locking
- connection/session affinity
- server capability/version requirements

Conditional templates merge semantics conservatively.

This evidence is reused by manifests, routing, compatibility, and observability.

---

## 24. Query fingerprints and manifests

Generate path-independent fingerprints from canonical static query/template evidence.

Maintain:

- query fingerprint
- structural variant fingerprint
- variant description
- inferred result description
- parameter/binding description
- dependency evidence
- semantic evidence
- relative source location

Portable manifests must not contain:

- bound values
- secrets
- connection strings
- absolute paths

Prefer not to persist raw SQL unless a dedicated explicit artifact requires it.

CLI:

```bash
sqlbraid manifest
```

---

## 25. Live database verification

Provide an optional explicit live command that verifies compiler inference against native prepare/describe metadata **without executing application values** where the database protocol permits it.

PostgreSQL:

- parse/describe-style metadata
- parameter/result OID comparison
- no Bind/Execute for verification

MySQL:

- COM_STMT_PREPARE metadata
- close statement without executing values

SQLite:

- implement only evidence that can be obtained safely from native prepare/metadata
- do not invent native type precision SQLite does not provide

Generate deterministic redacted proof artifacts.

CLI:

```bash
sqlbraid verify --live
sqlbraid verify
```

Offline `verify` validates the stored proof against current compiler/snapshot identities.

---

## 26. Query plan governance

Optional explicit plan inspection:

- PostgreSQL structured JSON EXPLAIN without ANALYZE by default
- MySQL structured JSON EXPLAIN without ANALYZE
- SQLite plan support only if useful/stable enough; otherwise capability is absent rather than simulated

Normalize plan evidence into a small dialect-neutral node inventory.

Support:

- fingerprint-keyed plan capture
- before/after comparison
- absolute budgets
- relative budgets when environments are comparable
- explicit uncertainty for changed schema/settings/statistics/sample policy

Do not store expressions/literals unnecessarily.

CLI:

```bash
sqlbraid explain
sqlbraid explain --compare ...
```

---

## 27. Schema drift and migration compatibility

`drift` compares live/current snapshot evidence to checked-in snapshot deterministically.

Migration compatibility consumes:

- before snapshot
- after snapshot
- before query manifest
- after query manifest

Analyze both rolling-deployment directions:

```text
old app → new DB
new app → old DB
```

Classify:

- compatible
- breaking
- unknown
- source-only/runtime-only as appropriate

Map breaking schema/routine/type changes to exact affected query source ranges through dependency evidence.

CLI:

```bash
sqlbraid compat ...
```

---

## 28. Semantic read routing and transaction retry

Optional routed database wrapper:

```text
primary
replica(s)
```

Route to a replica only when compiler/runtime grammar evidence proves the query is:

- read-only
- non-locking
- not session-affine
- not volatile/unsafe under dialect rules

Anything unknown routes to primary.

Transaction retries:

- explicit transaction callback only
- dialect-owned retryable error classification
- bounded attempts/backoff
- never retry arbitrary statements outside an explicit transaction scope unless a separately proven idempotency model exists

---

## 29. Observability

Core defines a driver-neutral observer contract.

Provide optional OpenTelemetry bridge.

Observe at least:

- query
- prepared query
- batch
- pipeline where present
- stream
- transaction/nested transaction
- cancellation/deadline
- bulk operations

Default telemetry contains:

- compiler-compatible fingerprints
- operation/result kind
- duration/status
- safe dialect metadata

Do not emit SQL text or bound values by default.

---

## 30. Runtime compatibility negotiation

When configured with a compile snapshot, an adapter should verify that the live target is compatible before claiming compiler/runtime parity.

Compare dialect-relevant evidence such as:

- server major/version policy
- lexical/session modes
- type policy identity
- catalog revision
- extension versions
- search path/schema scope where applicable
- charset/collation mode
- SQLite compile options

Mismatch fails before normal application SQL when compatibility mode is enabled.

This feature is explicit; runtime adapters without a compatibility snapshot may remain lazy.

---

## 31. Diagnostics

Create stable diagnostic codes and source ranges from the beginning.

Families should include:

- template/directive syntax
- unsafe structural interpolation
- SQL parse
- name resolution
- ambiguity
- type mismatch
- parameter mismatch
- routine overload mismatch
- unsupported/version-gated feature
- incomplete schema evidence
- stale/mismatched snapshot
- structural variant/resource limit
- runtime compatibility
- driver capability mismatch

Diagnostics must include:

- stable code
- severity
- concise message
- exact source range
- actionable suggestion where possible

Never hide unsupported SQL by silently returning a plausible type.

---

## 32. Custom dialect/conformance SPI

Define a stable public dialect contract before considering the first-party dialect work complete.

A dialect must provide:

- ID/version
- SQL module/tag identity
- lexer profile
- parser/analyzer
- placeholder renderer
- identifier quoting
- snapshot validation
- schema provider/introspection
- type policy
- runtime codec surface
- server capability/version policy
- query semantics
- optional live verifier
- optional plan inspector
- optional retry classifier
- optional routing classifier
- optional bulk capabilities

The `conformance` package must be able to test a third-party dialect without importing first-party PostgreSQL/MySQL/SQLite code.

---

## 33. CLI

Target commands:

```text
inspect / generate
check
drift
manifest
verify --live
verify
explain
compat
```

Optional helpful commands:

```text
doctor
snapshot print
query explain-type
```

CLI output:

- deterministic where machine-consumed
- human-readable diagnostics on stderr/stdout as appropriate
- `--json` for CI
- no credentials in output
- explicit exit codes

---

## 34. Configuration

One project config file.

Conceptual:

```ts
export default defineConfig({
  dialect: postgres(...),
  schema: {
    snapshot: "./db/schema.json",
    provider: ...
  },
  typePolicy,
  compiler: {
    maxSourceBytes: ...,
    maxQueries: ...,
    maxStructuralVariants: ...,
    maxGeneratedOverlayBytes: ...
  }
});
```

Requirements:

- no implicit DB access during config load for ordinary checks
- connection factories used only by explicit live commands
- application owns credentials and driver installation
- config must be importable without loading all drivers/dialects

---

## 35. Security requirements

### SQL injection

- ordinary interpolation always binds
- identifier interpolation must use `ident`
- raw SQL requires explicit `raw`
- fragment objects are branded/opaque
- arrays are not implicitly structure
- no mixed value/fragment arrays without explicit API

### Artifact redaction

Manifests, proofs, plan evidence, telemetry, diagnostics, and compatibility reports must not accidentally persist:

- bound parameter values
- credentials
- connection strings
- absolute local paths
- raw driver errors containing secrets

### Resource exhaustion

Bound all parser/compiler/runtime expansion operations.

### Driver safety

- do not enable MySQL multi-statements for convenience
- bulk APIs must not accept arbitrary filesystem paths
- cancellation must not return a protocol-corrupted connection to a pool
- failed transactions must not continue as if healthy

---

## 36. Testing architecture

Testing is a release feature, not cleanup work.

### 36.1 Unit tests

- template scanner
- directive parser
- trim/where/set
- renderer placeholder/value order
- lexer
- parser
- resolver
- coercion
- nullability
- overloads
- source mapping
- overlay generation
- snapshot codec/hash
- runtime codecs

### 36.2 Golden source tests

Each fixture should contain:

```text
schema snapshot
TypeScript source
expected diagnostics
expected inferred row type
expected bind expectations
expected rendered SQL per runtime branch
```

### 36.3 Database differential tests

Run real supported database versions in CI.

For inference questions where the server provides native evidence, compare compiler expectations with prepare/describe metadata.

### 36.4 Reference parity suite

Create independently written cases covering the public capability classes exposed by `SQLBraid external reference`.

Do not copy its tests.

Track a matrix:

```text
feature
postgres status
mysql status
sqlite status
our diagnostic/result
reference behavior
notes
```

A capability is not considered parity-complete because one happy-path fixture passes.

### 36.5 Mutation/fuzz/property testing

At minimum:

- SQL tokenizer/parser fuzz
- directive nesting fuzz
- renderer property: number/order of placeholders equals active bound values
- source-map round-trip ranges
- snapshot canonicalization stability
- operator/function overload mutation cases
- condition/variant correlation

### 36.6 Performance tests

Measure:

- static query analysis
- many-query project analysis
- incremental editor re-analysis
- 100+ optional WHERE predicates
- large INSERT lists
- deep but valid SQL
- worst-case rejected nesting

Set budgets before release.

---

## 37. Implementation phases and gates

The agent should execute these phases in order. Do not stop after writing architecture stubs.

### Phase 0 — repository reconnaissance and reference lock

1. Inspect the repository's existing build/package conventions.
2. Re-read current `SQLBraid external reference` public README and relevant public docs.
3. Write a local capability matrix from the current reference.
4. Record the reference commit SHA/date used for parity tracking.
5. Establish clean-room implementation rule in contributor/agent docs if the repository has them.

Gate:

- capability matrix exists
- no production dependency on `SQLBraid external reference`
- package boundaries agreed in code layout

### Phase 1 — core + Template IR + renderer

Implement:

- core Query/Fragment contracts
- SQL tag
- directive scanner/parser
- Template IR
- `if`, `choose`, `where`, `set`, `trim`
- structural helpers
- runtime renderer
- source mapping
- renderer limits

Gate fixtures must cover:

- optimizer hints
- MySQL version comments
- normal comments
- fake `/* @braid */` comments
- every directive nesting combination
- placeholder order across enabled/disabled branches
- malicious/raw structural cases
- trim correctness around nested SQL/comments/strings

### Phase 2 — schema v1 + config + snapshot codec

Implement:

- schema model
- canonical serialization
- hash/identity
- config loader
- snapshot migrations infrastructure
- drift primitives

Gate:

- byte-for-byte deterministic output from equivalent metadata
- format validation
- unknown future fields/version handling policy tested

### Phase 3 — compiler source discovery + minimal overlay

Implement:

- TS AST SQL tag discovery
- Template IR extraction from source
- overlay engine
- source-map diagnostics
- manually supplied/mock SQL analysis results to prove editor/tsc path

Gate:

- a mock inferred row becomes the actual hover/tsc type
- a mock expected bind rejects wrong TS expression type
- directive condition narrows guarded expressions
- source files are never rewritten

### Phase 4 — common SQL lexer/parser/resolver foundation

Implement:

- bounded lexer
- expression Pratt parser
- common query/DML AST
- scopes
- column resolution
- joins/nullability
- subqueries
- CTEs
- compound queries
- basic function/operator/cast abstraction
- basic DML parameter inference

Use synthetic dialect fixtures before full real dialect catalogs.

Gate:

- cross-dialect common SQL fixtures infer exact rows/parameters
- ambiguity and unknown evidence fail closed

### Phase 5 — PostgreSQL vertical completion

Build PostgreSQL introspection, catalogs, resolver extensions, type policy, runtime codec utilities, and grammar coverage.

Start with common SELECT/DML, then systematically close the PostgreSQL parity matrix.

Do not declare completion with “most SQL works”.

Gate:

- PostgreSQL capability matrix has no unexplained red/unknown entries inside declared support
- real DB differential tests pass
- runtime decoded types match static policy
- routine/function inference passes
- extension/version behavior is conservative

### Phase 6 — MySQL vertical completion

Implement MySQL lexical modes, coercion/collation/numeric behavior, introspection, routines, grammar, codecs, and runtime contracts.

Gate:

- supported LTS/version profiles tested
- MariaDB rejected or separately identified
- SQL mode behavior cannot silently use wrong grammar
- real prepare metadata differentials pass

### Phase 7 — SQLite vertical completion

Implement SQLite version/compile-option evidence, STRICT/dynamic typing, introspection, routine registry, grammar, type policy, and node adapter contracts.

Gate:

- ordinary non-STRICT values remain sound
- STRICT tables infer precisely
- compile-option/version gates tested
- Node runtime integer policy equals compiler inference

### Phase 8 — structural analysis hardening

Replace exponential common-case dynamic WHERE/SET analysis with guarded/local analysis.

Retain bounded variants for true shape changes.

Gate:

- 100 independent optional predicates analyze successfully within performance budget
- conditional projection/join types remain correct
- repeated conditions remain correlated
- no type result changes versus exhaustive expansion on small cross-check fixtures

### Phase 9 — production runtime adapters

Implement:

- pg
- mysql2
- node:sqlite

Then:

- execute/all/one/maybeOne
- transaction/savepoints
- batch
- prepare
- streaming
- cancellation/deadline where honestly supportable
- normalized errors
- runtime compatibility negotiation

Gate:

- integration tests on real DBs
- no driver-specific result shape leaks
- connection cleanup failure tests
- prepared shape drift tests
- transaction invalidation tests

### Phase 10 — routine/procedure execution

Complete:

- expression functions
- table/set-returning functions
- CALL/procedure syntax where DB supports it
- IN/OUT/INOUT
- opaque result set contracts
- multiple-result-set internal model

Gate:

- catalog-known outputs inferred
- opaque outputs remain unknown until explicitly declared
- no procedure-body guessing

### Phase 11 — parity operational features

Implement and test:

- Standard Schema result validation
- query semantics
- fingerprints/manifests
- live verification
- plan governance
- schema/migration compatibility
- semantic routing/retries
- observability
- native bulk operations
- PostgreSQL pipeline if supported by the chosen adapter API

Each feature must be capability-gated. Do not simulate unsupported backend features.

### Phase 12 — LSP/editor completion

Implement production editor behavior using the same analysis service:

- hover
- diagnostics
- completion
- definitions
- quick fixes
- cancellation
- incremental caches
- snapshot reload

Gate:

- CLI/editor diagnostics and inferred types are identical for the same source revision
- no stale result publication
- bounded memory/caches

### Phase 13 — parity/release audit

1. Re-read the current `SQLBraid external reference` docs at the end, not only the reference snapshot from Phase 0.
2. Diff newly added public capabilities.
3. Update parity matrix.
4. Run all database matrices.
5. Run conformance.
6. Run performance/resource-limit tests.
7. Run package/API surface audit.
8. Run security/redaction audit.
9. Review docs examples against executable fixtures.

Release only when remaining differences are deliberate and documented.

---

## 38. Required representative acceptance fixtures

The following are mandatory.

### Dynamic WHERE

```ts
const q = sql`
  SELECT a.id, a.email
  FROM account a
  /*@braid where*/
    /*@braid if ${status != null}*/
      AND a.status = ${status}
    /*@braid end*/
    /*@braid if ${minimumId != null}*/
      AND a.id >= ${minimumId}
    /*@braid end*/
  /*@braid end*/
`;
```

Prove:

- correct render for all four combinations
- correct value order
- exact output row
- guarded nullable input narrowing

### Dynamic SET

```ts
const q = sql`
  UPDATE account
  /*@braid set*/
    /*@braid if ${patch.email !== undefined}*/
      email = ${patch.email},
    /*@braid end*/
    /*@braid if ${patch.status !== undefined}*/
      status = ${patch.status},
    /*@braid end*/
  /*@braid end*/
  WHERE id = ${id}
  RETURNING id, email, status
`;
```

Prove:

- comma trimming
- no empty SET
- assignment type inference
- RETURNING row inference

### Conditional projection

```ts
const q = sql`
  SELECT id
  /*@braid if ${includeEmail}*/
    , email
  /*@braid end*/
  FROM account
`;
```

Prove exact/conditional/union type behavior.

### Outer join

Prove join-side nullability.

### Recursive CTE

Prove seed/member shape checking and dialect differences.

### Compound query

Prove arity/type merging.

### Function overload

Prove bind expectation from routine candidate selection.

### Table-returning routine

Prove relation scope and output columns.

### Procedure with known OUT metadata

Prove typed plain object output where driver semantics allow it.

### Procedure with opaque result set

Prove `unknown` by default and local explicit contract path.

### PostgreSQL enum/domain/array/range/JSON

Prove type and operator resolution.

### MySQL enum/unsigned/decimal/collation/sql_mode

Prove dialect semantics and mode evidence.

### SQLite ordinary vs STRICT

Prove sound storage union versus precise STRICT type.

### SQL comments/hints

Prove all non-exact `/*@braid` forms survive unchanged.

---

## 39. Documentation deliverables

Write executable docs, not aspirational API prose.

Required:

- philosophy: SQL-first vs query builder
- dynamic directive reference
- schema snapshot workflow
- type inference/safety rules
- unknown/unsafe boundaries
- functions/procedures
- execution/transactions
- prepared statements
- streaming
- bulk
- result validation
- observability
- manifests/live verification/plans
- migration compatibility
- routing/retries
- PostgreSQL reference
- MySQL reference
- SQLite reference
- custom dialect guide
- diagnostics
- editor setup
- version/support policy

Every documented code sample must be covered by a compile fixture or executable test where practical.

---

## 40. Definition of done

This plan is complete only when all of the following are true:

0. All public branding is consistently SQLBraid: npm packages use `@sqlbraid/*`, the CLI is `sqlbraid`, and dynamic template directives use the exact `/*@braid ...*/` namespace.

1. Developers can author static and MyBatis-style dynamic SQL inside a tagged template without converting SQL clauses into a query-builder DSL.
2. Exact `/*@braid ...*/` directives never leak to the DB.
3. Ordinary comments, optimizer hints, and vendor comments do not collide with directive parsing.
4. PostgreSQL/MySQL/SQLite schema snapshots are generated explicitly from real DB metadata and normal editor/build analysis is offline.
5. Result row types are inferred automatically wherever schema + grammar + routine evidence can prove them.
6. Bound TS expressions are checked against SQL-inferred expected types.
7. Directive conditions participate in control-flow narrowing for guarded binds.
8. Result rows returned to application code are ordinary typed TS objects.
9. Handwritten `sql<T>` contracts are verified, not blindly trusted.
10. Opaque/unprovable result shapes are `unknown` or explicitly contracted; never fabricated.
11. Functions/routines are first-class in snapshot and resolver logic.
12. Procedure execution supports metadata-visible inputs/outputs where the dialect/driver permits it and treats dynamic result sets honestly.
13. Common dynamic WHERE/SET analysis does not grow exponentially with independent predicates.
14. Shape-changing dynamic SQL remains bounded and safe.
15. Static TypePolicy and runtime codecs agree.
16. Unsupported/version-gated/ambiguous SQL fails closed.
17. PostgreSQL/MySQL/SQLite declared grammar coverage matches the current reference capability matrix or every deliberate deviation is documented.
18. Runtime adapters pass real-database integration tests.
19. CLI and editor use one shared analysis service and return equivalent inference/diagnostics.
20. Snapshot drift, query manifests, live verification, plan governance, migration compatibility, result validation, observability, routing/retries, and supported bulk operations are implemented to the declared parity level.
21. Third-party dialects can be built and tested through the public dialect/conformance contract.
22. No production package imports or ports `SQLBraid external reference`.
23. Parser/compiler/runtime resources are explicitly bounded.
24. Portable artifacts and default telemetry contain no secrets or bound values.
25. All release gates and parity matrices pass.

---

## 41. Agent execution instruction

Implement this plan rather than producing another speculative architecture document.

Before changing code:

- inspect the existing repository and adapt names/build conventions to it
- read the current public `SQLBraid external reference` reference docs listed above
- establish the parity matrix and reference commit
- identify any existing parser/runtime/schema code that already satisfies parts of this plan

Then execute the phases sequentially.

Do not stop because a phase is large. Keep each layer working and tested before expanding coverage.

When a design choice is under-specified:

1. preserve SQL-first authoring,
2. preserve soundness,
3. preserve offline compilation,
4. prefer DB metadata over handwritten duplication,
5. prefer explicit `unknown` over inference guesses,
6. keep runtime driver ownership in the application,
7. keep dialect semantics outside compiler core.

Do not replace difficult SQL semantics with `any`, broad casts, handwritten result types, or skipped tests merely to make the build green.

When full parity requires more work than initially expected, continue closing the parity matrix. The parity matrix, database evidence, and executable fixtures—not line count or apparent feature completion—determine whether the implementation is done.

