# Five-minute SQLite quickstart

> Run your first SQLBraid query with Node's built-in SQLite driver.

This path uses Node `>=22.18.0` and `node:sqlite`. You do not need a database server. The first query is a plain tagged template. It does not need the SQLBraid compiler. The second query adds dynamic `@braid` and uses the lowering command that ships with SQLBraid.

## Choose the SQLite adapter

All SQLite adapters share the SQLite dialect. The subpath selects the physical adapter:

| Subpath                   | Physical boundary                     | Important limits                                                                             |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `sqlbraid/node-sqlite`    | Node `DatabaseSync` / `StatementSync` | synchronous physical calls; exact INTEGER strings; native `iterate()` stream                 |
| `sqlbraid/better-sqlite3` | better-sqlite3 statements             | synchronous and event-loop blocking; statement-local `safeIntegers(true)`; native iteration  |
| `sqlbraid/libsql`         | `@libsql/client`                      | requires `intMode: "string"`; interactive transactions; no pinned session or stream fallback |
| `sqlbraid/sqlite-wasm`    | SQLite WASM OO1                       | OO1 statement ownership; async-generator adaptation for streams                              |
| `sqlbraid/d1`             | Cloudflare D1                         | prepared binds; no streaming or callback transactions                                        |

In Deno 2.9.3, the `node:sqlite` iterator turns SQLite step errors into a normal
EOF. Thus, SQLBraid rejects streaming on Deno with `BRAID_STREAM_UNSUPPORTED`.
It does not return rows that are silently truncated. Materialized queries and
transactions stay available. The native iterator of Node is not affected.

The public `Database` API stays async for all adapters. `Awaitable<T>` is only
the type of the physical `QueryExecutor` SPI. It lets synchronous adapters
return plain results without Promise wrappers. It does not make better-sqlite3
non-blocking.

:::note Verification status
The [runtime and driver support matrix](/SQLBraid/latest/reference/support.md) records
labels for each exact tuple of database, driver, profile, runtime and
capability, with its revision and workflow evidence. A neighboring version or a
package installation is not certification. The final exact-SHA Runtime, Docs
and Release gates and an explicit release authorization stay separate
requirements. This page does not authorize npm publication.
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

The output is a row array, such as `[{ id: "1", name: "Ada" }]`. The requested ID is a value that the driver binds. It is not interpolated SQL text.

The node:sqlite adapter renders the logical statement to text with `?`
placeholders. Then it uses the documented `DatabaseSync.prepare(text)` and
`StatementSync` APIs. Materialization and hint validation occur before the
statement executes. When reuse is configured, the adapter owns it. SQLBraid
does not call `SQLTagStore` through an undocumented callable path.

## 3. Add dynamic @braid and lower it

In `src/index.ts`, replace the `requestedId` declaration and the query block with this code:

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

Build the TypeScript source with the SQLBraid compiler lowering. Then run the emitted JavaScript:

```bash
npm install --save-dev @sqlbraid/cli
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```

The compiler lowers the guarded template into `build/index.js`.

- `@braid where` emits `WHERE` only when a child emits SQL. It removes a leading `AND` or `OR`.
- The condition is evaluated before the guarded value. Expressions in inactive branches are not evaluated.
- The requested ID stays an ordinary SQLite bind.

## What happened

1. `DatabaseSync` owns the in-memory SQLite resource.
2. `createNodeSqliteDatabase(native)` connects that physical resource to the SQLBraid runtime.
3. `sql.rows<UserRow>` declares that the statement returns rows with the shape of `UserRow`.
4. An ordinary value becomes a driver bind (`?` for SQLite). It never becomes SQL text.
5. The compiler keeps the lazy guarded evaluation of the dynamic template.

For a write, use `sql.command` and `db.execute`. For exactly one row, use `db.one`. It throws a cardinality error if the result does not contain exactly one row. Read [SQL tags and result kinds](/SQLBraid/latest/concepts/sql-tags.md).

:::caution Node SQLite support
`node:sqlite` is the first-party SQLite adapter of this release.

- INTEGER storage is read through native int64 transport. SQLBraid exposes it
  as a canonical decimal string. This internal transport detail is not a public
  integer mode.
- REAL storage stays a JavaScript `number`.
- The adapter does not support routine calls. Streaming uses
  `StatementSync.iterate()`.
