# @sqlbraid/sqlite

SQLite SQL dialect, Node `node:sqlite` adapter, and metadata inspector for SQLBraid.

```sh
npm install @sqlbraid/sqlite
```

```ts
import { DatabaseSync } from "node:sqlite";
import { sql } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";

const native = new DatabaseSync(":memory:");
const db = createNodeSqliteDatabase(native, { integerMode: "bigint" });
const query = sql.rows<{ id: bigint }>`SELECT id FROM users`;
```

`integerMode` is `"number"` by default and may be set to `"bigint"` so SQLite INTEGER results are read as `bigint`; choose the matching `typePolicyForIntegerMode` for metadata/codegen. Streaming uses `StatementSync.iterate()` and closes the iterator before the database resource is considered reusable.

SQLite has no stored-procedure protocol in this adapter. `db.call()` fails with `BRAID_CALL_UNSUPPORTED`. Scalar, aggregate, and window functions registered through SQLite's function API are used inside ordinary SQL; virtual-table/table-valued extensions are ordinary `sql.rows(...)` queries, not routine calls.

See the [SQLite setup](https://clickin.github.io/SQLBraid/getting-started/sqlite/), [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).
