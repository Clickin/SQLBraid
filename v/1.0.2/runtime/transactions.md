# Transactions and savepoints

> Pin one physical connection and make transaction scope explicit.

`db.tx` is the boundary that pins a connection:

```ts
// canonical-example: serializable-write
await db.tx({ isolation: "serializable" }, async (tx) => {
  await tx.execute(sql.command`
    INSERT INTO audit_log (account_id) VALUES (${accountId})
  `);
  await tx.execute(sql.command`
    UPDATE accounts SET active = true WHERE id = ${accountId}
  `);
});
```

For a read-only query, use a separate transaction with `readOnly: true`. Use
only statements that produce rows:

```ts
// canonical-example: read-only-query
await db.tx({ readOnly: true }, async (tx) => {
  const accounts = await tx.all(sql.rows`
    SELECT id, active FROM accounts WHERE id = ${accountId}
  `);
  console.log(accounts);
});
```

Each `tx.*` operation in the callback uses the same physical connection until
the commit or the rollback. For all work inside the transaction, use the
callback handle. Do not use the outer `db`. The callback handle closes after the
callback returns.

When the executor advertises `transaction.savepoint`, nested `tx` calls use
savepoints:

```ts
await db.tx(async (tx) => {
  await tx.execute(first);
  await tx.tx(async (nested) => {
    await nested.execute(second);
    // Throwing here rolls back this savepoint.
  });
});
```

While a savepoint is active, use the innermost handle. A use of a parent or a
sibling handle is rejected with the runtime scope error. Close a transaction
stream before you open a savepoint. Overlapping pinned work fails. It does not
move to a different connection.

## Sessions and physical leases

`db.session(async (session) => ...)` pins one provider lease for its complete
callback.

- Nested sessions use the same lease.
- `session.tx(...)` inside a session uses the lease without acquiring again.
- The outer root database cannot escape the session.
- A provider is a source of leases. It is not a physical connection. Root
  pooled operations acquire, execute, release and then map materialized results.
- A stream keeps its lease until the cursor or request cleanup.
- If the session primitive is unavailable, the call rejects with
  `BRAID_SESSION_UNSUPPORTED`.

Close the stream of a session before you call `session.tx(...)`. An overlapping
transaction rejects with `BRAID_STREAM_SCOPE` before `BEGIN`. It does not wait
for the stream and does not acquire another lease. If you wrap a transaction in
`tx.session(...)`, the innermost transaction or savepoint scope stays the same.

## Transaction options

The portable options are fixed. This is intentional:

```ts
type TransactionIsolation = "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";

interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}
```

The runtime maps these literals to transaction control that the adapter owns.

- It never interpolates arbitrary JavaScript text into `BEGIN` or
  `SET TRANSACTION`.
- It never silently changes an omitted option. Omitted options keep the actual
  connection or session default.
- A malformed JavaScript value rejects before lease acquisition with
  `TypeError` / `BRAID_TX_OPTIONS_INVALID`.
- A valid but unsupported isolation or access mode rejects with
  `UnsupportedFeatureError` / `BRAID_TX_OPTION_UNSUPPORTED`. Its feature
  identifies `transaction.isolation.<level>` or `transaction.read-only`.

If transactions are unavailable, the code is `BRAID_TX_UNSUPPORTED`. Nested
explicit options, including `{}`, reject with `BRAID_TX_OPTIONS_NESTED`. They
cannot change an active transaction. An adapter can map PostgreSQL
`read-uncommitted` to its documented `read-committed` behavior only when its
capability evidence says so. SQLite, D1 and other drivers expose only the
combinations that their transport actually obeys.

Bun.SQL MySQL and MariaDB reject both explicit `readOnly` values before I/O,
with `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`. If you omit the
option, the native session default stays. This does not restrict Bun.SQL
PostgreSQL. For the native connection-contamination boundary of Bun 1.3.14,
read [transaction option capabilities](/SQLBraid/v/1.0.2/runtime/transaction-profiles.md).

The libSQL adapter keeps transaction continuity through its interactive
`Transaction` handle. It does not send `BEGIN`/`COMMIT` on ordinary client
calls. `readOnly: true` maps to the documented read mode of libSQL. The portable
isolation literals are rejected, because libSQL transaction modes are not
automatic equivalents. Ordinary libSQL calls do not guarantee a pinned session.
Thus, `session.pinned` stays unsupported.

## Batch and bulk

`batch` is not atomic. Earlier statements can already have executed. If mapping
fails, later statements can also have executed. When atomicity is important,
wrap the batch in `db.tx(...)`.

`batch([])` returns `[]`. It does not acquire or release a lease and emits no
query lifecycle events. The execution-option checks still apply: an
already-aborted signal rejects with its original reason before the no-op result.

`db.bulk(inputs, factory)` is homogeneous DML for commands only. It is not a
transaction. Root bulk uses one lease, but it has no portable promise of
atomicity or automatic chunking. If all items must share the transaction, use
`tx.bulk(inputs, factory)` inside the callback. Drivers report the actual mode:
`native-bulk`, `pipeline`, `prepared-loop` or `remote-batch`.

An uncertain failure of transaction control poisons the physical resource. Pool
cleanup discards it. A direct resource rejects all further SQLBraid work. An
abandoned live stream rolls back. It does not commit over an active cursor.
