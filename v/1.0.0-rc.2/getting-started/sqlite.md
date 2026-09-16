# Five-minute SQLite quickstart

> Run your first SQLBraid query with Node's built-in SQLite driver.

This path uses Node `>=22.18.0` and `node:sqlite`; no database server is required. The first query is a plain tagged template and needs no SQLBraid compiler. The second adds dynamic `@braid` and uses the shipped lowering command.

## Choose the SQLite adapter

The SQLite dialect is shared, but the physical adapter is selected by subpath:

| Subpath | Physical boundary | Important limits |
| --- | --- | --- |
| `sqlbraid/node-sqlite` | Node `DatabaseSync` / `StatementSync` | synchronous physical calls; exact INTEGER strings; native `iterate()` stream |
| `sqlbraid/better-sqlite3` | better-sqlite3 statements | synchronous and event-loop blocking; statement-local `safeIntegers(true)`; native iteration |
| `sqlbraid/libsql` | `@libsql/client` | requires `intMode: "string"`; interactive transactions; no pinned session or stream fallback |
| `sqlbraid/sqlite-wasm` | SQLite WASM OO1 | OO1 statement ownership; async-generator adaptation for streams |
| `sqlbraid/d1` | Cloudflare D1 | prepared binds; no streaming or callback transactions |

The public `Database` API remains async for every adapter. `Awaitable<T>` is
only the physical `QueryExecutor` SPI type that lets synchronous adapters
return plain results without Promise wrappers; it does not make
better-sqlite3 non-blocking.

:::note Verification status
The [runtime and driver support matrix](/SQLBraid/v/1.0.0-rc.2/reference/support.md) records
labels for the exact database/driver/profile/runtime/capability tuple and its
revision and workflow evidence. A neighboring version or package installation
is not certification. Final exact-SHA Runtime, Docs, and Release gates and
explicit release authorization remain separate requirements; this page does not
authorize npm publication.
:::


## 1. Create a project

```bash
mkdir braid-sqlite && cd braid-sqlite
npm init -y
npm pkg set type=module
npm install sqlbraid
npm install --save-dev typescript @types/node@22
mkdir src
```

## 2. Run one simple query

