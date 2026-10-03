# Architecture mental model

> Learn the execution layers, resource ownership and contributor boundaries of SQLBraid before you read the implementation.

import ArchitectureFlow from "../../../components/ArchitectureFlow.astro";

SQLBraid is a pipeline with narrow boundaries. This is intentional.

- The SQL text stays visible.
- Values stay values.
- Adapters own the physical transport.
- The runtime owns the correctness of connections and scopes.

<ArchitectureFlow />

## The four execution layers

1. **`@sqlbraid/core`** defines the interfaces: logical statements, the binding SPI, the executor and provider SPI, the runtime API, the representation policy, observers, capabilities, routines and public errors.
2. **`@sqlbraid/template`** turns tagged templates into frozen `Query` values. It renders explicit SQL structure into `RenderedStatement` objects that do not depend on the transport.
3. **`@sqlbraid/runtime`** owns leases, pinned scopes, the continuity of transactions and savepoints, the lifetime of streams, cancellation boundaries, result-kind checks and application mapping.
4. **Driver adapters** translate the logical statement and binding description into a native driver call. They normalize the native results back into SQLBraid types.

### The invariant to remember

```text
segments.length
===
parameters.length + 1
```

An ordinary `${value}` interpolation is a bind value. It does not become SQL structure. Structural SQL requires an explicit helper, such as `sql.ident`, `sql.fragment`, `sql.list` or `sql.join`. `sql.raw` is the deliberate escape hatch.

Placeholder syntax occurs only at the binding and adapter boundary. PostgreSQL can use `$1`, MySQL `?`, Oracle `:1` and SQL Server `@p1`. Native-template transports can keep a different physical representation.

## Resource ownership is the main job of the runtime

A pooled materialized query does these steps:

1. It acquires a lease.
2. It does the physical I/O.
3. It releases the lease.
4. Only then does it do the asynchronous Standard Schema mapping.

A stream is different. Its cursor or result set keeps the resource until the iterator cleanup is complete.

`db.session()` pins one resource. It does not begin a transaction. `db.tx()` begins one physical transaction on a pinned resource. Nested transactions are savepoints on that same resource. They are not independent transactions.

If a use of a root or parent handle could escape to a different connection, SQLBraid rejects it. SQLBraid does not silently route it to a different connection. If transaction control or cleanup leaves a connection in an uncertain state, SQLBraid poisons or discards the resource. It does not reuse it optimistically.

## Prepared, batch and bulk have different rules

- `db.prepare()` locks the **logical SQLBraid shape**. It does not promise a universal server-side prepared cache.
- `db.batch()` runs several operations on one physical use or lease. The operations can be different. A batch is **not a transaction**.
- `db.bulk()` applies one homogeneous command shape to many inputs. The adapter selects the physical bulk strategy.

## TypePolicy is not application mapping

`TypePolicy` normalizes database and native driver values into the canonical JavaScript representation of SQLBraid. Standard Schema maps that canonical representation into application and domain values. These boundaries stay separate. Thus, the runtime does not need a universal codec framework.

## Tooling is a separate plane

The runtime packages do not depend on metadata, codegen, compiler, CLI, editor or Vite packages.

- `@sqlbraid/compiler` owns source discovery and lowering.
- `@sqlbraid/metadata` records database evidence.
- `@sqlbraid/codegen` generates models from metadata and TypePolicy.
- `@sqlbraid/tooling` combines positive evidence for LSP, CLI and editor features.

Missing metadata is unresolved evidence. It does not prove that user SQL is invalid.

## Read the source in this order

1. `packages/core/src/`: `statement.ts` (`RenderedStatement`), `query.ts` (`Query`), `binding.ts` (`StatementBindingAdapter`), `executor.ts` (`QueryExecutor`, `ConnectionProvider`), `database.ts` (`Database`), `authoring.ts` (`SqlTag`). `index.ts` only re-exports.
2. `packages/template/src/`: `tag.ts` (`createSqlTag()`) and `render.ts` (the rendering path).
3. `packages/runtime/src/index.ts`: `createScopedDatabase()` → `prepareObserved()` → `prepare()`. Then `operations/materialized.ts`: `runPrepared()` → `leaseForUse()` → `physical()` → `finalizePhysical()` → `processRows()`.
4. The runtime `stream()`, then `session()` and `tx()`.
5. The PostgreSQL `pgStatementBinding` / `createPgExecutor()` as a reference adapter. Then Oracle, as an adapter with many resources.
6. Compiler → metadata → codegen → tooling, when you work on static tooling.

For the full walkthrough and the invariants for contributors, read the [English mental model](https://github.com/Clickin/SQLBraid/blob/main/docs/mental-model.md) in the repository. Driver implementers must also read the [driver-author guide](/SQLBraid/v/1.0.2/agents/driver-author.md).
