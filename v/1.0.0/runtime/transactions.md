# Transactions and savepoints

> Pin one physical connection and make transaction scope explicit.

`db.tx` is the connection-pinning boundary:

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

For a read-only query, use a separate transaction with `readOnly: true` and
only row-producing statements:

```ts
// canonical-example: read-only-query
await db.tx({ readOnly: true }, async (tx) => {
  const accounts = await tx.all(sql.rows`
    SELECT id, active FROM accounts WHERE id = ${accountId}
  `);
  console.log(accounts);
});
```

Every `tx.*` operation in the callback reuses one physical connection until
commit or rollback. Use the callback handle—not the outer `db`—for all work
inside the transaction. The callback handle closes after the callback returns.

Nested `tx` calls use savepoints when the executor advertises
`transaction.savepoint`:

```ts
await db.tx(async (tx) => {
  await tx.execute(first);
  await tx.tx(async (nested) => {
    await nested.execute(second);
    // Throwing here rolls back this savepoint.
  });
});
```

While a savepoint is active, use the innermost handle. Parent or sibling use is
rejected with the runtime scope error. A transaction stream must close before
opening a savepoint; overlapping pinned work fails instead of moving to another
connection.

## Sessions and physical leases

`db.session(async (session) => ...)` pins one provider lease for its entire
callback. Nested sessions reuse that lease, and `session.tx(...)` inside a session
uses it without reacquiring. The outer root database cannot escape the session.
A provider is a lease source, not a physical connection; root pooled operations
acquire, execute, release, then map materialized results. A stream holds its
lease until cursor/request cleanup. An unavailable session primitive rejects
with `BRAID_SESSION_UNSUPPORTED`.

Close a session's stream before calling `session.tx(...)`. An overlapping
transaction rejects with `BRAID_STREAM_SCOPE` before `BEGIN`, without waiting
for the stream or acquiring another lease. Wrapping a transaction in
`tx.session(...)` does not relax its innermost transaction/savepoint scope.

## Transaction options

The portable options are deliberately fixed:

```ts
type TransactionIsolation = "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";

interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}
```

The runtime maps these literals to adapter-owned transaction control. It never
interpolates arbitrary JavaScript text into `BEGIN`/`SET TRANSACTION`, and it
never silently changes an omitted option. Omitted options preserve the actual
connection/session default. A malformed JavaScript value rejects before lease
acquisition with `TypeError` / `BRAID_TX_OPTIONS_INVALID`. A valid but
unsupported isolation or access mode rejects with `UnsupportedFeatureError` /
`BRAID_TX_OPTION_UNSUPPORTED`, whose feature identifies
`transaction.isolation.<level>` or `transaction.read-only`.

When transactions are unavailable, `BRAID_TX_UNSUPPORTED` is used. Nested
explicit options, including `{}`, reject with `BRAID_TX_OPTIONS_NESTED`; they
cannot change an active transaction. Adapters may map PostgreSQL
`read-uncommitted` to its documented `read-committed` behavior only when their
capability evidence says so. SQLite, D1, and other drivers expose only the
combinations their transport actually honors.

Bun.SQL MySQL/MariaDB reject both explicit `readOnly` values before I/O with
`BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`; omission preserves
the native session default. This does not restrict Bun.SQL PostgreSQL.
See [transaction option capabilities](/SQLBraid/v/1.0.0/runtime/transaction-profiles.md)
for the native Bun 1.3.14 connection-contamination boundary.

The libSQL adapter preserves transaction continuity through its interactive
`Transaction` handle rather than issuing `BEGIN`/`COMMIT` on ordinary client
calls. `readOnly: true` maps to libSQL's documented read mode; the portable
isolation literals are rejected because libSQL transaction modes are not
automatic equivalents. Ordinary libSQL calls do not guarantee a pinned
session, so `session.pinned` remains unsupported.

## Batch and bulk

`batch` is not atomic. Earlier statements—and later statements when mapping
fails—may already have executed. Wrap it in `db.tx(...)` when atomicity matters.

`batch([])` returns `[]` without acquiring or releasing a lease and emits no
query lifecycle events. Execution-option checks still apply: an already-aborted
signal rejects with its original reason before the no-op result.

`db.bulk(inputs, factory)` is command-only homogeneous DML, not a transaction.
Root bulk uses one lease but has no portable atomicity or auto-chunking promise.
Use `tx.bulk(inputs, factory)` inside the callback when every item must share the
transaction. Drivers report the actual mode (`native-bulk`, `pipeline`,
`prepared-loop`, or `remote-batch`).

An uncertain transaction-control failure poisons the physical resource. Pool
cleanup discards it; a direct resource rejects further SQLBraid work. An
abandoned live stream rolls back instead of committing over an active cursor.
