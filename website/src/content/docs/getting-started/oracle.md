---
title: Oracle quickstart
description: Connect SQLBraid to node-oracledb in Thin mode with explicit Oracle parameter hints.
---

Install the SQLBraid Oracle package and the driver together:

```bash
npm install @sqlbraid/oracle oracledb
```

The portable root does not import `oracledb`. The driver subpath owns the Node adapter:

```ts
import oracledb from "oracledb";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";

interface UserRow {
  id: string;
  name: string;
}

const connection = await oracledb.getConnection({
  user: process.env.ORACLE_USER ?? "app",
  password: process.env.ORACLE_PASSWORD ?? "password",
  connectString: process.env.ORACLE_CONNECT_STRING ?? "localhost/FREEPDB1",
});
const db = createOracledbDatabase(connection);

try {
  const accountNumber = 1001;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id AS "id", name AS "name"
    FROM users
    WHERE account_number = ${sql.bind(accountNumber, oracleParameter.number())}
  `);
  console.log(users);
} finally {
  await connection.close();
}
```

`sql.bind` keeps the value separate from SQL text and supplies an Oracle database parameter type. Without a hint, the adapter uses its documented driver inference. SQLBraid never treats a TypeScript `number`, `string`, or `Date` as universal evidence for an Oracle type.

The Thin binding adapter materializes the logical statement as text-positional
`:1`, `:2`, … binds and maps supported hints to node-oracledb descriptors.
Description, hint validation, and deterministic bind construction happen before
lease acquisition. The adapter reports driver-owned effective reuse. Unsupported
hint facets fail at the `materialize` stage before database I/O.

## Capability boundaries

- The first-party target is `node-oracledb` Thin mode. Thick mode is outside
  this guide's verification scope.
- `sql.call` supports scalar OUT/IN OUT descriptors and `SYS_REFCURSOR` OUT
  values with `oracleParameter.refCursor()`. Cursor outputs become
  materialized `resultSets` and are removed from scalar `output`; implicit
  results are included and every `ResultSet` is closed before lease release.
- Native `procedure` metadata is not supported by this adapter; author the
  Oracle PL/SQL/SQL call text explicitly.
- Streaming uses the driver's ResultSet protocol and closes the ResultSet on completion, abort, or early break.
- The target combination is Oracle 23.9.0.25.07 Thin on Node 22.18.0/Linux
  x64. PV15 final verification is pending; see [runtime and driver
  support](/SQLBraid/reference/support/) for historical evidence only.

Use an explicit hint for `null` when the driver cannot infer a safe Oracle type. Do not silently turn an untyped null into `VARCHAR2`.

The default policy fetches `NUMBER` results as strings to preserve precision. Explicit `NUMBER` input accepts `number` or `bigint`; decimal strings are rejected by this adapter rather than converted lossily. Use an ordinary string bind with an explicit SQL conversion when your SQL requires decimal-text input.

The Thin adapter rejects precision/scale facets and IN length constraints.
VARCHAR2/NVARCHAR2 OUT/INOUT lengths select the driver's `maxSize`; other
length facets are rejected. Put database constraints in SQL/schema.
Materialized CLOB/NCLOB values are strings and BLOB/RAW values are buffers.
Routine LOB outputs are read with `getData()` and destroyed before lease
release, including unvisited siblings after a read failure. Temporal values
use `Date`, not a preserved source timezone name or sub-millisecond precision.

Use [routine calls](/SQLBraid/concepts/routines/) for the complete
`sql.out`/`sql.inOut` and heterogeneous result-set contract.
