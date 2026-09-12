# SQLBraid v1 Product Plan

> Status: authoritative product and engineering plan
>
> Project: **SQLBraid**
>
> npm scope: **`@sqlbraid/*`**
>
> CLI: **`sqlbraid`**
>
> Dynamic SQL directive namespace: **`/*@braid ...*/`**

---

## 0. Product definition

SQLBraid is a **SQL-first data-access toolkit for TypeScript**.

It exists for developers who want to keep writing SQL as SQL, while gaining the TypeScript ergonomics normally missing from driver-level database access:

- safe parameter binding;
- readable inline dynamic SQL;
- explicit result contracts;
- plain JavaScript/TypeScript rows;
- transaction and execution helpers;
- runtime validation when requested;
- database-assisted verification when requested;
- first-party PostgreSQL, MySQL, and SQLite adapters.

The primary authoring surface is a tagged template:

```ts
const query = sql<UserRow>`
  SELECT u.id, u.name, u.email
  FROM users u

  /*@braid where*/
    /*@braid if ${name != null}*/
      AND u.name = ${name}
    /*@braid end*/

    /*@braid if ${active != null}*/
      AND u.active = ${active}
    /*@braid end*/
  /*@braid end*/

  ORDER BY u.id
`;
```

SQLBraid should make this style pleasant and safe **without turning into a universal SQL compiler or ORM**.

---

## 1. Product thesis

### 1.1 SQL stays SQL

Do not replace SQL with a fluent query-builder language.

The product should reward existing SQL knowledge instead of forcing developers to translate SQL into a TypeScript AST API.

Good:

```ts
sql<User>`
  SELECT id, name
  FROM users
  WHERE status = ${status}
`;
```

Not the primary SQLBraid experience:

```ts
query
  .select(...)
  .from(...)
  .where(...);
```

### 1.2 Dynamic SQL belongs in the SQL flow

Conditional clauses should remain readable top-to-bottom.

The v1 directive set is intentionally small:

- `if`
- `choose`
- `when`
- `otherwise`
- `where`
- `set`
- `trim`

Do not build a second programming language inside SQL. Conditions are ordinary TypeScript expressions captured by the compiler transform.

### 1.3 The database already has a SQL parser

SQLBraid must not attempt to reproduce the full grammar, function registry, operator system, coercion rules, extension ecosystem, or version-specific semantics of every supported database.

When SQL meaning needs authoritative verification, prefer the **actual database** over a local reimplementation.

### 1.4 Explicit contracts are a feature, not a failure of inference

For v1, explicit TypeScript result contracts are the default typed workflow.

```ts
interface UserRow {
  id: number;
  name: string;
  email: string | null;
}

const query = sql<UserRow>`SELECT id, name, email FROM users`;
```

A query without a declared or generated contract is `Query<unknown>`.

SQLBraid does not need to understand every SQL function or database extension in order to return useful typed results.

### 1.5 Verification is separate from declaration

A declared TypeScript contract and a verified database contract are different states.

SQLBraid should make that distinction visible in tooling and metadata.

Verification may come from:

- runtime Standard Schema validation;
- database metadata/describe capabilities;
- query manifests generated against a real database;
- integration tests using the real driver/database.

Do not claim a contract is database-verified merely because TypeScript accepted the declaration.

---

## 2. Non-goals

The following are explicitly **not** v1 goals:

- being an ORM;
- replacing SQL with a query builder;
- implementing a complete PostgreSQL grammar;
- implementing a complete MySQL grammar;
- implementing a complete SQLite grammar;
- maintaining built-in signatures for every SQL function;
- reproducing every database operator/coercion rule locally;
- inferring arbitrary user-defined function return types from SQL text;
- proving every possible dynamic SQL combination at compile time;
- achieving behavioral parity with another TypeScript database library;
- treating automatic SQL-to-TypeScript inference as the product's primary value.

If an advanced feature requires SQLBraid to become a database parser/compiler vendor, the default answer is **no** unless it directly unlocks a core product requirement that cannot be solved through explicit contracts or database-assisted verification.

---

## 3. Core authoring contract

### 3.1 Value interpolation is always binding

```ts
sql`WHERE id = ${id}`;
```

must produce a driver placeholder and a bound value.

It must never concatenate `id` into SQL text.

### 3.2 Structural interpolation is explicit

Use dedicated helpers for SQL structure:

```ts
sql.ident(name)
sql.fragment`...`
sql.raw(text)
sql.empty
sql.join(parts, separator)
sql.list(values)
```

Rules:

- `sql.ident()` quotes an identifier through the dialect.
- `sql.fragment` carries trusted SQLBraid template structure.
- `sql.list()` expands bound values, not raw literals.
- `sql.raw()` is an explicit trusted/unsafe escape hatch.
- ordinary `${value}` never becomes structure.

