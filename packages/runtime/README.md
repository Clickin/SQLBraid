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

`db.batch()` preflights every item, acquires one lease, and executes homogeneous
items fail-fast. Every item that emitted `query:ready` eventually emits exactly
one terminal `query:mapped` or `query:error`; abandoned siblings use the
existing error event with `BRAID_BATCH_ABORTED` and truthful execution flags.
No abandoned item is sent to the driver or mapper, and error observers are
still given the remaining terminal events when another observer throws.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
