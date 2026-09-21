# Architecture mental model

> Understand SQLBraid's execution layers, resource ownership, and contributor boundaries before reading the implementation.

import ArchitectureFlow from "../../../components/ArchitectureFlow.astro";

SQLBraid is easiest to understand as a pipeline with deliberately narrow boundaries. The SQL text stays visible; values remain values; adapters own physical transport; runtime owns connection and scope correctness.

<ArchitectureFlow />

## The four execution layers

1. **`@sqlbraid/core`** defines the contracts: logical statements, binding SPI, executor/provider SPI, runtime API, representation policy, observers, capabilities, routines, and public errors.
2. **`@sqlbraid/template`** turns tagged templates into frozen `Query` values and renders explicit SQL structure into transport-neutral `RenderedStatement` objects.
3. **`@sqlbraid/runtime`** owns leases, pinned scopes, transaction/savepoint continuity, streaming lifetime, cancellation boundaries, result-kind checks, and application mapping.
4. **Driver adapters** translate the logical statement/binding description into a native driver call and normalize native results back into SQLBraid contracts.

### The invariant to remember

```text
segments.length
===
parameters.length + 1
```

Ordinary `${value}` interpolation is a bind value. It does not become SQL structure. Structural SQL requires an explicit helper such as `sql.ident`, `sql.fragment`, `sql.list`, `sql.join`, or the deliberate `sql.raw` escape hatch.

Placeholder syntax appears only at the binding/adapter boundary: PostgreSQL may use `$1`, MySQL `?`, Oracle `:1`, SQL Server `@p1`, while native-template transports can keep a different physical representation.

## Resource ownership is the runtime's main job

A pooled materialized query acquires a lease, performs physical I/O, releases the lease, and only then performs asynchronous Standard Schema mapping. A stream is different: its cursor/result set retains the resource until iterator cleanup finishes.

`db.session()` pins one resource without beginning a transaction. `db.tx()` begins one physical transaction on a pinned resource. Nested transactions are savepoints on that same resource, not independent transactions.

Using a root or parent handle in a way that could escape to another connection is rejected instead of silently rerouted. If transaction control or cleanup leaves a connection uncertain, SQLBraid poisons/discards the resource rather than optimistically reusing it.

## Prepared, batch, and bulk are different contracts

- `db.prepare()` locks the **logical SQLBraid shape**; it does not promise a universal server-side prepared cache.
- `db.batch()` runs several possibly different operations on one physical use/lease but is **not implicitly transactional**.
- `db.bulk()` applies one homogeneous command shape to many inputs; the adapter chooses the physical bulk strategy.

## TypePolicy is not application mapping

`TypePolicy` normalizes database/native driver values into SQLBraid's canonical JavaScript representation. Standard Schema maps that canonical representation into application/domain values. Keeping these boundaries separate is what lets runtime stay free of a universal codec framework.

## Tooling is a separate plane

The runtime packages do not depend on metadata, codegen, compiler, CLI, editor, or Vite packages. `@sqlbraid/compiler` owns source discovery/lowering; `@sqlbraid/metadata` records database evidence; `@sqlbraid/codegen` generates models from metadata plus TypePolicy; `@sqlbraid/tooling` combines positive evidence for LSP/CLI/editor features.

Missing metadata is unresolved evidence, not proof that user SQL is invalid.

## Read the source in this order

1. `packages/core/src/index.ts`: `RenderedStatement`, `Query`, `StatementBindingAdapter`, `QueryExecutor`, `ConnectionProvider`, `Database`, `SqlTag`.
2. `packages/template/src/index.ts`: `createSqlTag()` and the rendering path.
3. `packages/runtime/src/index.ts`: `createScopedDatabase()` → `prepare()` → `leaseForUse()` → `physical()` → `runPrepared()` → `finalizePhysical()` → `processRows()`.
4. Runtime `stream()`, then `session()` and `tx()`.
5. PostgreSQL's `pgStatementBinding` / `createPgExecutor()` as a reference adapter, then Oracle for a resource-heavy adapter.
6. Compiler → metadata → codegen → tooling when working on static tooling.

For the full contributor-oriented walkthrough and invariants, see the repository's [English mental model](https://github.com/Clickin/SQLBraid/blob/main/docs/mental-model.md). Driver implementers should also read the [driver-author guide](/SQLBraid/v/1.0.1/agents/driver-author.md).
