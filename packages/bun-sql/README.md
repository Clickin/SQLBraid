# @sqlbraid/bun-sql

SQLBraid adapter for Bun's `Bun.SQL` client. Select the SQL dialect explicitly
when creating a database; the client itself does not determine the dialect.

```sh
bun add @sqlbraid/bun-sql @sqlbraid/postgres
```

```ts
import { sql } from "@sqlbraid/postgres";
import { BUN_SQL_POSTGRES, createBunSqlDatabase } from "@sqlbraid/bun-sql";

const client = new Bun.SQL(process.env.DATABASE_URL!, {
  ...BUN_SQL_POSTGRES.connectionOptions,
});
const db = createBunSqlDatabase(client, { dialect: "postgres" });
const rows = await db.all(sql.rows<{ id: string }>`
  SELECT CAST(1 AS bigint) AS id
`);
// rows[0].id is the exact decimal string "1"
```

`Bun.SQL` and the database connection are supplied by the application. Use
`BUN_SQL_POSTGRES`, `BUN_SQL_MYSQL`, `BUN_SQL_MARIADB`, or `BUN_SQLITE` when
constructing the client so its native integer-width option matches the chosen
dialect (`bigint: true` for PostgreSQL/MySQL/MariaDB and `safeIntegers: true`
for SQLite).

## Native Bun transport

Ordinary SQLBraid statements use Bun's callable native value-template API. The
adapter lowers structural SQL to final template segments plus native values;
it does not generate `$1` or `?` placeholders and does not use
`unsafe(text, values)` for ordinary statements. Bun structural helper-shaped
values, query fragments, arrays, and other ambiguous objects are rejected
because Bun's callable API accepts native values only; serialize JSON or text
explicitly before binding. `Date` and `Uint8Array` remain supported native
values.
`unsafe` is reserved for SQLBraid's internal transaction-control statements.

The default result representations are guarded by Bun's untyped result API:

- PostgreSQL: exact integers and `DECIMAL` are strings; approximate floats are
  numbers; JSON and temporal values use Bun's native representations.
- MySQL: exact integers are strings; JSON and temporal values use Bun's native
  representations. Decimal and binary values do not have a lossless native
  carrier.
- MariaDB: exact integers are strings; JSON is text; temporal values use Bun's
  native representations. Decimal and binary values do not have a lossless
  native carrier.
- SQLite: INTEGER values are strings, REAL values are numbers, TEXT values are
  strings, and BLOB values are `Uint8Array` values.

Bun does not expose the metadata SQLBraid needs for routine calls or streaming,
so this adapter rejects `db.call()` and `db.stream()`. Active cancellation is
not available through the public Bun API; an `AbortSignal` is rejected rather
than pretending to cancel a running statement. OUT and INOUT parameters are
not supported. For MySQL-family routine work, author session variables and a
follow-up `SELECT` in application SQL instead.

PostgreSQL and MySQL-family clients use Bun's `reserve()` for sessions and
transactions. SQLite uses its direct client. Transaction isolation and
read-only options are dialect-specific; unsupported combinations are rejected.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) and the
[Bun SQL guide](https://bun.com/docs/runtime/sql).
