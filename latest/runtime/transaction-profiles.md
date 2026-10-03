# Transaction option capabilities

> Fixed transaction options, physical scope, and driver evidence.

This page describes the current boundary of the options. It is not a
speculative transaction-profile API. SQLBraid keeps the dialect, the driver, the
execution runtime and the host as separate axes:

1. **Dialect** — the SQL surface, lexical profile, quoting and database semantics.
2. **Driver** — the protocol bridge, placeholders, materialization and cleanup.
3. **Runtime** — lease ownership, session pinning and the scope of transactions and savepoints.
4. **Host** — Node, Bun, Deno, browser or Worker evidence.

Use the fixed public options:

```ts
await db.tx({ isolation: "serializable", readOnly: true }, async (tx) => {
  await tx.execute(query);
});
```

`isolation` accepts only `read-uncommitted`, `read-committed`,
`repeatable-read` or `serializable`. `readOnly` is a separate boolean. The
runtime validates JavaScript values before it acquires a lease.

- Malformed values are `TypeError` / `BRAID_TX_OPTIONS_INVALID`.
- A valid option that the selected adapter does not advertise is
  `UnsupportedFeatureError` / `BRAID_TX_OPTION_UNSUPPORTED`, with the feature
  `transaction.isolation.<level>` or `transaction.read-only`.
- Nested explicit options, including `{}`, are `BRAID_TX_OPTIONS_NESTED`.
- A driver without transactions uses `BRAID_TX_UNSUPPORTED`.

Omitted options keep the actual default of the physical connection or session.
The runtime maps the fixed literals through control SQL that the adapter owns.
It never interpolates arbitrary JavaScript text. A dialect name never implies an
isolation capability. `db.session(callback)` pins one provider lease.
Transaction work inside the session uses the same lease and does not acquire
again.

### Bun.SQL MySQL/MariaDB access modes

Both `readOnly: true` and `readOnly: false` are unsupported. They reject before
I/O with `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`.

Native Bun 1.3.14 can keep the shape of a failed read-only statement on the same
connection after a rollback and an explicit read-write begin. SQLBraid cannot
safely restore that connection. It cannot change the transaction SQL or change
the connection inside a pinned session. Thus, contaminated reservations are
discarded.

Native errno 1792 / SQLSTATE 25006 marks the reservation for disposal after the
normal commit or rollback of its owning scope. The reservation is not replaced
inside that scope. The environment condition is `bun-sql.mysql-read-only-cache`.

If you omit `readOnly`, the native session default stays. It does not force
read-write. Transaction isolation and the numeric and representation-profile
options do not change. This restriction applies only to the Bun.SQL MySQL and
MariaDB transports. It does not apply to Bun.SQL PostgreSQL or to other MySQL
and MariaDB drivers.

Provider and lease identity, savepoints and uncertain cleanup are part of the
execution runtime. Read [transactions](/SQLBraid/latest/runtime/transactions.md), [pools](/SQLBraid/latest/runtime/direct-pools.md) and [support evidence](/SQLBraid/latest/reference/support.md).
