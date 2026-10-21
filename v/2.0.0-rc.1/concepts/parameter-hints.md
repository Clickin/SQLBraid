# Parameter type hints

> Select an explicit database parameter type when driver inference is not sufficient.

SQLBraid keeps the JavaScript value separate from the database parameter type. Ordinary interpolation keeps the normal inference of the driver:

```ts
const id = 42;
const query = sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`;
```

When the database type is important, wrap the value with `sql.bind(value, hint)`:

```ts
import { sql, oracleParameter } from "@sqlbraid/oracle";

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
import { mssqlParameter, sql } from "@sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(displayName, mssqlParameter.nvarchar(200))}
    AND account_id = ${sql.bind(accountId, mssqlParameter.int())}
`;
```

The available factories are `tinyint()`, `smallint()`, `int()`, `bigint()`, `decimal(precision, scale)`, `numeric(precision, scale)`, `money()`, `smallmoney()`, `real()`, `float()`, `nvarchar(lengthOrMax)`, `varchar(lengthOrMax)`, `varbinary(lengthOrMax)`, `bit()`, `uniqueidentifier()`, `date()`, `datetime2()` and `datetimeoffset()`.

Use an explicit hint for ambiguous values, such as `null` or an object of the application. Do not depend on a JavaScript runtime type to select a precision, scale, length or SQL Server-specific type.

## How hint types are declared

The `databaseType` field of a hint is a plain `string`. The core package does not list database types, because each adapter owns the type names that its driver can bind. A custom adapter can define its own names.

The dialect roots give you the checked way to create a hint. Each factory sets `databaseType` for you and records the TypeScript type of the accepted value. TypeScript compares the value with the hint at the `sql.bind` call:

```ts
import { mssqlParameter, sql } from "@sqlbraid/mssql";

const ok = sql.bind(accountId, mssqlParameter.int());
// @ts-expect-error A string is not a valid input for an `int` hint.
const wrong = sql.bind("42", mssqlParameter.int());
```

Use a factory in application code. A factory gives you a closed set of names, an editor completion list and a value check. A hand-written hint object has none of these:

<!-- doc-snippet: skip -->

```ts
sql.bind(accountId, { databaseType: "int" }); // accepted by the SQL Server adapter, not checked by TypeScript
```

The adapter checks the name when it binds the statement, before it runs the statement. It compares names without regard to case and spacing, and it accepts the aliases of the driver, such as `integer` for `int`. If the adapter does not know the name, it fails with `BRAID_BIND_HINT_UNSUPPORTED`. It does not guess a type.

## Oracle hints

The Oracle root exports these factories:

| Factory                                  | Oracle type                                       |
| ---------------------------------------- | ------------------------------------------------- |
| `char`, `nchar`, `varchar2`, `nvarchar2` | `CHAR`, `NCHAR`, `VARCHAR2`, `NVARCHAR2`          |
| `number`                                 | `NUMBER`                                          |
| `binaryFloat`, `binaryDouble`            | `BINARY_FLOAT`, `BINARY_DOUBLE`                   |
| `date`, `timestamp`                      | `DATE`, `TIMESTAMP`                               |
| `timestampTz`, `timestampLtz`            | `TIMESTAMP WITH TIME ZONE`, `... LOCAL TIME ZONE` |
| `raw`                                    | `RAW`                                             |
| `rowid`, `urowid`                        | `ROWID`, `UROWID`                                 |
| `blob`, `clob`, `nclob`                  | `BLOB`, `CLOB`, `NCLOB`                           |
| `refCursor`                              | `REF CURSOR` (routine OUT only)                   |

For an IN value, call the factory without length, precision or scale. The node-oracledb driver cannot apply these facets to an IN value, so the adapter rejects them.

```ts
import { oracleParameter, sql } from "@sqlbraid/oracle";

const query = sql.command`
  UPDATE accounts
  SET balance = ${sql.bind(balance, oracleParameter.number())}
  WHERE id = ${sql.bind(accountId, oracleParameter.number())}
`;
```

## PostgreSQL hints

A PostgreSQL hint sets the type OID of one parameter in the Parse message. The postgres.js and PGlite adapters apply it. The `pg` and Neon adapters reject it, because `pg` exposes no per-parameter type option.

```ts
import { postgresParameter, sql } from "@sqlbraid/postgres";

const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  WHERE id = ${sql.bind(userId, postgresParameter.int8())}
`;
```

| Factory                    | PostgreSQL type             | Accepted value                 |
| -------------------------- | --------------------------- | ------------------------------ |
| `boolean`                  | `boolean`                   | `boolean`                      |
| `int2`, `int4`             | `smallint`, `integer`       | `number`                       |
| `int8`                     | `bigint`                    | `bigint` or exact integer text |
| `float4`, `float8`         | `real`, `double precision`  | `number`                       |
| `numeric`                  | `numeric`                   | exact decimal text             |
| `text`, `varchar`          | `text`, `character varying` | `string`                       |
| `uuid`                     | `uuid`                      | `string`                       |
| `bytea`                    | `bytea`                     | `Uint8Array`                   |
| `date`, `time`, `interval` | `date`, `time`, `interval`  | text, such as `2026-01-02`     |
| `timestamptz`              | `timestamp with time zone`  | `Date` or ISO text             |

Each factory accepts `null`. A typed `null` needs no `CAST`.

The hint carries no length, precision or scale, because the protocol sends only the type OID. The adapter rejects a hint with these facets. The factories for `numeric` and `varchar` take no arguments for the same reason.

SQLBraid does not convert the value. `int8` and `numeric` do not accept a `number`. There is no hint for `timestamp` (without time zone).

`json` and `jsonb` have no hint. Write `CAST(${text} AS jsonb)` in your SQL. The same rule applies to enum, composite and extension types.

## A type without a hint

A hint exists only for the types that an adapter can bind. For all other types, write the conversion in your SQL. The value stays a bound parameter:

```ts
const query = sql.rows<DocumentRow>`
  SELECT id FROM documents
  WHERE payload = CAST(${payloadText} AS jsonb)
`;
```

Use this form for enum, composite, user-defined and extension types, such as `citext`. SQLBraid never rewrites your SQL to add a conversion.

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

| Adapter                                      | Parameter type hints                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| SQL Server (Tedious), Oracle (node-oracledb) | Applied. See the sections above.                                                        |
| PostgreSQL with postgres.js or PGlite        | Applied. See [PostgreSQL hints](#postgresql-hints).                                     |
| PostgreSQL with `pg`, Neon (WebSocket, HTTP) | Rejected with `BRAID_BIND_HINT_UNSUPPORTED`. `pg` exposes no per-parameter type option. |
| MySQL, MariaDB                               | Rejected with `BRAID_BIND_HINT_UNSUPPORTED`.                                            |
| SQLite adapters                              | Rejected with `BRAID_BIND_HINT_UNSUPPORTED`.                                            |
| Bun.SQL (all dialects)                       | Rejected with `BRAID_BIND_HINT_UNSUPPORTED`.                                            |

No adapter silently ignores a hint. The PostgreSQL `postgresParameter.refcursor()` is a separate case. It is only for routines, and it classifies an OUT or INOUT portal.

The portable Oracle and SQL Server roots expose the hint descriptors. Their Node
adapters do capability checks for each adapter. For verified driver
capabilities, read [runtime and driver support](/SQLBraid/v/2.0.0-rc.1/reference/support.md).
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
[routine calls](/SQLBraid/v/2.0.0-rc.1/concepts/routines.md).
