# Runtime scope and capabilities

Use this reference when changing transactions, sessions, streaming, prepared execution, batch/bulk behavior, or adapter-dependent runtime semantics.

## Transactions

`db.tx(...)` pins transaction work to one physical execution resource.

```ts
await db.tx({ isolation: "serializable" }, async (tx) => {
  await tx.execute(sql.command`UPDATE accounts SET active = true WHERE id = ${id}`);
});
```

Inside the callback, use `tx`, not the outer `db`, for work that belongs to the transaction. The callback handle is scoped and must not escape.

Nested `tx.tx(...)` uses a savepoint only when the executor advertises savepoint support. While a savepoint is active, use the innermost handle; do not perform scoped work through a parent or sibling handle.

Portable transaction options are the documented isolation literals and `readOnly`. Do not construct arbitrary transaction-control SQL from application values, and do not silently map an unsupported option unless the adapter explicitly documents that mapping.

## Sessions

`db.session(async (session) => ...)` pins one provider lease for the callback. Nested sessions reuse the lease, and `session.tx(...)` performs transaction work on that lease when supported.

A provider is a lease source, not necessarily one physical connection. Root pooled operations may acquire and release independently, so do not escape a session or transaction through the root database.

## Streaming and overlapping work

A stream retains its physical resource until cursor/request cleanup. Close a scoped stream before opening transaction/savepoint work that needs the same pinned resource. Do not "fix" scope errors by acquiring a second connection; that changes the guarantee.

## Batch and bulk

`batch` is not a portable atomicity boundary. If atomicity matters, execute it in `db.tx(...)`.

`bulk` is command-only homogeneous DML and is not itself a transaction. Use `tx.bulk(...)` when every item must share a transaction. Do not promise auto-chunking or a native bulk mechanism unless the selected adapter's capability evidence says so.

## Capability discipline

Treat transactions, savepoints, pinned sessions, streaming, cancellation, prepared queries, bulk modes, routine support, and parameter hints as adapter capabilities.

When a capability is unavailable, preserve SQLBraid's explicit unsupported behavior. Do not add a fallback that silently weakens pinning, atomicity, cancellation, result-kind, or cleanup semantics.
