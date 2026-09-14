# @sqlbraid/mariadb

MariaDB SQL dialect and official MariaDB Connector/Node.js adapter for SQLBraid.

The MariaDB 11.8.9 / Connector 3.5.4 / Node 22.18.0 exact profile passed
[PV16 release dry-run](https://github.com/Clickin/SQLBraid/actions/runs/34818113561)
at `2890ef65d15ac96a7e3471911b381340aa30579a`. This is not an npm publication
or a certification of other driver/server profiles.

```sh
npm install @sqlbraid/mariadb mariadb
```

```ts
import { sql } from "@sqlbraid/mariadb";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";

const db = createMariaDbDatabase(connection);
const rows = await db.all(sql.rows<{ readonly id: number }>`SELECT id FROM users WHERE id = ${1}`);
```

The adapter uses the Connector/Node.js value-only `execute()` path for materialized
queries, `queryStream()` for native row streaming, and `connection.batch()` for
homogeneous bulk DML. Connector metadata determines row versus command results;
multiple result sets are available through `db.call()` and are rejected by
ordinary query methods.

MariaDB-specific DML `RETURNING` is supported by the database's native syntax:
use `sql.rows` with `INSERT ... RETURNING`, `DELETE ... RETURNING`, or
`REPLACE ... RETURNING` on a server version that documents the form. The adapter
does not claim `UPDATE ... RETURNING`, and `INSERT ... ON DUPLICATE KEY UPDATE ...
RETURNING` is only a server-version-tested capability.

Bulk uses one Connector/Node.js `connection.batch()` call with one SQL shape and
N value sets. Root bulk has no portable transaction or auto-chunking promise;
use `db.tx(async (tx) => tx.bulk(...))` for callback atomicity. Native
DML-returning streams are not a PV16 support claim.

The Connector/Node.js profile records exact server and runtime versions in the
support manifest. BIGINT `bigint`, DECIMAL strings, JSON parser settings, temporal values,
and binary bytes are profile data, not assumptions shared with mysql2. See the
[data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
