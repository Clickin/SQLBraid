# @sqlbraid/sqlite

SQLite SQL dialect, Node `node:sqlite`, Browser WASM, Cloudflare D1 adapters,
and metadata inspector for SQLBraid.

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

For a direct browser/worker SQLite database, use the WASM subpath with the
official `@sqlite.org/sqlite-wasm` OO1-style database object:

```ts
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";

const db = createSqliteWasmDatabase(wasmDatabase);
```

The WASM adapter owns one direct database resource and supports query, native
row iteration, callback transactions, and prepare-once bulk execution. It does
not create a pool or rely on an async-context polyfill. Keep conflicting root
operations out of an active transaction or stream.

Cloudflare D1 uses a structural binding interface and remains the SQLite
dialect:

```ts
import { createD1Database } from "@sqlbraid/sqlite/d1";

const db = createD1Database(env.DB);
```

D1 materialized queries use its public result metadata, ordered `?1`, `?2`, …
binds, and native `batch()` for `db.bulk()` (`remote-batch`). D1 has no
incremental row cursor in the Worker Binding API, so `db.stream()` is
`BRAID_STREAM_UNSUPPORTED`; callback `db.tx()` is also unsupported. The adapter
does not paginate to simulate streaming, auto-chunk bulk input, or claim remote
production support from a local Worker/D1 test.

SQLite has no stored-procedure protocol in this adapter. `db.call()` fails with `BRAID_CALL_UNSUPPORTED`. Scalar, aggregate, and window functions registered through SQLite's function API are used inside ordinary SQL; virtual-table/table-valued extensions are ordinary `sql.rows(...)` queries, not routine calls.

`db.bulk()` is command-only and has no portable atomicity promise. Use
`db.tx(async (tx) => tx.bulk(...))` on adapters that support callback
transactions. SQLite `RETURNING` remains a materialized row contract; its
output is accumulated before rows are delivered, so DML-returning streaming is
not a bounded-memory support claim.

See the [SQLite setup](https://clickin.github.io/SQLBraid/getting-started/sqlite/), [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).
