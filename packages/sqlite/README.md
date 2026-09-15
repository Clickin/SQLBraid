# @sqlbraid/sqlite

SQLite dialect with Node `node:sqlite`, official SQLite WASM, and Cloudflare
D1 adapters for SQLBraid.

```sh
npm install @sqlbraid/sqlite
```

## Node `node:sqlite`

Node 22.18 or newer is required. The application creates and owns the native
database.

```ts
import { DatabaseSync } from "node:sqlite";
import { sql } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";

const native = new DatabaseSync(":memory:");
try {
  const db = createNodeSqliteDatabase(native);
  const rows = await db.all(sql.rows<{ id: string }>`
    SELECT CAST(1 AS INTEGER) AS id
  `);
  // rows[0].id is the exact decimal string "1"
} finally {
  native.close();
}
```

Node results use strings for INTEGER storage, numbers for REAL storage,
strings for TEXT, and `Uint8Array` for BLOB. Integral REAL values remain
numbers; SQLite's dynamic typing means an integer-looking value is not enough
to infer INTEGER storage.

## SQLite WASM and D1

The WASM adapter accepts an initialized official `@sqlite.org/sqlite-wasm`
OO1-style database and its initialized `sqlite3` module:

```ts
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";

const db = createSqliteWasmDatabase(wasmDatabase, { sqlite3 });
```

`wasmDatabase` and `sqlite3` are initialized and supplied by the application.
WASM preserves the same INTEGER-as-string and REAL-as-number result policy.
For D1, pass the Worker binding supplied by Cloudflare:

```ts
import { createD1Database } from "@sqlbraid/sqlite/d1";

const db = createD1Database(env.DB);
```

D1 materializes rows and supports native `batch()` for `db.bulk()`. The D1
binding has no incremental cursor, so `db.stream()` and callback `db.tx()`
are unavailable. D1 cannot guarantee full SQLite int64 fidelity because its
public row values are JavaScript numbers; use an explicit `CAST(... AS TEXT)`
when textual fidelity matters. D1 text values are strings, binary values are
`Uint8Array`, and safe integral numbers are normalized to decimal strings;
other numeric values remain JavaScript numbers.

SQLite has no stored-procedure protocol; `db.call()` is unavailable. Node and
WASM active cancellation are unavailable, while an already-aborted signal is
rejected with its reason. Transaction isolation and read-only options depend
on the selected adapter; unsupported options are rejected rather than
silently ignored. `db.bulk()` is command-only and has no implicit transaction.

SQLite `RETURNING` is a materialized row query. The Node and WASM adapters
support streaming ordinary row queries; DML-returning rows are accumulated
before delivery.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/),
[SQLite setup](https://clickin.github.io/SQLBraid/getting-started/sqlite/), and
[data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
