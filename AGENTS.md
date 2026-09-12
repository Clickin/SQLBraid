# AGENTS.md

This file defines repository-wide rules for AI coding agents and human contributors making architectural changes to SQLBraid.

`PLAN.md` is the authoritative product plan. If implementation details, old planning artifacts, or prior assumptions conflict with `PLAN.md`, follow `PLAN.md` unless the user explicitly instructs otherwise.

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

The project is not an ORM, not a fluent-query-builder-first product, and not a parity implementation of another TypeScript database library.

Public documentation must explain SQLBraid from its own product goals.

---

## 2. Architecture priority order

When multiple designs are possible, prefer them in this order:

1. preserve SQL-first authoring;
2. preserve safe bound parameters;
3. keep dynamic SQL readable and local;
4. use explicit application contracts where SQL meaning is opaque;
5. use Standard Schema for one-row result validation/transformation instead of inventing a mapper DSL;
6. keep dialect adapters thin;
7. keep normal development usable offline;
8. keep metadata/codegen optional and outside runtime/compiler dependencies;
9. prefer deletion/simplification over maintaining partial SQL semantics;
10. add automatic inference only when evidence is cheap and trustworthy.

A smaller honest feature is usually preferable to broad heuristic inference.

---

## 3. Do not build a universal SQL compiler

Do not expand SQLBraid into a complete local implementation of:

- PostgreSQL grammar;
- MySQL grammar;
- SQLite grammar;
- function catalogs;
- extension catalogs;
- operator overload systems;
- cast/coercion systems;
- arbitrary routine semantics;
- every version-specific dialect edge case.

PV3 removed the broad SQL AST package and semantic resolver. Keep it removed.

Before adding SQL parser/resolver complexity, ask:

> Can this requirement be solved with an explicit row contract, a Standard Schema result mapper, driver metadata, optional codegen, or a narrow lexical check?

If yes, use the smaller mechanism.

---

## 4. Type and result-mapping strategy

### 4.1 Explicit result contracts are primary

The v1 typed path is:

```ts
sql.rows<UserRow>`SELECT ...`;
```

The developer owns the correspondence between the SQL result and `UserRow` unless runtime mapping/validation is attached.

Do not reintroduce SQL-driven row inference to prove this contract.

### 4.2 Query-bound result mapping uses Standard Schema

Query-bound mapping uses:

```ts
sql.rows(UserSchema)`SELECT ...`;
```

where `UserSchema` implements Standard Schema and its **output type** becomes the query row type.

The pipeline is:

```text
driver row
  -> dialect TypePolicy normalization
  -> plain normalized row
  -> query-bound Standard Schema
  -> application row
```

This mapper may validate and transform one row into one application value.

Do not build a SQLBraid-specific result-map DSL when Standard Schema can express the requirement.

### 4.3 Use the official protocol dependency

SQLBraid must use:

```text
@standard-schema/spec
```

for Standard Schema types.

Use the official protocol interfaces; do not maintain a private clone.

Do not make Valibot, Zod, ArkType, or another concrete validator a runtime dependency of SQLBraid core packages.

Users choose their implementation.

### 4.4 One row to one row only

Result mapping may:

- validate;
- transform fields;
- parse JSON/text;
- create temporal/domain values;
- reshape a single row;
- run asynchronously when supported by the schema implementation.

It must not turn SQLBraid into an ORM graph assembler.

Do not add:

- identity maps;
- multi-row association merging;
- collection hydration across rows;
- entity lifecycle;
- lazy relations.

### 4.5 Execution-level schema is additive

PV4 supports:

```ts
await db.all(query, { schema: ExtraSchema });
```

When a query-bound mapper exists, processing order is:

```text
query-bound mapper
  -> execution-level schema
```

The execution option must not silently bypass the query's own mapper.

### 4.6 Input mapping is deferred

Do not implement application-level input mapper/codecs before pre-release unless the user explicitly changes the roadmap.

Ordinary `${value}` remains a normal bound value handled by dialect/driver encoding.