### 3.3 Dynamic directives never reach the database

The renderer must consume all `@braid` directives before dispatch.

The final driver input is always:

```ts
interface RenderedQuery {
  text: string;
  values: readonly unknown[];
}
```

plus internal metadata when useful.

---

## 4. Dynamic SQL model

### 4.1 `if`

```ts
sql`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
  /*@braid end*/
`;
```

The guarded interpolation must be evaluated lazily by the compiler transform. A bare JavaScript tagged template cannot retroactively make interpolation lazy.

### 4.2 `choose`

```ts
sql`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid choose*/
      /*@braid when ${id != null}*/
        AND id = ${id}
      /*@braid when ${name != null}*/
        AND name = ${name}
      /*@braid otherwise*/
        AND active = ${true}
    /*@braid end*/
  /*@braid end*/
`;
```

`choose` uses first-true semantics and preserves lazy evaluation.

### 4.3 `where`, `set`, and `trim`

These directives are rendering utilities, not SQL theorem provers.

They are responsible for deterministic prefix/suffix handling and common syntax cleanup such as removing a leading `AND`/`OR` or trailing comma where defined.

They do **not** promise that every user-written branch forms valid SQL. Database verification and tests remain the authority for SQL correctness.

### 4.4 No exponential compile-time proof requirement

A query with 100 optional predicates must not force SQLBraid to enumerate `2^100` variants.

The v1 compiler should preserve TypeScript control-flow safety and rendering semantics, but it is not required to prove every database-semantic combination.

---

## 5. Type model

### 5.1 Untyped query

```ts
const query = sql`SELECT ...`;
```

is conceptually:

```ts
Query<unknown>
```

unless a generated verification artifact supplies a known contract.

### 5.2 Declared result contract

```ts
const query = sql<UserRow>`SELECT ...`;
```

means:

> The application declares `UserRow` as the expected application-facing row contract for this query.

This is the primary v1 typed authoring path.

The TypeScript compiler may validate the TypeScript shape itself, but SQLBraid must not claim the database proved this type unless database verification has actually occurred.

### 5.3 Runtime validation

SQLBraid already supports Standard Schema-style validation infrastructure. v1 should expose a simple path for attaching a runtime row validator to a query/execution flow.

Runtime validation is valuable when:

- database schemas are managed outside the TypeScript application;
- SQL contains opaque/custom functions;
- untrusted or loosely typed driver values require checking;
- production correctness matters more than validation overhead.

### 5.4 Database-verified contract

A verification workflow should compare a query's declared/generated contract against real database metadata whenever the dialect can provide trustworthy evidence.

This is an opt-in development/CI workflow, not a requirement for ordinary application startup.

### 5.5 Optional automatic inference

Automatic result inference is a **secondary convenience feature**.

It is acceptable only when evidence is cheap, deterministic, and trustworthy.

Examples that may be supported later:

- metadata returned directly by a prepared/describe protocol;
- generated query manifests;
- simple static queries where proof is trivial and stable.

Unsupported SQL must fall back to `unknown` or an explicit contract. Do not grow a universal semantic SQL engine merely to preserve inference coverage.

---

## 6. Database-assisted verification

### 6.1 Philosophy

The database is the authoritative implementation of its SQL dialect.

SQLBraid verification should use real database capabilities when possible instead of duplicating:

- function signatures;
- extension functions;
- operator overloads;
- casts/coercions;
- version-specific grammar;
- user-defined routines.

### 6.2 Query manifest

The target artifact is a deterministic query manifest keyed by a stable query/template fingerprint.

Conceptual shape:

```json
{
  "version": 1,
  "dialect": "postgres",
  "queries": {
    "<fingerprint>": {
      "parameters": [
        { "databaseType": "text", "nullable": false }
      ],
      "columns": [
        { "name": "id", "databaseType": "int8", "typescriptType": "bigint" },
        { "name": "name", "databaseType": "text", "typescriptType": "string" }
      ]
    }
  }
}
```

The exact format should be versioned and deterministic.

### 6.3 Offline development

Normal editor/build operation should not require a live database.

A live verification step can generate/update the manifest. Later checks can consume it offline.

### 6.4 Dynamic SQL verification

SQLBraid does not need to prove every dynamic combination automatically.

Verification may cover:

- explicitly supplied representative cases;
- variants observed in integration tests;
- bounded cases when cheap;
- database-prepared statements generated from known variants.

Tooling must report what was verified. It must not silently generalize one verified variant to all possible variants.

---

## 7. Dialect architecture

Dialect support must remain intentionally thin.

