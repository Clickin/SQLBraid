---
title: Transactions and savepoints
description: Pin one physical connection and make transaction scope explicit.
---

`db.tx` is the connection-pinning boundary:

```ts
await db.tx(async (tx) => {
  await tx.execute(sql.command`
    INSERT INTO audit_log (account_id) VALUES (${accountId})
  `);
  await tx.execute(sql.command`
    UPDATE accounts SET active = true WHERE id = ${accountId}
  `);
});
```

Every `tx.*` operation in the callback reuses one physical connection until commit or rollback. Use the callback handle—not the outer `db`—for all work inside the transaction. The callback handle is closed after the closure returns.

Nested `tx` calls use savepoints when the executor supports them:

```ts
await db.tx(async (tx) => {
  await tx.execute(first);
  await tx.tx(async (nested) => {
    await nested.execute(second);
    // Throwing here rolls back this savepoint.
  });
});
```

While a savepoint is active, use the innermost handle. Parent or sibling use fails with `BRAID_TX_SCOPE`. A transaction stream must be closed before opening a savepoint; overlapping pinned work fails rather than moving to another connection.

## Isolation default

SQLBraid 0.1.0 does **not** expose an isolation option and does not silently choose one. The transaction uses the database/driver connection's existing default isolation behavior. Explicit isolation setup is database-specific: PostgreSQL permits `SET TRANSACTION` as the first `tx` operation, before any query; MySQL requires transaction-characteristic setup before the transaction begins. Configure the same owned physical connection or its session initialization, not an independent pooled root operation that may use another connection. SQLite does not share this `SET TRANSACTION` syntax. Verify setup with the selected driver; do not infer isolation from a dialect name or from Node/Bun/Deno.

Batch is not atomic. Earlier statements—and later statements when result mapping fails—may already have executed. Wrap the batch in `db.tx(...)` when atomicity is required.

`db.bulk(inputs, factory)` is command-only homogeneous DML, not a replacement
for a transaction. Root bulk acquires one physical lease but has no portable
atomicity promise, is never implicitly wrapped in a transaction, and does not
auto-chunk. Use `tx.bulk(inputs, factory)` inside this callback when all items
must share the transaction:

```ts
await db.tx(async (tx) => {
  await tx.bulk(inputs, (input) => sql.command`
    UPDATE account SET amount = ${input.amount} WHERE id = ${input.id}
  `);
});
```

Drivers report the actual bulk mode (`native-bulk`, `pipeline`,
`prepared-loop`, or `remote-batch`) rather than making a cross-dialect
throughput or transaction claim. D1 currently has no callback transaction
primitive matching this contract.

An uncertain transaction-control failure poisons the physical resource. Pool cleanup discards it; a direct resource rejects further SQLBraid work. An abandoned live stream rolls back instead of committing over an active cursor.
