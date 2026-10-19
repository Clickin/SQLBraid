---
title: Browser SQLite and D1
description: Use the SQLite WASM and Cloudflare D1 adapters without inventing a browser pool or cursor.
---

SQLBraid keeps SQLite as one dialect. It separates the execution driver and the
runtime. Browser code uses SQLite WASM. A Worker binding uses Cloudflare D1.
Neither path changes the SQLBraid query rules.

## SQLite WASM

This example needs Node `>=22.18.0`. It runs in Node. A browser application creates the same `sqlite3` and `oo1.DB` objects.

Install the SQLBraid runtime facade, the SQLite package and the official WASM
runtime in the application that owns the browser or worker resource:

```bash
mkdir braid-wasm-app && cd braid-wasm-app
pnpm init --init-type module
pnpm add sqlbraid @sqlbraid/sqlite @sqlite.org/sqlite-wasm
mkdir src
```

Create one direct database from the OO1-style object in the current realm. Save this code as `src/index.ts` and run `node src/index.ts`:

```ts
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";
import { sql } from "@sqlbraid/sqlite";

const sqlite3 = await sqlite3InitModule();
const wasmDatabase = new sqlite3.oo1.DB(":memory:");
wasmDatabase.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL)");
wasmDatabase.exec("INSERT INTO account (email) VALUES ('ada@example.com')");

const db = createSqliteWasmDatabase(wasmDatabase, { sqlite3 });
const rows = await db.all(sql.rows<{ id: string; email: string }>`SELECT id, email FROM account`);
console.log(rows);
wasmDatabase.close();
```

The output is `[{ id: '1', email: 'ada@example.com' }]`.

INTEGER storage is exposed as a canonical decimal string. The WASM adapter uses
native column types and `sqlite3_column_int64`. It does not guess from the
numeric value. Integral REAL values stay `number`. Native bigint is an internal
transport detail. It is not a public integer mode. D1 is a separate guarded
profile: safe integral JavaScript Numbers become strings. Values outside the
safe range are unsupported. They are not rounded.

The adapter supports these operations:

- prepare, bind, step and finalize;
- row streaming by pull;
- callback transactions;
- command-only bulk, with one prepared statement that is reset for each item.

It is a direct resource, not a pool. While a transaction or a stream owns it,
conflicting root operations are rejected. SQLBraid does not depend on an
incomplete async-context polyfill.

## Cloudflare D1

This example needs Node `>=22.18.0`. It runs a Worker with a local D1 database.

Install the facade and SQLite package. D1 does not need the WASM runtime. Wrangler runs the Worker locally:

```bash
mkdir braid-d1-app && cd braid-d1-app
pnpm init --init-type module
pnpm add sqlbraid @sqlbraid/sqlite
pnpm add --save-dev wrangler
mkdir src
```

Save this configuration as `wrangler.jsonc`:

```jsonc
{
  "name": "braid-d1-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "d1_databases": [{ "binding": "DB", "database_name": "braid", "database_id": "local" }],
}
```

D1 stays SQLite. It uses a structural binding interface. Thus, the package does
not need a Cloudflare type package at runtime. Save this Worker as `src/index.ts`:

```ts
import { createD1Database } from "@sqlbraid/sqlite/d1";
import { sql } from "@sqlbraid/sqlite";

interface Env {
  DB: Parameters<typeof createD1Database>[0];
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const db = createD1Database(env.DB);
    const rows = await db.all(sql.rows<{ id: string; email: string }>`SELECT id, email FROM account`);
    return Response.json(rows);
  },
};
```

Create the local table, start the Worker and request it from a second terminal:

```bash
pnpm exec wrangler d1 execute braid --local --command "CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL); INSERT INTO account (email) VALUES ('ada@example.com');"
pnpm exec wrangler dev
```

```bash
curl http://localhost:8787
```

The response is `[{"id":"1","email":"ada@example.com"}]`.

D1 exposes untyped JavaScript numbers. Its guarded profile rejects integral
numbers outside the safe range. This also excludes integral REAL values outside
that range, because the public result API cannot separate them from rounded
INTEGER values. It does not promise full int64 or exact decimal output.
The API denies `sqlite_version()`. Thus, `db.environment()` leaves the server
version unknown. A Worker compatibility date is not a database version.

- D1 uses ordered `?1`, `?2`, … binds and public result metadata for
  materialized queries.
- `db.bulk()` maps one logical shape to one `D1Database.batch()` call. It
  reports `remote-batch`.
- The Worker Binding API of D1 has no incremental row cursor. `db.stream()` is
  `BRAID_STREAM_UNSUPPORTED`. SQLBraid does not paginate to simulate streaming.
- Callback `db.tx()` is unsupported, unless a future D1 primitive matches the
  callback transaction rules of SQLBraid.

The native D1 batch can have stronger transaction behavior than root bulk. But
that is not a portable SQLBraid rule. Root bulk is not a transaction. It has no
portable promise of automatic chunking.

See the [runtime and driver support matrix](/SQLBraid/reference/support/) for the exact capability status of SQLite WASM and Cloudflare D1. Cloudflare D1 is listed as Compatible because the Worker binding does not report its underlying SQLite version.

## Browser and Worker representation profiles

SQLite stays the dialect. But WASM and D1 are different drivers. They must not
share an evidence label.

| Driver                | Driver raw / SQLBraid canonical boundary                   | Stream/bulk/transaction                                                   |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| SQLite WASM OO1       | SQLite dynamic values; INTEGER storage is canonical string | pull iteration, prepared-loop bulk, callback transaction                  |
| Cloudflare D1 binding | materialized rows and ordered `?1`, `?2`, … binds          | native `batch()` bulk; streaming and callback transaction are unsupported |

- JSON1 is text, unless the selected WASM build or parser proves a different
  representation.
- BLOB values stay bytes.
- Native `RETURNING` is materialized before delivery.
- Browser SQL is sent through without change. This does not make the browser
  runtime a SQL grammar implementation. It does not make adapters that are only
  for Node compatible with browsers.
