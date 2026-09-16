# MariaDB quickstart

> Connect SQLBraid to MariaDB Connector/Node.js while keeping MariaDB syntax explicit.

Install the SQLBraid runtime facade and the official Connector/Node.js driver:

```bash
npm install sqlbraid mariadb
```

Use the `/mariadb` adapter subpath with a connected connection or an explicit
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

The dialect is `mariadb`, not `mysql`. MariaDB-specific syntax remains authored
SQL. Current capability fixtures cover documented `INSERT ... RETURNING`,
`DELETE ... RETURNING`, `REPLACE ... RETURNING`, sequences, CTEs, and JSON
functions. `UPDATE ... RETURNING` is not claimed; an
`INSERT ... ON DUPLICATE KEY UPDATE ... RETURNING` form requires matching
server evidence before it is listed as supported.

The adapter uses Connector/Node.js value-only execution, native row streaming,
and one `connection.batch()` call for `db.bulk()` (`native-bulk`). Root bulk is
not implicitly transactional and has no portable auto-chunking promise. Use
`db.tx()` when callback transaction atomicity is required.

A `mysql2` connection may work against MariaDB as best-effort compatibility, but
it is not MariaDB protocol evidence. The official certified profile is MariaDB
11.8.9 / Connector 3.5.4 / Node 22.18.0. The [runtime and driver support
matrix](/SQLBraid/latest/reference/support.md) records labels for the exact
database/driver/profile/runtime/capability tuple and its revision and workflow
evidence. A neighboring version or package installation is not certification.
Final exact-SHA Runtime, Docs, and Release gates and explicit release
authorization remain separate requirements.

## Connector/Node.js representation profile

The first-party MariaDB profile is `mariadb-lossless-text`: the official
Connector/Node.js adapter with the exact options selected by its
`representationProfiles` descriptor. `@sqlbraid/mariadb` exports
`typePolicyForProfile({ json, temporal })` so runtime and codegen reuse one
immutable TypePolicy. `mariadb-native` is a separate convenience profile. A
mysql2 connection to MariaDB is a separate best-effort compatibility profile.

Connector/Node.js does not expose effective options. An omitted descriptor or
partial option declaration reports `mariadb-custom-profile`, not a certified
profile. Explicit descriptors remain guarded declarations, not observations.

| MariaDB value | Driver raw / SQLBraid canonical representation | Caveat |
| --- | --- | --- |
| TINYINT/SMALLINT/INT/BIGINT | driver-dependent → `string` | Exact integer results are canonical text; `decodeExactInteger` is an application opt-in. |
| DECIMAL/NUMERIC | text → `string` | Exact precision and scale remain text; use an application decimal transform if needed. |
| FLOAT/DOUBLE | number → `number` | Approximate binary values remain JavaScript numbers. |
| JSON alias | text with `autoJsonMap:false` → `string` | `autoJsonMap:true` is a separate convenience profile and does not guarantee nested numeric fidelity. |
| DATE/TIME/DATETIME | text with `dateStrings:true` → `string` | Native `Date` is a separate convenience profile and may lose fractional/zone detail. |
| BLOB | bytes/Buffer | Preserve bytes or explicitly encode. |

The adapter uses value-only execution, native `queryStream()`, and one
`connection.batch()` call for homogeneous bulk. Native `RETURNING` is a
materialized row contract only where the exact server form is evidenced:
`INSERT`, `DELETE`, and `REPLACE` are separate capabilities; `UPDATE` is not
claimed. SQL passes through transparently; this is not MariaDB grammar support.

`db.call()` materializes heterogeneous emitted sets from prepared `CALL`; OUT,
INOUT and cursor descriptors remain unsupported. `db.prepare()` preserves
query-bound Standard Schema mapping. The optional `/inspector` subpath records
identity, generated/write flags and numeric precision/scale for offline
`generateModels()`; routine signatures remain incomplete positive evidence.

The `mariadb-lossless-text` descriptor keeps `bigintAsNumber: false`,
`decimalAsNumber: false`, `insertIdAsNumber: false`, `autoJsonMap: false`,
`dateStrings: true`, and `timezone: "Z"`. Exact integer/decimal strings are the bind path for
round-trip fidelity through execute, prepared and the proven bulk strategy.
`affectedRows` is an operational count with safe-range validation. `undefined`
ordinary IN values fail before acquisition with
`BRAID_BIND_VALUE_UNSUPPORTED`; `null` is SQL `NULL`. Connector 3.5.4 does not
expose a `jsonStrings` option in its public typings, so use `autoJsonMap: false`
for text and do not describe it as a mysql2 profile.
