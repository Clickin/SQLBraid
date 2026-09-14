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
