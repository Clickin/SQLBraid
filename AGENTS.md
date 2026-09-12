# AGENTS.md

This file defines repository-wide rules for AI coding agents and human contributors making architectural changes to SQLBraid.

`PLAN.md` is the authoritative product plan. If implementation details, old planning artifacts, or prior assumptions conflict with `PLAN.md`, follow `PLAN.md` unless the user explicitly instructs otherwise.

---

## 1. Product identity

SQLBraid is a **SQL-first data-access toolkit for TypeScript**.

The product is built around this developer experience:

```ts
const query = sql<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
  /*@braid end*/
`;
```

The project is not an ORM and does not make a fluent TypeScript query builder the primary authoring model.

The project is also **not a parity implementation of another library**. Do not describe roadmap work as catching up with, cloning, matching, or reproducing another TypeScript database product.

Public-facing documentation should explain SQLBraid from its own product goals.

---

## 2. Architecture priority order

When multiple designs are possible, prefer them in this order:

1. preserve SQL-first authoring;
2. preserve safe bound parameters;
3. keep dynamic SQL readable and local;
4. use explicit TypeScript contracts where SQL meaning is opaque;
5. ask the real database for database-specific truth when verification is needed;
6. keep dialect adapters thin;
7. keep normal development usable offline;
8. prefer deletion/simplification over maintaining a partial SQL compiler;
9. add automatic inference only when evidence is cheap and trustworthy.

A solution that provides less automatic inference but is simpler and honest is usually preferable to a broad heuristic inference engine.

---

## 3. Do not build a universal SQL compiler

Do not expand SQLBraid into a complete local implementation of:

- PostgreSQL grammar;
- MySQL grammar;
- SQLite grammar;
- function catalogs;
- extension function catalogs;
- operator overload systems;
- cast/coercion systems;
- arbitrary routine semantics;
- every version-specific dialect edge case.

Before adding SQL parser/resolver complexity, ask:

> Can this requirement be solved with an explicit result contract, runtime validation, driver metadata, database-assisted verification, or a smaller lexical check?

If yes, use the smaller mechanism.

The existing `@sqlbraid/ast` package is transitional. Do not grow it by inertia. Its long-term scope must be justified by the revised `PLAN.md`.

---

## 4. Type strategy

### 4.1 Explicit result contracts are primary

The v1 typed authoring path is an explicit result contract:

```ts
sql<UserRow>`SELECT ...`;
```

Do not require SQLBraid to infer every custom function/operator result before users can write SQLBraid external reference.

### 4.2 Untyped means unknown

If there is no declared or generated contract, prefer `unknown` over fabricated precision.

Never use `any` as the fallback for failed inference.

### 4.3 Declaration and verification are different

A TypeScript declaration is not automatically database proof.

Keep these concepts separate:

- declared contract;
- runtime-validated contract;
- database-verified contract;
- generated contract.

Do not label something “verified” unless an actual verifier supplied evidence.

### 4.4 Automatic inference is optional

Automatic SQL result inference is a convenience feature, not the foundation of the product.

Only add or retain inference when:

- evidence is deterministic;
- implementation cost is bounded;
- dialect/version behavior is trustworthy;
- unsupported cases fail closed cleanly.

Do not maintain large heuristic systems solely to increase inference coverage percentages.

---

## 5. Dynamic SQL rules

The supported directive namespace is `/*@braid ...*/`.

Keep the language deliberately small:

- `if`
- `choose`
- `when`
- `otherwise`
- `where`
- `set`
- `trim`

Do not introduce an expression language such as OGNL. Conditions are TypeScript expressions.

### Guarded interpolation

JavaScript evaluates template interpolations before a tag call. Therefore guarded lazy expressions require the compiler transform.

Generated code must:

- be hygienic;
- preserve lexical `this`;
- preserve evaluation order;
- evaluate active interpolations once;
- avoid evaluating inactive branches;
- preserve TypeScript control-flow narrowing;
- preserve source maps and directive prologues.

Do not pretend a bare runtime tag can provide laziness it cannot provide.

### SQL correctness

`where`, `set`, and `trim` are deterministic rendering helpers. They do not need to prove the full database semantics of every possible branch combination.

Do not introduce exponential structural proof as a default requirement.

---

## 6. Binding and structural SQL

Ordinary interpolation is always a bound parameter:

```ts
sql`WHERE id = ${id}`;
```

Never concatenate ordinary values into SQL text.

Structural SQL must use explicit APIs:

```ts
sql.ident(...)
sql.fragment`...`
sql.list(...)
sql.join(...)
sql.raw(...)
```

`sql.raw()` is a trusted/unsafe escape hatch. Do not make raw structural interpolation implicit.

Security regressions in this area are release blockers.

---

## 7. Dialect boundaries

First-party dialects are PostgreSQL, MySQL, and SQLite.

Dialect packages should own only the responsibilities that genuinely differ:

- placeholder syntax;
- identifier quoting;
- lexical details needed by template scanning;
- driver integration;
- type codecs;
- transaction/savepoint control;
- result normalization;
- optional schema inspection;
- optional verification/describe capabilities.

A new database should not require compiler-core grammar expansion as a default step.

Where database semantics differ, prefer adapter capability interfaces over core `if (dialect === ...)` branches.

---

## 8. Database-assisted verification

When database-specific semantic proof is required, prefer the real database.

Target verification architecture:

```text
source query
  -> render/known verification case
  -> dialect verifier
  -> real database metadata/result evidence
  -> deterministic query manifest
  -> offline CI/editor consumption
