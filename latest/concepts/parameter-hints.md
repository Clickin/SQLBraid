# Parameter type hints

> Select an explicit database parameter type when driver inference is not sufficient.

SQLBraid keeps the JavaScript value separate from the database parameter type. Ordinary interpolation keeps the normal inference of the driver:

```ts
const id = 42;
const query = sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`;
```

When the database type is important, wrap the value with `sql.bind(value, hint)`:

```ts
import { sql, oracleParameter } from "sqlbraid/oracle";

const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE account_number = ${sql.bind(accountNumber, oracleParameter.number())}
`;
```

The wrapper stays a value in the template. It is never structural SQL. It is never converted to a string in the statement.

## TypeScript types are not database evidence

SQLBraid does not infer a universal database parameter type from a TypeScript type.

- A `number` can be an integer, a decimal, a monetary value, an identifier or a numeric type of one database.
- A `string` can be text, a UUID, JSON or a constrained character type.
- `Date` does not select one of the date and timestamp variants of the database.

Without a hint, the adapter can use its documented driver inference. With a hint, the adapter must obey the descriptor or fail explicitly. This is database parameter typing. It is not application input validation, result mapping or a codec framework.

## SQL Server hints

The SQL Server root exports factories for the types that the Tedious adapter supports:

```ts
import { mssqlParameter, sql } from "sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(displayName, mssqlParameter.nvarchar(200))}
    AND account_id = ${sql.bind(accountId, mssqlParameter.int())}
`;
```

The available factories are `tinyint()`, `smallint()`, `int()`, `bigint()`, `decimal(precision, scale)`, `numeric(precision, scale)`, `money()`, `smallmoney()`, `real()`, `float()`, `nvarchar(lengthOrMax)`, `varchar(lengthOrMax)`, `varbinary(lengthOrMax)`, `bit()`, `uniqueidentifier()`, `date()`, `datetime2()` and `datetimeoffset()`.

Use an explicit hint for ambiguous values, such as `null` or an object of the application. Do not depend on a JavaScript runtime type to select a precision, scale, length or SQL Server-specific type.

## Rendered metadata and prepared shape

Rendered statements keep each value, its interpolation index and its optional
hint in one immutable `parameters` record. `segments.length === parameters.length + 1`.
Observers get the values, hints and interpolation maps from that record. This
does not change the redaction policy for bind values.

The shape of a prepared query is its result kind, its canonical logical segments
and its ordered hint signature.

- A change of only a value is permitted.
- A change of a hint, length, precision or scale is a change of shape. It fails.
  SQLBraid does not silently reuse an incompatible prepared statement.
- The physical spelling `$1`, `?`, `:1` or `@p1` is not part of the shape.

## Adapter support

The PostgreSQL, MySQL, MariaDB and SQLite adapters explicitly reject ordinary
parameter hints with `BRAID_BIND_HINT_UNSUPPORTED`. They do not silently ignore a
hint. The PostgreSQL `postgresParameter.refcursor()` is a narrow exception. It
is only for routines, and it classifies an OUT or INOUT portal. Use ordinary
binds without hints for all other parameters, until an adapter with the
necessary type API is available.

The portable Oracle and SQL Server roots expose the hint descriptors. Their Node
adapters do capability checks for each adapter. For verified driver
capabilities, read [runtime and driver support](/SQLBraid/latest/reference/support.md).
Oracle rejects IN length, precision and scale facets, because node-oracledb
cannot apply them. Neither adapter silently ignores unsupported facets.

## Routine directions

`sql.bind(value, hint)` is an IN value. Routine calls also support:

<!-- doc-snippet: skip -->

```ts
sql.out("name", hint?)              // OUT, logical null placeholder
sql.inOut("name", value, hint?)     // INOUT, initial value plus output
```

These helpers are valid only in `sql.call` templates. Output names must be
unique.

- Oracle OUT and INOUT values require a hint.
- SQL Server OUTPUT and INOUT values require a Tedious hint.
- PostgreSQL needs `postgresParameter.refcursor()` to classify a refcursor output.
- The MySQL prepared CALL path rejects OUT and INOUT. The public mysql2 3.x API
  does not prove which extra result is the carrier.

For the result order, the removal of cursors from `output` and cleanup, read
[routine calls](/SQLBraid/latest/concepts/routines.md).
