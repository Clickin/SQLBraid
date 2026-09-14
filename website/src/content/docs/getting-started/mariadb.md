---
title: MariaDB quickstart
description: Connect SQLBraid to MariaDB Connector/Node.js while keeping MariaDB syntax explicit.
---

Install the separate MariaDB dialect and the official Connector/Node.js driver:

```bash
npm install @sqlbraid/mariadb mariadb
```

Use the `/mariadb` adapter subpath with a connected connection or an explicit
pool factory:

```ts
import mariadb from "mariadb";
import { sql } from "@sqlbraid/mariadb";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";

const connection = await mariadb.createConnection({
  host: "127.0.0.1",
  user: "sqlbraid",
  password: "password",
  database: "app",
});
const db = createMariaDbDatabase(connection);
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
it is not Official MariaDB syntax or protocol evidence. The certified profile
is MariaDB 11.8.9 / Connector 3.5.4 / Node 22.18.0; its revision-specific
release evidence is recorded in the support manifest, not inferred from
package installation.

## Connector/Node.js representation profile

The first-party MariaDB profile is the official Connector/Node.js adapter on
the exact Node/server combination named by the support manifest. A mysql2
connection to MariaDB is a separate best-effort compatibility profile.

| MariaDB value | Connector representation | Caveat |
| --- | --- | --- |
| TINYINT/SMALLINT/INT/BIGINT | `string` | Exact integer results are canonical text; `decodeExactInteger` is an application opt-in. |
| DECIMAL/NUMERIC | `string` | Exact precision and scale remain text; use an application decimal transform if needed. |
| FLOAT/DOUBLE | `number` | Approximate binary values remain JavaScript numbers. |
| JSON alias | text with `autoJsonMap: false` | Parsed `autoJsonMap: true` is a convenience profile and does not guarantee nested numeric fidelity. |
| DATE/TIME/DATETIME | text with `dateStrings: true` | Native `Date` is a separate convenience profile and may lose fractional/zone detail. |
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

The documented exact profile keeps `decimalAsNumber: false` and
`insertIdAsNumber: false`. Exact integer/decimal strings are the bind path for
round-trip fidelity through execute, prepared and the proven bulk strategy.
`affectedRows` is an operational count with safe-range validation. `undefined`
ordinary IN values fail before acquisition with
`BRAID_BIND_VALUE_UNSUPPORTED`; `null` is SQL `NULL`. Connector 3.5.4 does not
expose a `jsonStrings` option in its public typings, so use `autoJsonMap: false`
for text and do not describe it as a mysql2 profile.