JavaScript database drivers do not expose a JDBC-like universal application-input type contract, so do not force artificial symmetry with result mapping.

### 4.7 Untyped means unknown

If there is no declared/generated contract, use `unknown`, not `any` or guessed precision.

---

## 5. Dynamic SQL rules

The directive namespace is `/*@braid ...*/`.

Supported v1 directives:

- `if`
- `choose`
- `when`
- `otherwise`
- `where`
- `set`
- `trim`

Conditions are TypeScript expressions. Do not introduce OGNL or another expression language.

### Guarded interpolation

JavaScript evaluates template expressions before a tag call, so guarded laziness requires the compiler transform.

Generated code must:

- be hygienic;
- preserve lexical `this`;
- preserve evaluation order;
- evaluate active expressions once;
- avoid evaluating inactive branches;
- preserve TypeScript control-flow narrowing;
- preserve source maps/directive prologues;
- preserve query-bound result mapper identity and output typing.

### SQL correctness

`where`, `set`, and `trim` are rendering helpers, not theorem provers.

Do not add exponential dynamic-variant proof requirements.

---

## 6. Binding and structural SQL

Ordinary interpolation is always a bound parameter:

```ts
sql`WHERE id = ${id}`;
```

Structural SQL requires explicit APIs:

```ts
sql.ident(...)
sql.fragment`...`
sql.list(...)
sql.join(...)
sql.raw(...)
```

`sql.raw()` is a trusted/unsafe escape hatch.

Security regressions here are release blockers.

---

## 7. Query-result-kind invariants

Canonical tags:

```ts
sql.rows<Row>`...`
sql.command`...`
sql.call<Row>`...`
sql`...` // unknown
```

Adapters report the actual rows/command result from database/driver evidence.

Runtime enforces declared-vs-actual kind centrally.

A mismatch is detected **after execution**. Do not claim it prevents write side effects. Use transactions when rollback on mismatch matters.

Routine calls use `db.call()` and do not enter generic execute/batch paths.

---

## 8. Dialect boundaries

First-party dialects are PostgreSQL, MySQL, and SQLite.

Dialect packages own only genuinely dialect-specific concerns:

- placeholder syntax;
- identifier quoting;
- lexical details needed by Braid scanning;
- driver integration;
- TypePolicy primitive normalization;
- transaction/savepoint control;
- actual result normalization;
- optional metadata inspection.

Do not place application semantic transforms such as compact-date parsing or domain-object construction into dialect TypePolicy.

A new database should not require compiler grammar expansion.

---

## 9. Metadata and codegen boundaries

Database metadata tooling is optional development tooling.

Current `@sqlbraid/schema` represents database metadata snapshots. PV6 plans to rename/reframe it as `@sqlbraid/metadata` before public pre-release.

PV7 plans optional `@sqlbraid/codegen` for deterministic table metadata -> TypeScript models.

Initial codegen scope is table-oriented `Row`/`Insert`/`Update` generation, not arbitrary SELECT/JOIN inference.

Runtime/compiler/template must not depend on codegen.

---

## 10. Database verification is not a pre-release core goal

Do not implement the previously proposed core prepare/describe verifier roadmap unless the user explicitly revives it.

If a verifier is added later, it should be optional development tooling using real database evidence and must not become mandatory for ordinary SQLBraid execution.

---

## 11. Runtime invariants

Keep these invariants unless explicitly changed:

- rows/results are plain JavaScript values;
- execution results are discriminated rows/command unions;
- result-kind declarations are centrally enforced;
- query-bound mapping/validation occurs above adapter normalization;
- cardinality checks happen before `one`/`maybeOne` validation;
- streaming validation/mapping is row-by-row without full buffering;
- root execution is serialized per physical resource where required;
- a transaction owns its physical resource for its lifetime;
- root work cannot leak into another transaction;
- nested transactions use savepoints where supported;
- leaked transaction handles fail;
- failed transaction-control cleanup poisons the physical resource;
- poisoned resources are not silently reused.

Pool support must preserve physical lease ownership.

