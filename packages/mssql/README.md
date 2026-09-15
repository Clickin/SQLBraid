# @sqlbraid/mssql

Microsoft SQL Server dialect and Tedious adapters for SQLBraid.

```sh
npm install @sqlbraid/mssql tedious
```

The application creates and connects the Tedious connection or pool.

```ts
import { sql } from "@sqlbraid/mssql";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";
import type { TediousConnectionLike } from "@sqlbraid/mssql/tedious";

async function readId(connection: TediousConnectionLike): Promise<readonly { id: string }[]> {
  // The application supplies an already-connected Tedious connection.
  const db = createTediousDatabase(connection);
  return db.all(sql.rows<{ id: string }>`
    SELECT CAST(1 AS bigint) AS id
  `);
}
```

Use `createTediousPoolDatabase(pool)` from `@sqlbraid/mssql/tedious` for a
pool. The optional `tedious` peer is loaded only by the adapter subpath; the
portable root exports the SQL dialect and parameter helpers.

## Default result representations

Tedious returns SQL Server `tinyint`, `smallint`, `int`, and `bigint` values as
canonical decimal `string` values. `real` and `float` are finite JavaScript
`number` values. `nvarchar`, `varchar`, `char`, and `uniqueidentifier` are
strings; `varbinary` and `binary` are `Uint8Array`; and `date`, `datetime2`,
and `datetimeoffset` are `Date` values. Native `decimal`, `numeric`, `money`,
and `smallmoney` results arrive through JavaScript numbers and are rejected by
the default policy rather than exposed as lossy exact values. Cast to a
character type in authored SQL when exact decimal text is needed.

The root exports `mssqlParameter` for explicit Tedious parameter hints,
including `bigint()`, `decimal(precision, scale)`, `numeric(precision, scale)`,
`nvarchar(length)`, `varchar(length)`, `varbinary(length)`, and temporal hints.
Decimal and money helpers accept only finite JavaScript numbers within their
precision limits; bind character text and author `CAST`/`CONVERT` for larger
exact values.

SQL Server DML returning uses native `OUTPUT` syntax with `sql.rows`. Ordinary
row streaming uses Tedious row events with bounded buffering. Active signals
use Tedious request cancellation and discard the affected physical connection;
without a cancellation path, the operation is rejected before I/O. A routine
can emit result sets and scalar OUTPUT/INOUT values when its SQLBraid contract
supplies the procedure identity and parameter metadata. `CURSOR VARYING OUTPUT`
is not exposed as an application cursor, and a procedure RETURN status needs
explicit procedure metadata.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/),
[SQL Server setup](https://clickin.github.io/SQLBraid/getting-started/mssql/), and
[data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