A dialect is responsible for database/driver boundaries, not for reimplementing the database parser.

Conceptual responsibilities:

```ts
interface Dialect {
  readonly id: string;
  placeholder(index: number): string;
  quoteIdentifier(identifier: string): string;
  readonly lexicalProfile?: DialectLexicalProfile;
}
```

The dialect package additionally owns:

- driver adapter;
- transaction/savepoint controls;
- result normalization;
- type policy/codecs;
- optional schema inspection;
- optional prepare/describe verification capability;
- dialect-specific runtime features where justified.

First-party dialects:

- PostgreSQL (`pg`)
- MySQL (`mysql2`)
- SQLite (`node:sqlite`)

Adding another dialect should primarily require a renderer/adapter/type-policy package, not compiler-core grammar changes.

---

## 8. Runtime

### 8.1 Plain results

Rows returned to application code are ordinary JavaScript objects/arrays.

No ORM entity lifecycle is introduced.

### 8.2 Cardinality helpers

Core execution surface:

```ts
db.all(query)
db.one(query)
db.maybeOne(query)
db.execute(query)
db.call(query)
```

### 8.3 Transactions

Current transaction ownership/poison semantics are retained.

Requirements:

- one physical execution resource has one shared ownership state;
- root operations cannot leak into an active transaction;
- failed transaction-control cleanup poisons the physical resource;
- nested transactions use savepoints where supported;
- leaked transaction handles fail deterministically.

Future pool support must lease a physical connection for the full transaction lifetime.

### 8.4 Prepared queries and streaming

Retain the current prepared-query shape lock and streaming seam.

Future work should prefer native driver facilities where available rather than emulating protocols in core.

### 8.5 Cancellation and backpressure

Cancellation, streaming lifecycle, batch/bulk/pipeline support, and bounded backpressure remain post-core runtime work.

---

## 9. Compiler responsibilities after the pivot

The compiler remains useful, but its job becomes much smaller and clearer.

It should own:

1. discovering configured `sql` tags through the TypeScript compiler;
2. parsing SQLBraid template directives;
3. generating hygienic lazy control flow for guarded interpolations;
4. preserving TypeScript control-flow narrowing;
5. preserving source maps/diagnostic ranges;
6. attaching declared/generated query contracts;
7. generating/querying stable fingerprints and manifests;
8. project-aware diagnostics for SQLBraid-specific misuse.

It should **not** own:

- a complete SQL grammar;
- complete SQL expression semantics;
- a database function registry;
- full dialect coercion logic;
- universal result inference.

---

## 10. What happens to the existing SQL AST work

The existing `@sqlbraid/ast` and semantic resolver were created for a broader automatic-inference strategy.

Do not keep expanding that scope by inertia.

Migration plan:

1. identify which lexical/scanning utilities are still required for safe directive handling, lightweight statement classification, diagnostics, or verification support;
2. move or retain only those narrow utilities;
3. stop adding broad expression/function/operator semantics;
4. remove compiler dependencies on semantic AST inference where explicit contracts/manifests replace them;
5. deprecate or remove unused AST/resolver APIs before v1 if they no longer serve a product requirement.

Deletion is preferred over maintaining a second partial SQL implementation indefinitely.

---

## 11. Schema metadata after the pivot

Schema inspection remains useful, but its role changes.

Use schema metadata for:

- type-policy configuration;
- database-assisted verification;
- editor completion/hover;
- optional contract generation;
- migration/drift tooling where useful.

Do not require schema snapshots as a prerequisite for every ordinary `sql<T>` query.

A developer who writes an explicit result contract should be able to develop offline without teaching SQLBraid the full schema semantics of every custom function/operator.

---

## 12. CLI

Target CLI surface:

### `sqlbraid check`

Checks:

- TypeScript integration;
- dynamic directive structure;
- unsafe/misused SQLBraid APIs;
- declared contract availability;
- manifest drift when a manifest is configured.

It should not pretend to validate arbitrary SQL semantics without database evidence.

### `sqlbraid build`

Emits the hygienic guarded-template transform where needed.

### `sqlbraid verify`

Connects to a configured database/test instance and verifies query contracts/metadata using dialect-specific capabilities.

Verification output should be machine-readable and suitable for CI.

### `sqlbraid manifest`

Generates or updates deterministic query verification metadata.

### `sqlbraid drift`

Compares compatible metadata artifacts where useful.

---

## 13. Language server

The language server should focus on high-value tooling that does not require owning a full SQL compiler.

Priority:

- SQLBraid/TypeScript diagnostics;
- directive diagnostics;
- declared/verified contract hover;
- query fingerprint/verification status;
- table/column/routine completion when schema metadata is available;
- snapshot/manifest reload;
- stale-analysis suppression;
- cancellation;
- bounded project caches.

