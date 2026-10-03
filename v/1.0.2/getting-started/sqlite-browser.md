# Browser SQLite and D1

> Use the SQLite WASM and Cloudflare D1 adapters without inventing a browser pool or cursor.

SQLBraid keeps SQLite as one dialect. It separates the execution driver and the
runtime. Browser code uses SQLite WASM. A Worker binding uses Cloudflare D1.
Neither path changes the SQLBraid query rules.

## SQLite WASM

Install the SQLite package and the official WASM runtime in the application that
owns the browser or worker resource:

```bash
npm install sqlbraid @sqlite.org/sqlite-wasm
```

Create one direct database from the OO1-style object in the current realm:

```ts
import { createSqliteWasmDatabase, sql } from "sqlbraid/sqlite-wasm";

const db = createSqliteWasmDatabase(wasmDatabase, { sqlite3 });
const rows = await db.all(sql.rows<{ id: string }>`SELECT id FROM account`);
```

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

D1 stays SQLite. It uses a structural binding interface. Thus, the package does
not need a Cloudflare type package at runtime:

```ts
import { createD1Database } from "sqlbraid/d1";

const db = createD1Database(env.DB);
```

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

The [runtime and driver support matrix](/SQLBraid/v/1.0.2/reference/support.md) records
labels for each exact tuple of database, driver, profile, runtime and
capability, with its revision and workflow evidence. A neighboring version or a
package installation is not certification. The final exact-SHA Runtime, Docs
and Release gates and an explicit release authorization stay separate
requirements. D1 stays Compatible. Its managed SQLite version is not reported.
No browser gate claims OPFS persistence, SharedArrayBuffer, remote production
support or npm publication.

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
