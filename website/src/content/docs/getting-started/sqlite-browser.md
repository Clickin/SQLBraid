---
title: Browser SQLite and D1
description: Use the SQLite WASM and Cloudflare D1 adapters without inventing a browser pool or cursor.
---

PV16 keeps SQLite as one dialect while separating the execution driver and
runtime. Browser code uses SQLite WASM; a Worker binding uses Cloudflare D1.
Neither path changes the SQLBraid query contract.

## SQLite WASM

Install the SQLite package and official WASM runtime in the application that
owns the browser/worker resource:

```bash
npm install @sqlbraid/sqlite @sqlite.org/sqlite-wasm
```

Create one direct database from the OO1-style object in the current realm:

```ts
import { sql } from "@sqlbraid/sqlite";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";

const db = createSqliteWasmDatabase(wasmDatabase);
const rows = await db.all(sql.rows<{ id: number }>`SELECT id FROM account`);
```

For uniform, exact `bigint` INTEGER output, pass the initialized official module:

```ts
const db = createSqliteWasmDatabase(wasmDatabase, { integerMode: "bigint", sqlite3 });
```

This uses native column types and `sqlite3_column_int64`, not a numeric-value
heuristic: integral REAL values remain `number`. Number mode rejects INTEGER
values outside JavaScript's safe range. Bigint mode without `sqlite3` rejects
with `BRAID_INTEGER_MODE_UNSUPPORTED`.

The adapter supports prepare/bind/step/finalize, row streaming by pull,
callback transactions, and command-only bulk with one prepared statement reset
per item. It is a direct resource, not a pool. While a transaction or stream
owns it, conflicting root operations reject; SQLBraid does not depend on an
incomplete async-context polyfill.

## Cloudflare D1

D1 remains SQLite and uses a structural binding interface, so the package does
not require a Cloudflare type package at runtime:

```ts
import { createD1Database } from "@sqlbraid/sqlite/d1";

const db = createD1Database(env.DB);
```

D1 exposes untyped JavaScript numbers. Its guarded profile rejects integral
numbers outside the safe range; this also excludes integral REAL values outside
that range because the public result API cannot distinguish them from rounded
INTEGER values. It does not promise full int64 or exact decimal output.
The API denies `sqlite_version()`, so `db.environment()` leaves the server
version unknown. A Worker compatibility date is not a database version.

D1 uses ordered `?1`, `?2`, … binds and public result metadata for materialized
queries. `db.bulk()` maps one logical shape to one `D1Database.batch()` call and
reports `remote-batch`. D1 has no incremental row cursor in the Worker Binding
API: `db.stream()` is `BRAID_STREAM_UNSUPPORTED`, and SQLBraid does not paginate
to simulate streaming. Callback `db.tx()` is unsupported unless a future D1
primitive matches SQLBraid's callback transaction contract.

The native D1 batch may have stronger transaction behavior than root bulk, but
that is not the portable SQLBraid contract. Root bulk is not implicitly
transactional and has no portable auto-chunking promise.

The Browser WASM and local D1 gates are pending exact-final-SHA evidence. They do
not claim OPFS persistence, SharedArrayBuffer, remote production support, or a
release label.

## Browser and Worker representation profiles

SQLite remains the dialect, but WASM and D1 are different drivers and must not
share an evidence label.

| Driver | Raw/profile boundary | Stream/bulk/transaction |
| --- | --- | --- |
| SQLite WASM OO1 | SQLite dynamic values; INTEGER mode is driver-configured | pull iteration, prepared-loop bulk, callback transaction |
| Cloudflare D1 binding | materialized rows and ordered `?1`, `?2`, … binds | native `batch()` bulk; streaming and callback transaction are unsupported |

JSON1 is text unless the selected WASM build/parser proves another
representation. BLOB values remain bytes. Native `RETURNING` is materialized
before delivery. Browser SQL is sent through transparently; this does not make
the browser runtime a SQL grammar implementation or make Node-only adapters
browser-compatible.
