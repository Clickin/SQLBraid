# @sqlbraid/bun-sql

SQLBraid adapter for the pinned Bun 1.3.14 `Bun.SQL` API. One implementation
family serves a user-selected PostgreSQL, MySQL, MariaDB, or SQLite dialect;
the adapter never exports a Bun-specific query type or SQL tag.

```ts
import { sql } from "@sqlbraid/postgres";
import { createBunSqlDatabase } from "@sqlbraid/bun-sql";

const bunSql = new Bun.SQL(process.env.DATABASE_URL!);
const db = createBunSqlDatabase(bunSql, { dialect: "postgres" });
const rows = await db.all(sql.rows`SELECT id FROM users`);
```

The transport uses Bun's documented `unsafe(text, values)` parameterized API
with PostgreSQL `$1`, `$2`, ... placeholders and `?` placeholders for
MySQL/MariaDB/SQLite. It does not construct fake tagged-template arrays.
For the profiled exact-int transport, construct network clients with Bun's
documented `{ bigint: true }` option (the SQLite profile uses
`{ safeIntegers: true }`).
PostgreSQL, MySQL, and MariaDB use Bun's documented `reserve()` pool primitive
for sessions and transactions; SQLite uses its one direct Bun.SQL resource.
Because Bun's reserved handle exposes `release()` but no scoped discard
primitive, `release({ discard: true })` quarantines the reservation and throws
`BRAID_RESOURCE_CLEANUP`; close the owning Bun.SQL client when a reservation
must be discarded.
Streaming and routine result carriers are explicit `UnsupportedFeatureError`
paths: MySQL OUT parameters require user-authored session variables plus a
second SELECT, while Bun's public result has no direction or result-set carrier
that SQLBraid can map; the other dialects do not document a routine output
carrier.
On Bun 1.3.14 MySQL-family results may omit the command marker and report
`affectedRows: 0` for both an empty `SELECT` and a zero-affected command.
The result capabilities are therefore guarded, and those shapes are rejected
as `BRAID_RESULT_KIND_AMBIGUOUS` after execution (the SQL may already have
had side effects); non-empty row arrays and positive command counts remain
supported from their native carriers.

Bun.SQL returns rows as JavaScript values without public per-column type
metadata. The adapter therefore rejects ambiguous integral JavaScript Number
row values with `BRAID_RESULT_EXACTNESS`; use a user-authored `CAST(... AS
TEXT)` when exact textual output is required. BigInt rows are normalized to
canonical decimal strings. PostgreSQL decimal output is text. MySQL/MariaDB
DECIMAL and binary outputs share an untyped byte carrier and are rejected;
author `CAST(... AS CHAR)` or `HEX(...)` instead. SQLite native decimal output
is unsupported. MariaDB/SQLite JSON remains text; PostgreSQL/MySQL native JSON
can round nested numbers. Server temporal values remain guarded, including
fractional precision and host-time-zone interpretation.

Bun's SQLite SQL classifier can misclassify literals mixing single and double
quotes, including inline JSON. Its row/command capabilities are guarded by
`bun-sql.sqlite-result-parser`; bind JSON values rather than embedding them in
SQL literals. SQLBraid does not rewrite SQL to repair Bun's parser.

Official references for the pinned API:

- [Bun SQL guide](https://bun.com/docs/runtime/sql)
- [Bun 1.3.14 SQL declarations](https://github.com/oven-sh/bun/blob/bun-v1.3.14/packages/bun-types/sql.d.ts)
- [Bun 1.3.14 SQL result conversion source](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/jsc/bindings/SQLClient.cpp)
- [Bun 1.3.14 SQLite SQL adapter source](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/internal/sql/sqlite.ts)
