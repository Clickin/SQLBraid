# @sqlbraid/bun-sql

SQLBraid adapter for Bun's `Bun.SQL` client. Select the dialect explicitly;
the client does not infer it.

```sh
bun add @sqlbraid/bun-sql @sqlbraid/postgres
```

The application supplies the `Bun.SQL` client and chooses PostgreSQL, MySQL,
MariaDB, or SQLite with the matching dialect package. The adapter uses Bun's
native value-template transport and rejects unsupported routine, streaming, and
active-cancellation capabilities rather than simulating them.
IEEE-754 NaN and infinity values are guarded on PostgreSQL and SQLite; the
MySQL and MariaDB transports reject or coerce them and therefore declare the
special-value capability unsupported.

On MySQL/MariaDB, explicit `readOnly: true` and `readOnly: false` both fail
before I/O with `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`.
Bun 1.3.14 can retain a failed read-only statement shape on the same connection
after rollback, even after starting an explicit read-write transaction.
Omitting the option preserves the native session default; SQLBraid does not
silently reset it. Bun.SQL PostgreSQL keeps its access-mode support, and the
numeric/representation profile options are unchanged.

Poisoned reservations are discarded with the reserved client's `close()`, never
returned with `release()` and never by closing the owning pool. Custom clients
without reserved `close()` reject discard with `BRAID_RESOURCE_CLEANUP`.
For MySQL/MariaDB, native read-only rejection (errno 1792, SQLSTATE 25006)
marks the reservation for disposal after the owning scope completes its normal
commit/rollback; it never swaps connections inside that scope. The environment
records condition `bun-sql.mysql-read-only-cache`.

The application still owns the supplied pool. After work has settled, use a
positive native close timeout such as `await client.close({ timeout: 1 })`:
pinned Bun 1.3.14 can leave an unbounded graceful pool close pending after a
reservation is discarded. Pool shutdown is not transaction recovery.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) and the
[Bun SQL guide](https://bun.com/docs/runtime/sql).
