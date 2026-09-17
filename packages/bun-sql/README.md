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

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) and the
[Bun SQL guide](https://bun.com/docs/runtime/sql).