Transaction-internal concurrency needs an explicit policy before it is advertised as supported.

---

## 12. Compiler responsibilities

Good compiler responsibilities:

- discover SQLBraid tags through TypeScript symbols;
- parse Braid directives;
- lower guarded control flow hygienically;
- preserve source locations/maps;
- preserve explicit/result-schema contracts through lowering;
- issue SQLBraid-specific diagnostics.

Avoid complete SQL semantic resolution.

Remove obsolete analysis code rather than preserving dead complexity for hypothetical reuse.

---

## 13. LSP rules

The language server shares compiler/tooling logic.

Prioritize:

- TypeScript/SQLBraid diagnostics;
- directive diagnostics;
- declared/mapped row hover;
- metadata-backed completion;
- metadata reload;
- project cache/cancellation correctness.

Do not implement an editor-only SQL inference engine.

---

## 14. Testing requirements

### Fast tests

Use Vitest.

Unit tests should normally use source aliases and must not require Docker unless they are explicit DB projects.

### Standard Schema interoperability

Standard Schema interoperability coverage must retain:

- official `@standard-schema/spec` typing;
- Valibot interoperability;
- Zod interoperability;
- synchronous transform;
- asynchronous transform;
- failure issues;
- query-bound + execution-level composition;
- compiler guarded lowering of schema-bound queries.

Valibot/Zod are test/dev dependencies only.

### Real DB tests

Use:

- Testcontainers PostgreSQL;
- Testcontainers MySQL;
- native `node:sqlite`.

Real DB tests are required for actual driver/database behavior.

### Package tests

Retain packed external-consumer validation:

- `publint`;
- Are The Types Wrong;
- root/subpath ESM imports;
- TypeScript resolution;
- CLI executable;
- language-server executable;
- Node engine metadata;
- no monorepo path leakage.

### Required commands

Before calling substantial work complete, run the applicable full gate:

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

If DB/Docker tests cannot run, report them as not run rather than passing.

---

## 15. Repository/package discipline

- Node runtime floor is `>=22.18.0` unless explicitly changed.
- Keep ESM as default package format.
- Keep package exports narrow.
- Use `@standard-schema/spec` as a normal dependency where public declaration files require it, but import it type-only in runtime source when possible.
- Do not bundle validator implementations into SQLBraid packages.
- Do not accidentally bundle TypeScript or database drivers into packages that expect external dependencies.
- Preserve CLI/language-server shebangs and packed executable tests.
- Use tsdown for package builds and `tsc --noEmit` for semantic type checking.

---

## 16. Change discipline

For broad work:

1. inspect current HEAD;
2. read `PLAN.md`;
3. reproduce the problem when practical;
4. make the smallest architecture change satisfying the product contract;
5. add behavior-focused tests;
6. update docs for public behavior changes;
7. remove obsolete paths rather than keeping parallel implementations;
8. report exact commands/tests run.

Do not publish/tag/release/force-push unless explicitly requested.

Do not mutate non-test databases.

---

## 17. Public positioning

SQLBraid stands on its own product story.

Do not frame the repository as:

- a clone;
- a parity project;
- a drop-in replacement for another TypeScript library;
- a clean-room reproduction measured against another project's feature list.

The core public message is:

> **Write SQL. Keep TypeScript.**

Result mapping should be explained as:

> Use any Standard Schema-compatible library to validate and transform database rows into application models.

Do not market one validator implementation as mandatory.

---

## 18. Final decision rule

When a feature increases parser/compiler/runtime framework complexity substantially, stop and evaluate whether the product truly needs it.

Prefer, in order:

1. explicit row contract;
2. query-bound Standard Schema result mapper;
3. execution-level Standard Schema validation;
4. optional metadata/codegen;
5. driver/database evidence when a future tooling feature truly needs it;
6. narrow lexical/static checks;
7. only then additional SQL semantic analysis.

Complexity is not a feature. SQLBraid should remain useful because SQL stays SQL and application mapping uses existing ecosystem protocols instead of another proprietary DSL.
