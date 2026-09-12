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

It exists for developers who want to keep writing SQL as SQL while gaining the ergonomics normally missing from driver-level database access:

- safe parameter binding;
- readable inline dynamic SQL;
- explicit result contracts;
- optional one-row result mapping and transformation;
- plain JavaScript/TypeScript results;
- transaction and execution helpers;
- first-party PostgreSQL, MySQL, and SQLite adapters;
- optional database metadata/code-generation tooling.

The primary authoring surface is a tagged template:

```ts
const query = sql.rows<UserRow>`
  SELECT u.id, u.name, u.email
  FROM users u

  /*@braid where*/
    /*@braid if ${name != null}*/
      AND u.name = ${name}
    /*@braid end*/
  /*@braid end*/

  ORDER BY u.id
`;
```

SQLBraid should make this style pleasant and safe **without turning into a universal SQL compiler, ORM, or validation framework**.

---

## 1. Product thesis

### 1.1 SQL stays SQL

Do not replace SQL with a fluent query-builder language.

Good:

```ts
sql.rows<User>`
  SELECT id, name
  FROM users
  WHERE status = ${status}
`;
```

The product should reward existing SQL knowledge instead of making developers translate SQL into a TypeScript AST API.

### 1.2 Dynamic SQL belongs in the SQL flow

The v1 directive set is intentionally small:

- `if`
- `choose`
- `when`
- `otherwise`
- `where`
- `set`
- `trim`

Conditions are TypeScript expressions. Do not introduce a second expression language such as OGNL.

### 1.3 The database owns SQL semantics

SQLBraid must not reproduce complete PostgreSQL/MySQL/SQLite grammar, function catalogs, operator systems, casts, coercions, extensions, or user-defined routine semantics.

The broad SQL AST/resolver was removed in PV3 and must stay out of the core product path.

### 1.4 Explicit contracts are the default

For v1, application code normally declares the expected row shape:

```ts
interface UserRow {
  id: number;
  name: string;
}

const query = sql.rows<UserRow>`SELECT id, name FROM users`;
```

This declaration is developer-owned. SQLBraid does not claim that SQL text was statically proved to produce `UserRow`.

### 1.5 Result mapping is a core feature

Database representation and application representation often differ.

Examples:

```text
VARCHAR(14) yyyyMMddHHmmss -> Temporal.PlainDateTime
TEXT JSON                  -> typed object
json/jsonb                  -> validated domain object
legacy string code          -> application enum/value object
```

SQLBraid should support this without inventing its own result-map DSL.

The v1 result-mapping SPI is **Standard Schema**.

### 1.6 Metadata tooling is optional and separate

Database introspection/code generation is useful, but it is not required for ordinary SQLBraid execution.

The intended separation is:

```text
runtime/compiler                      optional development tooling
----------------                      ----------------------------
SQL + @braid                          database inspection
explicit result contract              metadata snapshot
result mapper                         code generation
execution                             editor completion
```

Do not make runtime/compiler depend on codegen or live database metadata.

---

## 2. Non-goals for pre-release/v1

The following are explicitly not pre-release/v1 goals:

- being an ORM;
- replacing SQL with a query builder;
- implementing complete SQL grammars;
- maintaining SQL function/operator catalogs;
- automatic arbitrary SQL-to-TypeScript result inference;
- proving every dynamic SQL combination at compile time;
- multi-row object-graph assembly comparable to ORM eager mapping;
- a SQLBraid-specific validation/schema language;
- hard dependency on Valibot, Zod, ArkType, or another validation implementation;
- application-level input mapping/encoding;
- a built-in DB prepare verifier as a core runtime/compiler requirement;
- behavioral parity with another TypeScript database product.

Input mapping is deliberately deferred until after the pre-release boundary. JavaScript database drivers do not provide a JDBC-like universal input type system, so a general application-value encoding layer would require substantially broader policy decisions.

---

## 3. Core authoring contract

### 3.1 Ordinary interpolation is binding

```ts
sql`WHERE id = ${id}`;
```

must produce a driver placeholder and bound value. Ordinary values never become SQL structure.

### 3.2 Structural interpolation is explicit

Use dedicated helpers:

```ts
sql.ident(name)
sql.fragment`...`
sql.raw(text)
sql.empty
sql.join(parts, separator)
sql.list(values)
```

`sql.raw()` is an explicit trusted/unsafe escape hatch.

### 3.3 Query result kinds are explicit

Canonical query tags:

```ts
sql.rows<Row>`...`
sql.command`...`
sql.call<Row>`...`
sql`...` // unknown
```