- SQLite scalar, aggregate and window functions are ordinary SQL functions.
  Virtual-table and table-valued extensions are ordinary SQL queries. They are
  not stored procedures.
  :::

## SQLite representation profile

`node:sqlite` is a Node runtime API. It is not a server version. The profile records
Node and the SQLite library that Node bundles.

| SQLite surface            | Profile representation             | Status/caveat                                                                  |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| INTEGER storage           | string                             | Canonical exact decimal text; native bigint is internal transport only.        |
| REAL storage              | JavaScript `number`                | SQLite binary64 approximate value.                                             |
| `STRICT` tables           | SQLite-native affinity enforcement | A schema feature, not a SQLBraid parser guarantee.                             |
| non-STRICT tables / `ANY` | SQLite dynamic values              | The returned representation follows the stored value and driver.               |
| JSON1                     | text                               | Parse/validate JSON text with Standard Schema.                                 |
| BLOB                      | `Buffer`/bytes                     | Keep binary or explicitly encode it.                                           |
| `RETURNING`               | materialized rowset                | Output is accumulated before delivery; DML-returning streaming is not claimed. |

- The native binding uses `?` placeholders and `StatementSync`. `iterate()` is
  the stream primitive. The bulk strategy is a prepared loop.
- SQLite has no stored-procedure transport. Thus, registered functions and
  table-valued extensions stay ordinary SQL row queries.
- Native SQLite SQL passes through without grammar rewriting. Transparency is
  not grammar support.
- Exact integer strings and proven bigint transport are bind details.
- Ordinary `undefined` IN values fail before acquisition with
  `BRAID_BIND_VALUE_UNSUPPORTED`. `null` is SQL `NULL`.
- Arrays and other nested or container values stay unclassified, unless a test
  for the storage class proves them.

### better-sqlite3

```ts
import Database from "better-sqlite3";
import { createBetterSqlite3Database, sql } from "sqlbraid/better-sqlite3";

const native = new Database(":memory:");
const db = createBetterSqlite3Database(native);
const rows = await db.all(sql.rows`SELECT 1 AS value`);
```

SQLBraid applies `safeIntegers(true)` to each statement. It exposes exact INTEGER
values as decimal strings. `iterate()` is the real stream primitive. Bulk uses a
prepared loop. Native calls block the event loop. If that is a problem, use a
worker. Routines and active cancellation are unsupported.

### libSQL

```ts
import { createClient } from "@libsql/client";
import { createLibsqlDatabase, sql } from "sqlbraid/libsql";

const client = createClient({ url: "file:app.db", intMode: "string" });
const db = createLibsqlDatabase(client, { intMode: "string" });
const rows = await db.all(sql.rows`SELECT 1 AS value`);
```

The explicit `intMode: "string"` option is required. SQLBraid cannot infer the
integer mode of an opaque client.

- Transactions use the interactive transaction handle of libSQL. Ordinary calls
  do not claim one pinned session.
- The adapter uses native `batch()` for bulk.
- The adapter rejects `db.stream()` with `BRAID_STREAM_UNSUPPORTED`. It does not
  buffer a complete result.

Local `file:` libSQL clients and libSQL clients with an unknown protocol omit
the optional `command.insertId`. The native binding rounds ROWID through Number
before it returns a bigint. This occurs for each `intMode`. Query rows,
transactions, bulk execution and `affectedRows` stay supported. For an exact ID,
write `INSERT ... RETURNING id` in your SQL and use `sql.rows`. SQLBraid does not
rewrite SQL or send a compensating query.

The SQLite inspector uses `introspectionScope: "main"` by default. Metadata
capture does not inspect attached schemas. Missing fields do not prove that
indexes or constraints are absent. The better-sqlite3 and libSQL targets are
Compatible until there is exact runtime and driver evidence. They are not
certified by analogy.

libSQL transaction options:

- If the transaction options are omitted or empty, the adapter calls
  `client.transaction()` without a mode.
- `readOnly: false` selects `"write"`.
- The local `@libsql/client@0.18.0` file transport emits
  `BEGIN TRANSACTION READONLY`, but it does not block writes. Thus, SQLBraid
  reports read-only as guarded and rejects `readOnly: true` before it begins.
- Opaque clients without a transport protocol get the same guard.
- Remote transports that expose and enforce the documented `"read"` mode keep
  that option.

better-sqlite3 accepts `Uint8Array` bind views. It converts them to `Buffer`
immediately before native calls.
