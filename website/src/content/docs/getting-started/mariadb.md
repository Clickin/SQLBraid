---
title: MariaDB quickstart
description: Connect SQLBraid to MariaDB Connector/Node.js while keeping MariaDB syntax explicit.
---

Install the SQLBraid runtime facade and the official Connector/Node.js driver:

```bash
npm install sqlbraid mariadb
```

Use the `/mariadb` adapter subpath with a connected connection or with an explicit
pool factory:

```ts
import mariadb from "mariadb";
import { createMariaDbDatabase, MARIADB_LOSSLESS_TEXT, sql } from "sqlbraid/mariadb";

const connection = await mariadb.createConnection({
  host: "127.0.0.1",
  user: "sqlbraid",
  password: "password",
  database: "app",
  ...MARIADB_LOSSLESS_TEXT.connectionOptions,
});
const db = createMariaDbDatabase(connection, { profile: MARIADB_LOSSLESS_TEXT });
const users = await db.all(sql.rows<{ id: string; name: string }>`
  SELECT id, name FROM users WHERE id = ${1}
`);
```

The dialect is `mariadb`, not `mysql`. You write MariaDB-specific syntax in your
SQL. The current capability fixtures cover the documented
`INSERT ... RETURNING`, `DELETE ... RETURNING`, `REPLACE ... RETURNING`,
sequences, CTEs and JSON functions.

- `UPDATE ... RETURNING` is not claimed.
- An `INSERT ... ON DUPLICATE KEY UPDATE ... RETURNING` form needs matching
  server evidence before it is listed as supported.

The adapter uses value-only execution of Connector/Node.js, native row
streaming, and one `connection.batch()` call for `db.bulk()` (`native-bulk`).
Root bulk is not a transaction. It has no portable promise of automatic
chunking. When you need callback transaction atomicity, use `db.tx()`.

A `mysql2` connection can work with MariaDB as best-effort compatibility. But it
is not evidence for the MariaDB protocol. The official certified profile is
MariaDB 11.8.9 / Connector 3.5.4 / Node 22.18.0. The [runtime and driver support
matrix](/SQLBraid/reference/support/) records labels for each exact tuple of
database, driver, profile, runtime and capability, with its revision and
workflow evidence. A neighboring version or a package installation is not
certification. The final exact-SHA Runtime, Docs and Release gates and an
explicit release authorization stay separate requirements.

## Connector/Node.js representation profile

The first-party MariaDB profile is `mariadb-lossless-text`. It is the official
Connector/Node.js adapter with the exact options that its
`representationProfiles` descriptor selects.

- `@sqlbraid/mariadb` exports `typePolicyForProfile({ json, temporal })`. Thus,
  the runtime and codegen use one immutable TypePolicy.
- `mariadb-native` is a separate convenience profile.
- A mysql2 connection to MariaDB is a separate best-effort compatibility profile.

Connector/Node.js does not expose the effective options. If the descriptor is
omitted or the option declaration is partial, the adapter reports
`mariadb-custom-profile`. This is not a certified profile. Explicit descriptors
stay guarded declarations. They are not observations.

Connector/Node.js does not expose effective options. An omitted descriptor or
partial option declaration reports `mariadb-custom-profile`, not a certified
profile. Explicit descriptors remain guarded declarations, not observations.

| MariaDB value               | Driver raw / SQLBraid canonical representation | Caveat                                                                                               |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| TINYINT/SMALLINT/INT/BIGINT | driver-dependent → `string`                    | Exact integer results are canonical text; `decodeExactInteger` is an application opt-in.             |
| DECIMAL/NUMERIC             | text → `string`                                | Exact precision and scale remain text; use an application decimal transform if needed.               |
| FLOAT/DOUBLE                | number → `number`                              | Approximate binary values remain JavaScript numbers.                                                 |
| JSON alias                  | text with `autoJsonMap:false` → `string`       | `autoJsonMap:true` is a separate convenience profile and does not guarantee nested numeric fidelity. |
| DATE/TIME/DATETIME          | text with `dateStrings:true` → `string`        | Native `Date` is a separate convenience profile and may lose fractional/zone detail.                 |
| BLOB                        | bytes/Buffer                                   | Preserve bytes or explicitly encode.                                                                 |

- The adapter uses value-only execution, native `queryStream()` and one
  `connection.batch()` call for homogeneous bulk.
- Native `RETURNING` is a materialized row declaration only where the exact
  server form has evidence. `INSERT`, `DELETE` and `REPLACE` are separate
  capabilities. `UPDATE` is not claimed.
- SQL passes through without change. This is not MariaDB grammar support.
- `db.call()` materializes heterogeneous emitted sets from prepared `CALL`. OUT,
  INOUT and cursor descriptors stay unsupported.
- `db.prepare()` keeps the query-bound Standard Schema mapping.
- The optional `/inspector` subpath records identity, generated and write flags
  and numeric precision and scale for offline `generateModels()`. Routine
  signatures stay incomplete positive evidence.

`db.call()` materializes heterogeneous emitted sets from prepared `CALL`; OUT,
INOUT and cursor descriptors remain unsupported. `db.prepare()` preserves
query-bound Standard Schema mapping. The optional `/inspector` subpath records
identity, generated/write flags and numeric precision/scale for offline
`generateModels()`; routine signatures remain incomplete positive evidence.

The `mariadb-lossless-text` descriptor keeps `bigIntAsNumber: false`,
`decimalAsNumber: false`, `insertIdAsNumber: false`, `autoJsonMap: false`,
`dateStrings: true` and `timezone: "Z"`.

- Exact integer and decimal strings are the bind path for round-trip fidelity
  through execute, prepared and the proven bulk strategy.
- `affectedRows` is an operational count with safe-range validation.
- Ordinary `undefined` IN values fail before acquisition with
  `BRAID_BIND_VALUE_UNSUPPORTED`. `null` is SQL `NULL`.
- The public typings of Connector 3.5.4 do not expose a `jsonStrings` option.
  Thus, use `autoJsonMap: false` for text. Do not describe it as a mysql2
  profile.