The bare generic `sql<Row>` shorthand is not supported.

Adapters report the **actual** database result kind. Runtime compares it to the declaration:

```text
rows    -> actual rows required
command -> actual command required
unknown -> rows or command accepted
```

`BRAID_RESULT_KIND` is a post-execution assertion. It does not undo side effects; use a transaction when a mismatch must roll back writes.

---

## 4. Dynamic SQL model

### 4.1 Guarded interpolation

JavaScript evaluates template interpolations before calling a tag. Therefore lazy guarded expressions require the compiler transform.

Generated code must:

- be hygienic;
- preserve lexical `this`;
- preserve evaluation order;
- evaluate active expressions once;
- avoid evaluating inactive branches;
- preserve TypeScript control-flow narrowing;
- preserve source maps and directive prologues.

### 4.2 Rendering helpers, not theorem proving

`where`, `set`, and `trim` are deterministic rendering helpers.

They do not need to prove every possible branch produces semantically valid SQL. SQLBraid must not enumerate exponential variant spaces by default.

---

## 5. Result contract and mapping model

### 5.1 Declared row contract

```ts
const query = sql.rows<UserRow>`SELECT ...`;
```

means:

> The application declares `UserRow` as the application-facing row type.

No runtime row validation or transformation occurs unless a mapper/schema is attached.

### 5.2 Official Standard Schema dependency

SQLBraid depends on:

```text
@standard-schema/spec
```

for protocol types only.

SQLBraid must not maintain a private clone of the Standard Schema protocol and must not depend on a concrete validator implementation.

Users may choose any compatible implementation, including Valibot, Zod, ArkType, or their own Standard Schema implementation.

### 5.3 Query-bound result mapping

The canonical mapped-row form is:

```ts
const query = sql.rows(UserSchema)`
  SELECT id, created_at AS "createdAt", payload
  FROM events
`;
```

where `UserSchema` implements Standard Schema and its **output type** becomes the query row type.

Conceptually:

```text
driver row
   ↓
Dialect TypePolicy normalization
   ↓
plain normalized row
   ↓
query-bound Standard Schema
validate + transform
   ↓
application row
```

This is SQLBraid's v1 equivalent of the useful single-row portion of a result mapper/TypeHandler system.

### 5.4 Mapper scope is exactly one row to one row

The result mapper may:

- validate fields;
- transform field values;
- reshape one row into another object;
- parse JSON/text values;
- create application-level temporal/value objects;
- run asynchronously if the Standard Schema implementation supports async validation.

It does **not** perform multi-row identity merging, association collection assembly, entity lifecycle, lazy relations, or ORM graph construction.

### 5.5 Execution-level schema remains supported

PV4 already supports:

```ts
await db.all(query, { schema: ExtraSchema });
```

The processing order is:

```text
normalized raw row
   ↓
query-bound result mapper, if present
   ↓
execution-level schema, if present
   ↓
returned application row
```

The execution-level schema is additive; it must not silently disable the query-bound mapper.

### 5.6 Error contract

Runtime mapping/validation issues use SQLBraid's stable validation error and preserve zero-based row position where available.

SQLBraid-created error messages must not include raw rows or bound values by default.

Validator-provided issue objects may contain user data; SQLBraid does not rewrite third-party issues.

### 5.7 Application input mapping is deferred

PV5 does not add an application-level input mapper.

Current input behavior remains:

```text
application value
   ↓
ordinary bind `${value}`
   ↓
dialect/driver encode boundary
```

Future input mapping must be justified by concrete use cases after pre-release. Do not force artificial symmetry with result mapping.

---

## 6. Dialect TypePolicy vs result mapper

These are distinct layers.

### TypePolicy

Dialect/driver primitive normalization, for example:

```text
PostgreSQL int8 string -> bigint
numeric                -> configured primitive representation
```

TypePolicy is dialect-level infrastructure.

### Result mapper

Application semantic transformation, for example:

```text
"20260912191500" -> Temporal.PlainDateTime
JSON string       -> typed domain object
```

Result mapping is query/model-level infrastructure.

Do not put application semantics into dialect TypePolicy merely because the source column has a recognizable database type.

---

## 7. Runtime

Core execution surface:

```ts
db.all(query)
db.one(query)
db.maybeOne(query)
db.execute(query)
db.call(query)
db.batch(queries)
db.prepare(name, factory)
db.stream(query)
db.transaction(callback)
```

Rows are plain JavaScript values after normalization/mapping.

Runtime requirements retained from PV4:

