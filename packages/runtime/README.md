# @sqlbraid/runtime

Runtime execution for SQLBraid queries, including materialized results,
transactions, sessions, prepared queries, streams, and result mapping.

```sh
npm install @sqlbraid/runtime @sqlbraid/postgres
```

A driver adapter supplies the executor or pool; the runtime does not create
connections. `db.tx()` pins one connection for its callback, and unsupported
driver capabilities (such as streaming or routine calls) are rejected rather
than simulated. Use a database-specific package for dialects and adapters.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