Create `src/index.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
try {
  native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  native.prepare("INSERT INTO users (name) VALUES (?)").run("Ada");

  const db = createNodeSqliteDatabase(native);
  const requestedId = 1;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name FROM users WHERE id = ${requestedId}
  `);
  console.log(users);
} finally {
  native.close();
}
```

Node 22.18.0 can run this erasable TypeScript directly:

```bash
node src/index.ts
```

The output is a row array such as `[{ id: "1", name: "Ada" }]`. The requested ID is a driver-bound value, not interpolated SQL text.

The node:sqlite adapter renders the logical statement to text with `?`
placeholders, then uses the documented `DatabaseSync.prepare(text)` and
`StatementSync` APIs. Materialization and hint validation happen before any
statement execution. Reuse is adapter-owned when configured; SQLBraid does not
invoke `SQLTagStore` through an undocumented callable path.

## 3. Add dynamic @braid and lower it

Replace the `requestedId` declaration and query block in `src/index.ts` with this one:

```ts
const requestedId: number | undefined = 1;
const users = await db.all(sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${requestedId !== undefined}*/
      AND id = ${requestedId}
    /*@braid end*/
  /*@braid end*/
`);
console.log(users);
```

Build the TypeScript source with SQLBraid's compiler lowering, then run the emitted JavaScript:

```bash
npm install --save-dev @sqlbraid/cli
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```

The compiler lowers the guarded template into `build/index.js`. `@braid where` emits `WHERE` only when a child emits SQL and removes a leading `AND`/`OR`. The condition is evaluated before the guarded value; inactive branch expressions are not evaluated. The requested ID remains an ordinary SQLite bind.

## What happened

1. `DatabaseSync` owns the in-memory SQLite resource.
2. `createNodeSqliteDatabase(native)` adapts that physical resource to SQLBraid's runtime.
3. `sql.rows<UserRow>` declares that the statement returns rows shaped like `UserRow`.
4. An ordinary value becomes a driver bind (`?` for SQLite), never SQL text.
5. The compiler preserves the dynamic template's lazy guarded evaluation.

For a write, use `sql.command` and `db.execute`. For exactly one row, use `db.one`; it throws a cardinality error unless the result contains one row. See [SQL tags and result kinds](/SQLBraid/v/1.0.0-rc.2/concepts/sql-tags.md).

:::caution Node SQLite support
`node:sqlite` is the first-party SQLite adapter used by this release. INTEGER
storage is read through native int64 transport and exposed by SQLBraid as a
canonical decimal string; REAL storage remains a JavaScript `number`. This
internal transport detail is not a public integer mode. The adapter does not
support routine calls; streaming uses `StatementSync.iterate()`. SQLite
scalar/aggregate/window functions are ordinary SQL functions, and
virtual-table/table-valued extensions are ordinary SQL queries, not stored
procedures.
:::

## SQLite representation profile

`node:sqlite` is a Node runtime API, not a server version. The profile records
Node and the SQLite library bundled by Node.

| SQLite surface | Profile representation | Status/caveat |
| --- | --- | --- |
| INTEGER storage | string | Canonical exact decimal text; native bigint is internal transport only. |
| REAL storage | JavaScript `number` | SQLite binary64 approximate value. |
| `STRICT` tables | SQLite-native affinity enforcement | A schema feature, not a SQLBraid parser guarantee. |
| non-STRICT tables / `ANY` | SQLite dynamic values | The returned representation follows the stored value and driver. |
| JSON1 | text | Parse/validate JSON text with Standard Schema. |
| BLOB | `Buffer`/bytes | Keep binary or explicitly encode it. |
| `RETURNING` | materialized rowset | Output is accumulated before delivery; DML-returning streaming is not claimed. |

The native binding uses `?` placeholders and `StatementSync`; `iterate()` is
the stream primitive and a prepared loop is the bulk strategy. SQLite has no
stored-procedure transport, so registered functions and table-valued
extensions remain ordinary SQL row queries. Native SQLite SQL passes through
without grammar rewriting; transparency is not grammar support. Exact integer
strings and proven bigint transport are bind details, while `undefined` ordinary
IN values fail before acquisition with `BRAID_BIND_VALUE_UNSUPPORTED` and
`null` is SQL `NULL`. Arrays and other nested/container values remain
unclassified unless a storage-class-specific test proves them.

### better-sqlite3

```ts
import Database from "better-sqlite3";
import { createBetterSqlite3Database, sql } from "sqlbraid/better-sqlite3";

const native = new Database(":memory:");
const db = createBetterSqlite3Database(native);
const rows = await db.all(sql.rows`SELECT 1 AS value`);
```

SQLBraid applies `safeIntegers(true)` per statement and exposes exact INTEGER
values as decimal strings. `iterate()` is the real stream primitive and bulk
uses a prepared loop. Native calls block the event loop; use a worker when
that matters. Routines and active cancellation are unsupported.

### libSQL

```ts
import { createClient } from "@libsql/client";
import { createLibsqlDatabase, sql } from "sqlbraid/libsql";

const client = createClient({ url: "file:app.db", intMode: "string" });
const db = createLibsqlDatabase(client, { intMode: "string" });
const rows = await db.all(sql.rows`SELECT 1 AS value`);
```

The explicit `intMode: "string"` option is required because SQLBraid cannot
infer an opaque client's integer mode. Transactions use libSQL's interactive
transaction handle; ordinary calls do not claim one pinned session. The
adapter uses native `batch()` for bulk and rejects `db.stream()` with
`BRAID_STREAM_UNSUPPORTED` rather than buffering a complete result.
The SQLite inspector defaults to `introspectionScope: "main"`: metadata capture
does not inspect attached schemas, and missing fields must not be read as proof
that indexes or constraints are absent. better-sqlite3 and libSQL targets are
compatible pending exact runtime/driver evidence, not certified by analogy.
Omitted or
empty transaction options call `client.transaction()` without a mode;
`readOnly: false` selects `"write"`. The local `@libsql/client@0.18.0` file
transport emits `BEGIN TRANSACTION READONLY` but does not enforce writes, so
SQLBraid reports read-only as guarded and rejects `readOnly: true` before
beginning. Opaque clients without a transport protocol receive the same guard;
remote transports that expose and enforce the documented `"read"` mode retain
that option. better-sqlite3 accepts `Uint8Array` bind views and converts them
to `Buffer` immediately before native calls.
