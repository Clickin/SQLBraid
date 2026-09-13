# @sqlbraid/runtime

Execute SQLBraid queries with connection-safe transactions, physical lease cleanup, observers, streaming, routine mapping, and Standard Schema results.

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

Most applications should use their dialect's direct or pool database factory instead. See the [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), [routine](https://clickin.github.io/SQLBraid/concepts/routines/), and [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
