# @sqlbraid/oracle

Oracle SQL dialect, node-oracledb Thin-mode adapters, routine support, and metadata inspector for SQLBraid.

```sh
npm install @sqlbraid/oracle oracledb
```

```ts
import oracledb from "oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";

const connection = await oracledb.getConnection({ user, password, connectString });
const db = createOracledbDatabase(connection);
const rows = await db.all(sql.rows<{ id: string }>`SELECT id FROM users`);
```

The portable root does not import `oracledb`; the driver subpath is optional. Oracle routine calls support scalar OUT/INOUT binds and `SYS_REFCURSOR`/REF CURSOR OUT values with `oracleParameter.refCursor()`. Cursor outputs are removed from `output`, materialized into ordered `resultSets`, and every live `ResultSet` is closed before lease release. Oracle implicit results are included as additional result sets. Application results never expose raw `ResultSet` objects.

Oracle routine calls use authored PL/SQL/SQL text. Native procedure metadata is not accepted by this adapter. Thin mode is the first-party target; Thick mode is not implied by this package.

Oracle DML that returns rows uses native `RETURNING ... INTO` with
`sql.out(name, hint?)` and the materialized row APIs. `sql.inOut()` remains
call-only. The adapter normalizes returned OUT values only after physical
execution; DML-returning streaming is not a portable PV16 support claim.

CLOB/NCLOB OUT and INOUT values become strings; BLOB values become bytes.
SQLBraid reads returned Lobs with `getData()` and awaits their `destroy()`/`close`
event before lease release. Sibling Lobs and ResultSets are cleaned up even
when another output fails; no live Lob escapes `db.call()`.

See the [Oracle setup](https://clickin.github.io/SQLBraid/getting-started/oracle/), [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).

The Thin profile returns Oracle `NUMBER`, `FLOAT`, and ANSI `NUMBER` aliases as
strings for exact handling, `BINARY_FLOAT`/`BINARY_DOUBLE` as approximate
JavaScript numbers (including verified `NaN`/infinity values), LOB text as
strings, and BLOB/RAW as bytes. The free 23.9 target is not Oracle 19c
evidence; Thick mode is separate. See the [data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).

Exact decimal strings are not a generic typed Oracle `NUMBER` bind guarantee:
unhinted string-to-number conversion follows the session NLS settings, while
`oracleParameter.number()` rejects decimal strings rather than silently
rounding them. When exact input matters, author the conversion in SQL with an
explicit format and NLS clause, for example:

```sql
TO_NUMBER(:value, 'TM9', 'NLS_NUMERIC_CHARACTERS = ''.,''')
```

SQLBraid does not rewrite that SQL. Native Oracle JSON is exposed as the
driver's parsed object convenience value; nested JSON numbers may already be
JavaScript `number`s. Use the user-authored
`JSON_SERIALIZE(payload RETURNING CLOB)` expression when the application needs
JSON text and chooses its own lossless parser. Native temporal values are
guarded JavaScript `Date`s; use `TO_CHAR(..., 'YYYY-MM-DD"T"HH24:MI:SS.FF9')`
(and an explicit offset format where needed) for precision/time-zone text.