- discriminated row/command execution results;
- central declared-vs-actual result-kind enforcement;
- routine calls excluded from generic execute/batch;
- cardinality checked before validation for `one`/`maybeOne`;
- streaming validation/mapping row-by-row without full buffering;
- physical-resource transaction ownership;
- savepoint nesting where supported;
- poison uncertain connections after transaction-control cleanup failure.

Future pool support must lease a physical connection for the full transaction lifetime.

---

## 8. Compiler responsibility

The compiler owns:

1. SQLBraid tag discovery through TypeScript symbols;
2. `@braid` directive parsing;
3. hygienic guarded lowering;
4. TypeScript control-flow preservation;
5. source maps/diagnostic ranges;
6. preservation of declared row/result-mapper type information through lowering;
7. project-aware SQLBraid diagnostics.

The compiler does not own:

- complete SQL parsing;
- result-column inference from arbitrary SQL;
- function/operator semantics;
- database coercion rules;
- Standard Schema implementation logic.

Schema-bound row tags survive compiler lowering without losing mapper identity or output typing; schema expressions execute exactly once in tag-expression order.

---

## 9. Database metadata and code generation

The existing `@sqlbraid/schema` package currently represents database metadata snapshots. The name becomes confusing once Standard Schema is a public result-mapping concept.

### PV6 direction

Rename/reframe:

```text
@sqlbraid/schema -> @sqlbraid/metadata
```

before public pre-release if package compatibility allows.

Metadata is used for:

- table/column/routine introspection;
- TypePolicy/codegen support;
- editor completion;
- drift tooling.

Ordinary query execution and result mapping must not require metadata snapshots.

### PV7 code generation

Add optional:

```text
@sqlbraid/codegen
```

as development tooling analogous to database model generation.

Initial scope is deterministic table metadata → TypeScript models, for example:

```ts
export interface UsersRow { ... }
export interface UsersInsert { ... }
export interface UsersUpdate { ... }
```

Do not infer arbitrary JOIN/projection query result types in the first codegen release.

---

## 10. Database verification

A prepare/describe verifier is **not** part of the pre-release core roadmap.

If later user demand justifies it, it should be optional development tooling and must remain separate from normal runtime/compiler operation.

Any future verifier must:

- use database evidence rather than local SQL semantics;
- report partial/unknown evidence honestly;
- avoid executing writes merely to gather metadata;
- never become mandatory for ordinary SQLBraid use.

Do not implement the previously proposed core verifier PV5 plan.

---

## 11. CLI

Pre-release CLI priorities:

### `sqlbraid check`

Checks TypeScript integration, Braid directive structure, tag misuse, and compiler-transform correctness.

It does not claim to validate arbitrary SQL semantics.

### `sqlbraid build`

Emits guarded-template transforms where required.

### Metadata/codegen commands

PV6–PV8 may add/rework metadata and code-generation commands.

Current provisional `manifest`/`drift` behavior may remain while useful, but the public roadmap must not make database verification manifests a v1 requirement.

---

## 12. Language server

The language server should focus on:

- TypeScript/SQLBraid diagnostics;
- Braid directive diagnostics;
- declared row/result-mapper hover;
- table/column/routine completion when metadata is available;
- metadata reload;
- project cache/cancellation correctness.

Do not build an editor-only SQL semantic inference engine.

PV9 may integrate generated metadata/codegen information.

---

## 13. Package direction

Current first-class packages:

- `@sqlbraid/core`
- `@sqlbraid/template`
- `@sqlbraid/runtime`
- `@sqlbraid/postgres`
- `@sqlbraid/mysql`
- `@sqlbraid/sqlite`
- `@sqlbraid/compiler`
- `@sqlbraid/operations`
- `@sqlbraid/cli`
- `@sqlbraid/language-server`
- `@sqlbraid/schema` — metadata package pending PV6 rename

Dependency rule for Standard Schema:

```text
@sqlbraid/core
  -> @standard-schema/spec
```

No first-party package should require a concrete validator implementation.

Planned optional development package:

```text
@sqlbraid/codegen
```

Avoid additional packages without a clear user-facing or dependency boundary.

---

## 14. Testing strategy

### Fast tests

Vitest should cover:

- directives/rendering;
- lazy evaluation;
- bind ordering;
- trim behavior;
- structural helper safety;
- result-kind enforcement;
- cardinality;
- transaction state;
- result mapping/validation;
- compiler lowering/source maps;
- packed public types.

### Standard Schema interoperability

PV5 must include interoperability coverage for at least:

- the official Standard Schema protocol type contract;
- Valibot;
- Zod.

These validator libraries are test/dev dependencies only unless already required elsewhere.

### Real databases

