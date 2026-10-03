# Oracle quickstart

> Connect SQLBraid to node-oracledb in Thin mode with explicit Oracle parameter hints.

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

`sql.bind` keeps the value separate from the SQL text and supplies an Oracle database parameter type. Without a hint, the adapter uses its documented driver inference. SQLBraid never treats a TypeScript `number`, `string` or `Date` as universal evidence for an Oracle type.

The Thin binding adapter materializes the logical statement as text-positional
`:1`, `:2`, … binds. It maps supported hints to node-oracledb descriptors. The
description, the hint validation and the deterministic bind construction occur
before lease acquisition. The adapter reports effective reuse that the driver
owns. Unsupported hint facets fail at the `materialize` stage, before database
I/O.

## Capability boundaries

- The first-party target is `node-oracledb` Thin mode. Thick mode is outside
  the verification scope of this guide.
- `sql.call` supports scalar OUT and IN OUT descriptors, and `SYS_REFCURSOR` OUT
  values with `oracleParameter.refCursor()`. Cursor outputs become materialized
  `resultSets`. They are removed from the scalar `output`. Implicit results are
  included. Each `ResultSet` is closed before the lease release.
- This adapter does not support native `procedure` metadata. Write the Oracle
  PL/SQL or SQL call text explicitly.
- Streaming uses the ResultSet protocol of the driver. It closes the ResultSet on completion, abort or early break.
- Cancellation uses the guarded `connection.break()` path. It is cooperative.
  It does not guarantee a prompt stop or a timeout. The documented
  `DBMS_SESSION.SLEEP` raw probe can reject with `ORA-01013` only when the sleep
  completes. The adapter holds the physical lease until settlement. Without the
  documented break primitive, active cancellation fails before I/O with
  `BRAID_CANCEL_UNSUPPORTED`.
- The target combination is Oracle Free 23.9 Thin on Node 22.18.0/Linux x64.
  Its current certification status and its exact gate are in
  [runtime and driver support](/SQLBraid/v/1.0.2/reference/support.md).

If the driver cannot infer a safe Oracle type, use an explicit hint for `null`. Do not silently turn an untyped null into `VARCHAR2`.

The default policy fetches the exact `NUMBER` family as strings, to keep the
precision. This includes Oracle `FLOAT` and the ANSI numeric aliases. Oracle
`NUMBER(p,0)` stays part of that exact-decimal family. The support taxonomy does
not invent a separate category for native exact-integer transport.

`NUMBER` decimal-string input is not a certified exact bind path:

- Typed `number` and `bigint` inputs are limited by their JavaScript
  representation.
- Strings without a hint can depend on `NLS_NUMERIC_CHARACTERS`.

Keep this capability unsupported, unless the session or profile proves it. When
necessary, use an ordinary character bind and an explicit, controlled SQL
conversion.

The Thin adapter rejects precision and scale facets and IN length constraints.
VARCHAR2 and NVARCHAR2 OUT and INOUT lengths select the `maxSize` of the driver.
Other length facets are rejected. Put database constraints in SQL or in the
schema.

- Materialized CLOB and NCLOB values are strings. BLOB and RAW values are buffers.
- `oracleParameter.clob()` and `blob()` accept the LOB carrier of the driver for
  IN and IN OUT binds. OUT and IN OUT results are materialized before cleanup.
- Routine LOB outputs are read with `getData()` and destroyed before the lease
  release. This includes the siblings that were not visited after a read failure.
- Temporal values use `Date` as a guarded convenience profile. It does not keep
  the source timezone name or sub-millisecond precision. For a lossless text
  path, write `TO_CHAR` or format expressions in your SQL.
- Native JSON is a parsed convenience value. When you need serialized text, use
  a tested fetch handler or `JSON_SERIALIZE(... RETURNING CLOB)`.

The executable LOB audit covers CLOB and BLOB OUT and IN OUT binds,
materialization and cleanup in the `oracle.routine.inout` support fixture. The
target manifest links that test and its exact Oracle Free evidence. The fixture
is a real Oracle Free integration test. The separate adapter unit tests for
mocked LOB carriers verify only the cleanup and error paths. They do not promote
a different database or driver target.

For the complete `sql.out`/`sql.inOut` and heterogeneous result-set rules, read
[routine calls](/SQLBraid/v/1.0.2/concepts/routines.md).

## Oracle Thin representation profile

The first-party profile is node-oracledb Thin mode. The free Oracle 23.9 target
is the environment that is currently documented. Do not present it as Oracle 19c
evidence. Thick mode and other server lines are separate, untested profiles,
until their manifests contain matching evidence.

| Oracle value                              | Driver raw / SQLBraid canonical representation | Notes                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `NUMBER` / `FLOAT` / ANSI numeric aliases | text → `string`                                | One exact-decimal family, including `NUMBER(p,0)`; `decodeExactDecimal` or `decodeExactInteger` is an application transform. |
| `BINARY_FLOAT` / `BINARY_DOUBLE`          | JavaScript number                              | Approximate binary32/binary64 values; special-value support is profile-tested.                                               |
| CLOB / NCLOB                              | string                                         | Routine LOBs are read and destroyed before lease release.                                                                    |
| BLOB / RAW                                | `Buffer`                                       | Keep bytes or explicitly encode them.                                                                                        |
| DATE / TIMESTAMP variants                 | `Date`                                         | Guarded convenience profile; use authored `TO_CHAR` text for fractional/zone fidelity.                                       |
| Native JSON                               | parsed object                                  | Convenience only; nested numeric exactness is not guaranteed.                                                                |

- The binding transport is text-positional `:1`, `:2`, … with node-oracledb bind
  descriptors.
- OUT ordinals follow the SQL bind order. The IN values between them do not
  change them.
- REF CURSOR outputs become ordered materialized `resultSets`. Implicit results
  are additional sets.
- Native `RETURNING ... INTO` uses `sql.out()` and the materialized row APIs.
- `executeMany()` is the supported native bulk strategy where the manifest
  proves it.
- `rowsAffected` is an operational count with safe-range validation.
  `RETURNING INTO` values follow the same exact string rules.
- Ordinary `undefined` IN values fail before acquisition with
  `BRAID_BIND_VALUE_UNSUPPORTED`. `null` is SQL `NULL`.
- Native Oracle SQL passes through without change. SQLBraid does not give an
  Oracle grammar and does not infer procedure metadata.