```

Verification must report its scope honestly.

Do not generalize one verified dynamic variant into proof for all variants unless that generalization is actually justified.

Synthetic integration databases are preferred for CI. Never mutate production databases during verification or tests.

---

## 9. Runtime invariants

Keep these invariants unless explicitly changed by the user:

- rows are plain objects;
- root execution is serialized per physical execution resource where required;
- a transaction owns its physical resource for its lifetime;
- root work cannot accidentally execute inside another transaction;
- nested transactions use savepoints when supported;
- leaked transaction handles fail;
- failed transaction-control cleanup poisons the physical resource;
- poisoned resources are not reused silently.

Pool support must preserve physical lease ownership. Do not model a transaction over a pool with unrelated per-query connections.

Transaction-internal concurrent operations need an explicit policy before being advertised as supported.

---

## 10. Compiler responsibilities

The compiler should focus on TypeScript integration, not database reimplementation.

Good compiler responsibilities:

- discover SQLBraid tagged templates through TypeScript symbols;
- parse SQLBraid directives;
- lower guarded control flow hygienically;
- preserve source locations;
- attach explicit/generated query contracts;
- read/write query manifest metadata;
- issue SQLBraid-specific diagnostics.

Avoid making the compiler responsible for complete SQL semantic resolution.

If legacy semantic-analysis code becomes unused after the pivot, remove it rather than preserving dead complexity for hypothetical future use.

---

## 11. LSP rules

The language server must share compiler/tooling logic instead of implementing its own inference engine.

Prioritize:

- TypeScript/SQLBraid diagnostics;
- directive diagnostics;
- contract/verification status hover;
- schema-backed completion when metadata exists;
- snapshot/manifest reload;
- project cache/cancellation correctness.

Do not promise rich SQL semantics that the core product no longer intends to implement locally.

---

## 12. Testing requirements

### Fast tests

Use Vitest.

Unit tests should normally run against source aliases and must not require Docker unless they are explicitly DB projects.

### Real DB tests

Use:

- Testcontainers PostgreSQL;
- Testcontainers MySQL;
- native `node:sqlite`.

Real DB tests are required for behavior that depends on actual driver/database semantics.

### Package tests

Retain packed external-consumer validation:

- `publint`;
- Are The Types Wrong;
- root/subpath ESM imports;
- TypeScript type resolution;
- CLI executable;
- supported Node engine metadata;
- no monorepo path leakage.

### Required commands

Before calling a substantial change complete, run the applicable full gate:

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

If Docker/database tests could not run, report them as not run. Do not convert unavailable infrastructure into a passing result.

---

## 13. Repository and package discipline

- Node runtime floor is currently `>=22.18.0` for published packages.
- Keep ESM as the default package format unless a concrete compatibility requirement changes it.
- Keep explicit `package.json` exports narrow.
- Keep third-party/runtime dependencies external in library builds unless there is a documented reason to bundle.
- Do not accidentally bundle TypeScript or database drivers into packages that expect them as dependencies/peers.
- Preserve CLI/language-server shebangs and packed executable tests.
- Use tsdown for package builds and `tsc --noEmit` for semantic type checking.

---

## 14. Change discipline

For broad work:

1. inspect the current HEAD, not a remembered older state;
2. read `PLAN.md`;
3. reproduce the problem before changing behavior when practical;
4. make the smallest architectural change that satisfies the product contract;
5. add behavior-focused tests;
6. update public docs if user-visible behavior changes;
7. remove obsolete paths rather than leaving parallel implementations;
8. report exact commands/tests run.

Do not perform publish/tag/release/force-push actions unless explicitly requested.

Do not mutate non-test databases.

---

## 15. Public positioning

SQLBraid must stand on its own product story.

Do not add public documentation that frames SQLBraid as:

- a clone;
- a drop-in replacement for another TypeScript library;
- a parity project;
- a clean-room reproduction of another library;
- an implementation whose success is measured against another project's feature list.

Comparisons may be discussed when explicitly requested by the user, but they are not repository goals or acceptance criteria.

The core public message is:

> **Write SQL. Keep TypeScript.**

---

## 16. Final decision rule

When a proposed feature requires a large increase in parser/compiler complexity, stop and evaluate the product value before implementing it.

Prefer, in order:

1. explicit contract;
2. runtime validator;
3. database metadata/verification;
4. narrow lexical/static check;
5. only then additional SQL semantic analysis.

Complexity is not a feature. SQLBraid should remain useful precisely because it lets the database stay the database and lets SQL stay SQL.
