# @sqlbraid/runtime

Execute SQLBraid queries with connection-safe transactions, observers, and result mapping.

```sh
npm install @sqlbraid/runtime @sqlbraid/sqlite
```

```ts
import { createDatabase } from "@sqlbraid/runtime";
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

const native = new DatabaseSync(":memory:");
try {
  const db = createDatabase(createNodeSqliteExecutor(native));
  console.log(await db.all(sql.rows<{ value: number }>`SELECT ${1} AS value`));
} finally {
  native.close();
}
```

This is the low-level executor boundary. Most applications should use their
dialect's direct or pool database factory instead. See the
[SQLBraid documentation](https://clickin.github.io/SQLBraid/).