Advanced SQL semantic navigation is optional and must be evidence-backed.

---

## 14. Package direction

Retain as first-class product packages:

- `@sqlbraid/core`
- `@sqlbraid/template`
- `@sqlbraid/runtime`
- `@sqlbraid/postgres`
- `@sqlbraid/mysql`
- `@sqlbraid/sqlite`
- `@sqlbraid/schema`
- `@sqlbraid/operations`
- `@sqlbraid/compiler`
- `@sqlbraid/cli`
- `@sqlbraid/language-server`

`@sqlbraid/ast` is transitional and should survive only if it has a narrow, durable responsibility after the pivot.

Avoid creating more packages without a clear user-facing or architectural boundary.

---

## 15. Testing strategy

### 15.1 Fast tests

Vitest unit tests should cover:

- directive parsing/rendering;
- lazy evaluation;
- bind ordering;
- trim behavior;
- fragment/list/identifier safety;
- runtime cardinality;
- transaction state;
- codecs/type policy;
- compiler transform/source maps;
- manifest determinism.

### 15.2 Real databases

Use Testcontainers for PostgreSQL/MySQL and native `node:sqlite` for SQLite.

Real DB tests are the preferred oracle for:

- driver behavior;
- transaction semantics;
- result normalization;
- prepare/describe capabilities;
- database-assisted contract verification;
- database-specific codecs.

### 15.3 Packed consumers

Continue validating actual packed packages with:

- publint;
- Are The Types Wrong;
- external ESM consumer;
- TypeScript resolution;
- subpath exports;
- CLI executable;
- supported Node engine metadata.

---

## 16. Security and correctness rules

Non-negotiable:

- ordinary interpolation is always bound;
- structural SQL requires explicit helpers;
- `sql.raw()` is explicit and documented as trusted/unsafe;
- dynamic directives never reach the database;
- no hidden value stringification into SQL;
- transaction ownership is physical-resource scoped;
- poisoned connections are not reused;
- unsupported verification never becomes fabricated proof;
- `unknown` is preferable to a false claim;
- generated code must preserve source semantics and source maps.

---

## 17. Product roadmap

### Phase A — Scope pivot and API simplification

Goal: make the implementation match this product definition.

- make explicit result contracts the primary typed path;
- remove mandatory SQL semantic inference from normal checking;
- retire old external-parity planning artifacts;
- stop treating `@sqlbraid/ast` as a growing dialect compiler;
- simplify compiler diagnostics around directives/contracts/manifests;
- update tests to assert the new contract.

### Phase B — Core authoring/runtime release quality

- finalize `if/choose/where/set/trim` behavior;
- finalize fragment/list/identifier/raw contracts;
- driver adapter polish;
- transaction/savepoint lifecycle;
- prepared/stream behavior;
- clear error codes;
- public API documentation and examples.

### Phase C — Result contracts and runtime validation

- finalize `sql<T>` declared-contract semantics;
- expose ergonomic Standard Schema validation;
- document driver decode/type-policy behavior;
- make declared vs runtime-validated status visible.

### Phase D — Database verification and query manifests

- define manifest v1;
- implement dialect verification capability interfaces;
- PostgreSQL verification path;
- MySQL verification path;
- SQLite verification path;
- CI-friendly `sqlbraid verify`;
- offline manifest consumption.

### Phase E — Tooling

- LSP project cache;
- verification status hover;
- schema-backed completion;
- manifest drift diagnostics;
- editor integration packaging.

### Phase F — Operational/runtime extensions

- pool lease ownership;
- cancellation;
- batch/bulk/pipeline;
- COPY/LOAD DATA where justified;
- routing/retry only with explicit semantics;
- OpenTelemetry;
- migration compatibility tooling.

### Phase G — Optional inference

Only after the core product is stable:

- database-generated contracts;
- simple static-query inference from trusted metadata;
- opt-in helpers for common cases.

This phase must not recreate a universal SQL semantic compiler.

---

## 18. v1 release definition

SQLBraid v1 is ready when a TypeScript developer can:

1. install the relevant SQLBraid packages;
2. write normal SQL in a tagged template;
3. use `@braid` directives for common dynamic SQL;
4. declare a result contract explicitly;
5. bind values safely across PostgreSQL/MySQL/SQLite;
6. execute queries and transactions through plain driver adapters;
7. optionally validate rows at runtime;
8. optionally verify query contracts against a real database;
9. use the compiler/CLI without requiring a live DB for ordinary development;
10. trust that unsupported analysis is reported honestly rather than guessed.

The v1 success metric is **how little SQL knowledge SQLBraid gets in the way of**, not how much SQL grammar SQLBraid can reimplement.
