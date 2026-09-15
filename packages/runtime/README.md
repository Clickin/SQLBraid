# @sqlbraid/runtime

Runtime execution for SQLBraid queries: materialized rows, command results,
transactions, sessions, prepared queries, streams, routine mapping, batches,
and homogeneous bulk execution.

```sh
npm install @sqlbraid/runtime @sqlbraid/sqlite
```

A driver adapter supplies the executor. This example uses the Node SQLite
adapter; the native database is created and owned by the application.

```ts
import { DatabaseSync } from "node:sqlite";
import { createDatabase } from "@sqlbraid/runtime";
import { createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

const native = new DatabaseSync(":memory:");
try {
  const db = createDatabase(createNodeSqliteExecutor(native));
  const rows = await db.all(sql.rows<{ value: number }>`
    SELECT CAST(1.5 AS REAL) AS value
  `);
  // rows is readonly and rows[0].value is the JavaScript number 1.5
} finally {
  native.close();
}
```

`createDatabase(executor)` is for one executor. Driver packages also expose
pool factories that use `createPooledDatabase` internally. Applications supply
the underlying connection, pool, or worker binding; the runtime never creates
one for them.

`db.all()` returns a readonly materialized array. `db.one()` requires exactly
one row, and `db.maybeOne()` returns one row or `undefined`. `db.execute()`
returns either a row result or a command result according to the query kind.
`db.batch()` executes a fixed list, while `db.bulk()` accepts one command shape
and many input values. `db.session()` pins a lease for its callback and
`db.tx()` runs callback-scoped transactions and savepoints where the adapter
provides them.

`db.prepare(name, factory)` creates a reusable zero-input or one-input
prepared query. A factory with several independent arguments is not accepted;
pass one object when a query needs multiple input fields. `db.stream()` is
available only when the selected adapter exposes a stream. `db.call()` maps
routine output only when that adapter exposes a routine contract; the runtime
does not add routine, cursor, or output-parameter support to a driver that lacks
it.

An already-aborted signal is rethrown with its reason. Active cancellation is
performed only when the selected adapter has a cancellation path; otherwise it
fails before I/O. Transaction isolation and `readOnly` options are likewise
validated against the selected adapter. Bulk execution is command-only and
has no implicit transaction; wrap it in `db.tx(async (tx) => tx.bulk(...))`
when the adapter supports callback transactions.

Result types come from the selected adapter's type policy. For example,
SQLBraid's default SQLite adapter represents INTEGER as `string`, REAL as
`number`, TEXT as `string`, and BLOB as `Uint8Array`; the runtime preserves
those values while enforcing the query's declared row type.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/),
[streaming guide](https://clickin.github.io/SQLBraid/runtime/streaming/), and
[routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).
