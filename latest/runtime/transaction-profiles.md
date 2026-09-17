# Transaction option capabilities

> Fixed transaction options, physical scope, and driver evidence.

This page describes the current option boundary; it is not a speculative
transaction-profile API. SQLBraid keeps dialect, driver, execution runtime, and
host as separate axes:

1. **Dialect** — SQL surface, lexical profile, quoting, and database semantics.
2. **Driver** — protocol bridge, placeholders, materialization, and cleanup.
3. **Runtime** — lease ownership, session pinning, transaction/savepoint scope.
4. **Host** — Node, Bun, Deno, browser, or Worker evidence.

Use the fixed public options:

```ts
await db.tx({ isolation: "serializable", readOnly: true }, async (tx) => {
  await tx.execute(query);
});
```

`isolation` accepts only `read-uncommitted`, `read-committed`,
`repeatable-read`, or `serializable`; `readOnly` is a separate boolean. The
runtime validates JavaScript values before acquiring a lease. Malformed values
are `TypeError` / `BRAID_TX_OPTIONS_INVALID`. A valid option not advertised by
the selected adapter is `UnsupportedFeatureError` /
`BRAID_TX_OPTION_UNSUPPORTED`, with feature `transaction.isolation.<level>` or
`transaction.read-only`. Nested explicit options, including `{}`, are
`BRAID_TX_OPTIONS_NESTED`. A driver without transactions uses
`BRAID_TX_UNSUPPORTED`.

Omitted options preserve the actual physical connection/session default. The
runtime maps fixed literals through adapter-owned control SQL and never
interpolates arbitrary JavaScript text. A dialect name never implies an
isolation capability. `db.session(callback)` pins one provider lease;
transaction work inside the session reuses it and does not reacquire.

### Bun.SQL MySQL/MariaDB access modes

Both `readOnly: true` and `readOnly: false` are unsupported and reject before
I/O with `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`. Native
Bun 1.3.14 can retain a failed read-only statement shape on the same connection
after rollback and an explicit read-write begin. SQLBraid cannot safely
restore that connection by changing transaction SQL or switching connections
inside a pinned session, so contaminated reservations are discarded.
Native errno 1792 / SQLSTATE 25006 marks the reservation for disposal after
its owning scope's normal commit/rollback, not replacement inside that scope.
The environment condition is `bun-sql.mysql-read-only-cache`.

Omitting `readOnly` still preserves the native session default; it does not
force read-write. Transaction isolation and numeric/representation-profile
options are unchanged. This restriction is specific to the Bun.SQL
MySQL/MariaDB transports, not Bun.SQL PostgreSQL or other MySQL/MariaDB drivers.

Provider/lease identity, savepoints, and uncertain cleanup are part of the
execution runtime. See [transactions](/SQLBraid/latest/runtime/transactions.md), [pools](/SQLBraid/latest/runtime/direct-pools.md), and [support evidence](/SQLBraid/latest/reference/support.md).