Use Testcontainers PostgreSQL/MySQL and native `node:sqlite` for actual adapter semantics.

Result mapping is above the dialect boundary and should behave identically after driver normalization.

### Packed consumers

Continue validating:

- publint;
- Are The Types Wrong;
- external ESM consumer;
- TypeScript resolution;
- subpath exports;
- CLI/language-server binaries;
- Node engine metadata;
- no monorepo path leakage.

---

## 15. Security and correctness rules

Non-negotiable:

- ordinary interpolation is always bound;
- structural SQL requires explicit helpers;
- `sql.raw()` is explicit trusted/unsafe SQL;
- dynamic directives never reach the database;
- no hidden value stringification into SQL;
- result mapper output comes only from the chosen Standard Schema implementation;
- no SQLBraid-created validation error should dump raw rows/binds by default;
- transaction ownership is physical-resource scoped;
- poisoned resources are not reused;
- unsupported analysis becomes unknown, not fabricated proof;
- generated code preserves source semantics/maps.

---

## 16. Roadmap

### PV1 — Explicit query/result-kind contracts ✅

- `sql.rows<Row>`;
- `sql.command`;
- `sql.call<Row>`;
- bare `sql` is unknown.

### PV2 — Compiler semantic inference removal ✅

- compiler narrowed to TypeScript/Braid responsibilities;
- no schema/SQL semantic inference in normal checking.

### PV3 — Broad SQL AST removal ✅

- parser/resolver package removed;
- no replacement SQL lexer package.

### PV4 — Runtime result-kind enforcement + execution-time Standard Schema validation ✅

- discriminated execution results;
- centralized kind checking;
- optional `{ schema }` validation;
- transaction/prepared/stream integration.

### PV5 — Query-bound result mapping via Standard Schema ✅

- adopt official `@standard-schema/spec` types;
- remove SQLBraid's private Standard Schema protocol clone;
- add `sql.rows(schema)` mapped-row authoring;
- infer row type from Standard Schema output;
- store mapper on the query;
- automatically validate/transform execute/all/one/maybeOne/batch/stream/prepared and transaction results;
- compose query-bound mapper before execution-level `{ schema }`;
- preserve mapper through compiler guarded lowering;
- Valibot/Zod interoperability tests;
- no input mapper.

### PV6 — Metadata package cleanup **NEXT**

- rename/reframe `@sqlbraid/schema` to `@sqlbraid/metadata`;
- remove stale verification-oriented naming where appropriate;
- preserve inspectors, snapshot determinism, and drift functionality.

### PV7 — Optional `@sqlbraid/codegen`

- metadata → `Row`/`Insert`/`Update` TypeScript models;
- deterministic generation;
- dialect TypePolicy-aware primitive mapping;
- no arbitrary SELECT/JOIN inference requirement.

### PV8 — Codegen CLI and overrides

- naming policy;
- custom type mapping overrides;
- include/exclude filters;
- generated-file stability;
- offline regeneration from checked-in metadata where useful.

### PV9 — LSP metadata/codegen integration

- metadata-backed completion/hover;
- generated-model navigation where useful;
- bounded project caches/cancellation.

### PV10 — Pre-release/Product Hunt hardening

- five-minute quickstart;
- result mapping examples;
- package surface cleanup;
- Node 22/current Node CI matrix;
- packed consumer gates;
- docs/examples aligned with actual API;
- release notes and Product Hunt messaging.

### Post-pre-release candidates

Only after the public core is stable:

- application-level input mapping/codecs;
- optional prepare/describe DB verifier tooling;
- pool lease infrastructure;
- transaction-internal concurrency policy;
- cancellation;
- bulk/pipeline/COPY/LOAD DATA;
- routing/retry with explicit semantics;
- OpenTelemetry;
- additional codegen helpers.

---

## 17. Pre-release definition

SQLBraid is ready for public pre-release when a TypeScript developer can:

1. install a first-party dialect package;
2. write normal SQL in tagged templates;
3. use `@braid` for common dynamic SQL;
4. declare rows explicitly with `sql.rows<Row>`;
5. optionally attach a Standard Schema result mapper with their validator library of choice;
6. safely bind values across PostgreSQL/MySQL/SQLite;
7. execute rows, commands, calls, transactions, prepared queries, and streams through stable runtime APIs;
8. optionally generate TypeScript table models from database metadata without coupling codegen to runtime;
9. use compiler/CLI/LSP without a live DB for ordinary authoring;
10. trust that SQLBraid does not fabricate database-semantic precision.

The success metric is **how little SQLBraid gets in the way of SQL while providing strong TypeScript boundaries around it**.
