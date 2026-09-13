---
title: Parameter type hints
description: Choose an explicit database parameter type when driver inference is not enough.
---

SQLBraid separates the JavaScript value from the database parameter type. Ordinary interpolation keeps the driver's normal inference:

```ts
const id = 42;
const query = sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`;
```

When the database type matters, wrap the value with `sql.bind(value, hint)`:

```ts
import { sql, oracleParameter } from "@sqlbraid/oracle";

const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE account_number = ${sql.bind(accountNumber, oracleParameter.number())}
`;
```

The wrapper remains a value in the template. It is never structural SQL and is never stringified into the statement.

## TypeScript types are not database evidence

SQLBraid does not infer a universal database parameter type from a TypeScript type. A `number` may represent an integer, decimal, monetary value, identifier, or a database-specific numeric type. A `string` may represent text, a UUID, JSON, or a constrained character type. `Date` does not choose among the database's date and timestamp variants.

Without a hint, the adapter may use its documented driver inference. With a hint, the adapter must honor the descriptor or fail explicitly. This is database parameter typing, not application input validation, result mapping, or a codec framework.

## SQL Server hints

The SQL Server root exports factories for the types supported by the Tedious adapter:

```ts
import { mssqlParameter, sql } from "@sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(name, mssqlParameter.nvarchar(200))}
    AND account_id = ${sql.bind(accountId, mssqlParameter.int())}
`;
```

Available factories include `int()`, `bigint()`, `decimal(precision, scale)`, `numeric(precision, scale)`, `nvarchar(lengthOrMax)`, `varchar(lengthOrMax)`, `varbinary(lengthOrMax)`, `bit()`, `uniqueidentifier()`, `date()`, `datetime2()`, and `datetimeoffset()`.

Use an explicit hint for ambiguous values such as `null` or an application-specific object. Never rely on a JavaScript runtime type to select a precision, scale, length, or SQL Server-specific type.

## Rendered metadata and prepared shape

Rendered statements keep each value, interpolation index, and optional hint in
one immutable `parameters` record. `segments.length === parameters.length + 1`;
observers derive values, hints, and interpolation maps from that record without
changing the bind-value redaction policy.

Prepared queries use result kind, canonical logical segments, and the ordered
hint signature as their shape. Changing only a value is allowed; changing a
hint, length, precision, or scale is a shape change and fails rather than
silently reusing an incompatible prepared statement. Physical `$1`, `?`, `:1`,
or `@p1` spelling is not part of the shape.

## Adapter support

The PostgreSQL, MySQL, and SQLite adapters explicitly reject a query containing a parameter hint with `BRAID_BIND_HINT_UNSUPPORTED`; they do not silently ignore it. Use their ordinary unhinted binds until an adapter with the required type API is available.

Oracle and SQL Server portable roots expose the hint descriptors. Their Node adapters have real local database checks; see [runtime and driver support](/SQLBraid/reference/support/) for the exact coverage. Oracle rejects IN length/precision/scale facets because node-oracledb cannot apply them. Neither adapter silently ignores unsupported facets.
