---
title: Oracle quickstart
description: Connect SQLBraid to node-oracledb in Thin mode with explicit Oracle parameter hints.
---

Install the SQLBraid runtime facade and the Oracle driver together:

```bash
npm install sqlbraid oracledb
```

The portable root does not import `oracledb`. The driver subpath owns the Node adapter:

```ts
import oracledb from "oracledb";
import { createOracledbDatabase, oracleParameter, sql } from "sqlbraid/oracledb";

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
- Cancellation uses the guarded `connection.break()` path. It is cooperative,
  not a prompt or timeout guarantee: the documented `DBMS_SESSION.SLEEP` raw
  probe can reject with `ORA-01013` only when the sleep completes, and the
  adapter holds the physical lease through settlement. Without the documented
  break primitive, active cancellation fails before I/O with
  `BRAID_CANCEL_UNSUPPORTED`.
- The target combination is Oracle Free 23.9 Thin on Node 22.18.0/Linux
  x64. Its current certification status and exact gate are recorded in
  [runtime and driver support](/SQLBraid/reference/support/).

Use an explicit hint for `null` when the driver cannot infer a safe Oracle type. Do not silently turn an untyped null into `VARCHAR2`.

The default policy fetches the exact `NUMBER` family (including Oracle's
`FLOAT` and ANSI numeric aliases) as strings to preserve precision. Oracle
`NUMBER(p,0)` remains part of that exact-decimal family; the support taxonomy
does not invent a separate native exact-integer transport category. `NUMBER`
decimal-string input is not a certified exact bind path: typed `number`/`bigint`
inputs are bounded by their JavaScript representation and unhinted strings can
depend on `NLS_NUMERIC_CHARACTERS`. Keep this capability unsupported unless the
session/profile proves it; use an ordinary character bind plus an explicit,
controlled SQL conversion when needed.

The Thin adapter rejects precision/scale facets and IN length constraints.
VARCHAR2/NVARCHAR2 OUT/INOUT lengths select the driver's `maxSize`; other
length facets are rejected. Put database constraints in SQL/schema.
Materialized CLOB/NCLOB values are strings and BLOB/RAW values are buffers.
`oracleParameter.clob()`/`blob()` accepts the driver's LOB carrier for IN and
IN OUT binds; OUT and IN OUT results are materialized before cleanup.
Routine LOB outputs are read with `getData()` and destroyed before lease
release, including unvisited siblings after a read failure. Temporal values
use `Date` as a guarded convenience profile, not a preserved source timezone
name or sub-millisecond precision. Use user-authored `TO_CHAR`/format
expressions for a lossless text path. Native JSON is a parsed convenience value;
use a tested fetch handler or `JSON_SERIALIZE(... RETURNING CLOB)` when
serialized text is required.

The executable LOB audit covers CLOB/BLOB OUT and IN OUT binds, materialization,
and cleanup in the `oracle.routine.inout` support fixture; the target manifest
links that test and its exact Oracle Free evidence.
The fixture is a real Oracle Free integration test; the separate adapter unit
coverage for mocked LOB carriers verifies cleanup/error paths only and does not
promote another database or driver target.

Use [routine calls](/SQLBraid/concepts/routines/) for the complete
`sql.out`/`sql.inOut` and heterogeneous result-set contract.

## Oracle Thin representation profile

The first-party profile is node-oracledb Thin mode. The free Oracle 23.9 target
is the currently documented environment; it must not be presented as Oracle
19c evidence. Thick mode and another server line are separate, untested
profiles until their manifests contain matching evidence.

| Oracle value | Driver raw / SQLBraid canonical representation | Notes |
| --- | --- | --- |
| `NUMBER` / `FLOAT` / ANSI numeric aliases | text → `string` | One exact-decimal family, including `NUMBER(p,0)`; `decodeExactDecimal` or `decodeExactInteger` is an application transform. |
| `BINARY_FLOAT` / `BINARY_DOUBLE` | JavaScript number | Approximate binary32/binary64 values; special-value support is profile-tested. |
| CLOB / NCLOB | string | Routine LOBs are read and destroyed before lease release. |
| BLOB / RAW | `Buffer` | Keep bytes or explicitly encode them. |
| DATE / TIMESTAMP variants | `Date` | Guarded convenience profile; use authored `TO_CHAR` text for fractional/zone fidelity. |
| Native JSON | parsed object | Convenience only; nested numeric exactness is not guaranteed. |

The binding transport is text-positional `:1`, `:2`, … with node-oracledb bind
descriptors. OUT ordinals follow the SQL bind order, independently of
intervening IN values. REF CURSOR outputs become ordered materialized
`resultSets`; implicit results are additional sets. Native
`RETURNING ... INTO` uses `sql.out()` and materialized row APIs. `executeMany()`
is the supported native bulk strategy where the manifest proves
it. `rowsAffected` is an operational count with safe-range validation, while
`RETURNING INTO` values follow the same exact string contract. Ordinary
`undefined` IN values fail before acquisition with
`BRAID_BIND_VALUE_UNSUPPORTED`; `null` is SQL `NULL`. Native Oracle SQL passes
through transparently; SQLBraid does not provide an Oracle grammar or infer
procedure metadata.
