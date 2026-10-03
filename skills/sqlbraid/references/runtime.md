# Runtime scope and capabilities

Use this reference when you change transactions, sessions, streaming, prepared execution, batch or bulk behavior, or runtime semantics that depend on the adapter.

## Transactions

`db.tx(...)` pins transaction work to one physical execution resource.

```ts
await db.tx({ isolation: "serializable" }, async (tx) => {
  await tx.execute(sql.command`UPDATE accounts SET active = true WHERE id = ${id}`);
});
```

Inside the callback, use `tx` for work that belongs to the transaction. Do not use the outer `db`. The callback handle is scoped. It must not escape the callback.

A nested `tx.tx(...)` uses a savepoint only when the executor advertises savepoint support. While a savepoint is active, use the innermost handle. Do not do scoped work through a parent handle or a sibling handle.

The portable transaction options are the documented isolation literals and `readOnly`. Do not build arbitrary transaction-control SQL from application values. Do not silently map an unsupported option, unless the adapter explicitly documents that mapping.

## Sessions

`db.session(async (session) => ...)` pins one provider lease for the callback. Nested sessions use the same lease. If the adapter supports it, `session.tx(...)` does transaction work on that lease.

A provider is a source of leases. It is not always one physical connection. Root pooled operations can acquire and release leases independently. Thus, do not escape a session or a transaction through the root database.

## Streaming and overlapping work

A stream keeps its physical resource until the cursor or request cleanup. Close a scoped stream before you start transaction or savepoint work that needs the same pinned resource. Do not correct a scope error with a second connection. A second connection changes the guarantee.

## Batch and bulk

`batch` is not a portable atomicity boundary. If atomicity is important, execute the batch in `db.tx(...)`.

`bulk` is homogeneous DML for commands only. It is not a transaction. If all items must share a transaction, use `tx.bulk(...)`. Do not promise auto-chunking or a native bulk mechanism, unless the capability evidence of the selected adapter shows it.

## Capability discipline

Treat these items as adapter capabilities: transactions, savepoints, pinned sessions, streaming, cancellation, prepared queries, bulk modes, routine support and parameter hints.

When a capability is unavailable, keep the explicit unsupported behavior of SQLBraid. Do not add a fallback that silently makes pinning, atomicity, cancellation, result-kind or cleanup semantics weaker.
