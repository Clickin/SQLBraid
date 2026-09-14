# @sqlbraid/runtime

Execute SQLBraid queries with connection-safe transactions, physical lease cleanup, observers, streaming, routine mapping, homogeneous bulk, and Standard Schema results.

```sh
npm install @sqlbraid/runtime @sqlbraid/sqlite
```

```ts
import { DatabaseSync } from "node:sqlite";
import { createDatabase } from "@sqlbraid/runtime";
import { createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

const native = new DatabaseSync(":memory:");
try {
  const db = createDatabase(createNodeSqliteExecutor(native));
  for await (const row of db.stream(sql.rows<{ value: number }>`SELECT ${1} AS value`)) {
    console.log(row.value);
  }
} finally {
  native.close();
}
```

`db.all()` intentionally materializes a readonly array; use `db.stream()` for bounded application memory. Stream cleanup closes/drains/cancels the driver resource before releasing or discarding the physical lease. `db.call()` consumes and closes routine resources before mapping `output`, heterogeneous `resultSets`, and optional `returnValue`; raw cursor/request objects never escape.

`db.bulk(inputs, factory)` is a command-only throughput primitive: the runtime
locks one logical DML shape, validates every parameter set before I/O, acquires
one lease, and delegates one matrix to the driver's optional `bulk()` method.
Empty input performs no acquire. Root bulk has no portable transaction or
auto-chunking promise; use `db.tx(async (tx) => tx.bulk(inputs, factory))` for
callback atomicity. Drivers report `native-bulk`, `pipeline`, `prepared-loop`,
or `remote-batch`; an executor without this capability fails explicitly.

Most applications should use their dialect's direct or pool database factory instead. See the [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), [routine](https://clickin.github.io/SQLBraid/concepts/routines/), and [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
