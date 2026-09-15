# @sqlbraid/oracle

Oracle SQL dialect and node-oracledb Thin-mode adapters for SQLBraid.

```sh
npm install @sqlbraid/oracle oracledb
```

The application creates and connects the node-oracledb connection or pool.

```ts
import oracledb from "oracledb";
import { sql } from "@sqlbraid/oracle";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";

const connection = await oracledb.getConnection({
  user: process.env.ORACLE_USER,
  password: process.env.ORACLE_PASSWORD,
  connectString: process.env.ORACLE_CONNECT_STRING,
});
try {
  const db = createOracledbDatabase(connection);
  const rows = await db.all(sql.rows<{ id: string }>`
    SELECT CAST(1 AS NUMBER) AS id FROM dual
  `);
  // rows[0].id is the exact decimal string "1"
} finally {
  await connection.close();
}
```

For pools, use `createOracledbPoolDatabase(pool)` from
`@sqlbraid/oracle/oracledb`. Thin mode is the package's target; configure
Thick mode separately in node-oracledb if your application requires it.

## Default result representations

The default Oracle policy represents NUMBER-family values (`NUMBER`,
`INTEGER`, `DECIMAL`, `NUMERIC`, and aliases) as exact decimal `string`
values. `BINARY_FLOAT` and `BINARY_DOUBLE` are JavaScript `number` values.
Character and ROWID values are strings, DATE and TIMESTAMP values are `Date`,
RAW values are `Uint8Array`, and CLOB/NCLOB values are strings. BLOB values
remain driver-owned and are typed as `unknown`.
Native JSON, objects, collections, and vectors remain driver-owned values and
are typed as `unknown`; nested numeric values are not recursively normalized.

DML `RETURNING ... INTO` uses `sql.out(name, hint?)` and materialized row APIs.
Routine calls use authored Oracle SQL or PL/SQL and can map scalar OUT/INOUT
binds and `SYS_REFCURSOR` values with `oracleParameter.refCursor()`; cursor
results become materialized `resultSets`. A routine return-value carrier is
not provided by this adapter. Streaming requires a node-oracledb ResultSet.

Use `oracleParameter.number()` for numeric binds with JavaScript `number` or
`bigint`. Decimal text is not a generic exact NUMBER bind; author an explicit
`TO_NUMBER` format and NLS clause in SQL when exact decimal input matters.
Active cancellation requires the connection's public `break()` method and is
cooperative; without it, an active signal is rejected before I/O.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/),
[Oracle setup](https://clickin.github.io/SQLBraid/getting-started/oracle/), and
[data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
