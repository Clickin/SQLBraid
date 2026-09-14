# @sqlbraid/mariadb

MariaDB SQL dialect and official MariaDB Connector/Node.js adapter for SQLBraid.

The MariaDB 11.8.9 / Connector 3.5.4 / Node 22.18.0 exact profile passed a
historical PV16 release dry-run
([34818113561](https://github.com/Clickin/SQLBraid/actions/runs/34818113561)) at
`2890ef65d15ac96a7e3471911b381340aa30579a`. This is provenance only: it is not
fresh evidence for the current tree, an npm publication, or a certification of
other driver/server profiles.

```sh
npm install @sqlbraid/mariadb mariadb
```

```ts
import { sql } from "@sqlbraid/mariadb";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";

const db = createMariaDbDatabase(connection);
const rows = await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM users WHERE id = ${"1"}`);
```

The adapter uses the Connector/Node.js value-only `execute()` path for materialized
queries, `queryStream()` for native row streaming, and `connection.batch()` for
homogeneous bulk DML. Connector metadata determines row versus command results;
multiple result sets are available through `db.call()` and are rejected by
ordinary query methods.

An active `AbortSignal` is honored only when the connector can cancel the
physical operation. Otherwise the adapter rejects before I/O with
`UnsupportedFeatureError` / `BRAID_CANCEL_UNSUPPORTED`; an already
aborted signal preserves its `reason`. Transaction options and stream/call
support remain capability-driven.

`db.session()` pins one provider lease and nested `db.tx()` work reuses it
without reacquiring. Transaction options are the fixed isolation literals plus
`readOnly`; malformed values fail as `BRAID_TX_OPTIONS_INVALID`, unsupported
valid values as `BRAID_TX_OPTION_UNSUPPORTED`, and nested explicit options as
`BRAID_TX_OPTIONS_NESTED`.

## Representation profiles

Configure the Connector/Node.js connection with the exported immutable
`MARIADB_LOSSLESS_TEXT` descriptor:

```ts
import mariadb from "mariadb";
import { MARIADB_LOSSLESS_TEXT } from "@sqlbraid/mariadb";

const connection = await mariadb.createConnection({
  ...connectionOptions,
  ...MARIADB_LOSSLESS_TEXT.connectionOptions,
});
const db = createMariaDbDatabase(connection, { profile: MARIADB_LOSSLESS_TEXT });
```

`DECIMAL`/`NUMERIC` and all integer result columns are exposed by SQLBraid as
decimal strings; `FLOAT`/`DOUBLE` remain JavaScript numbers. `insertId` is also
normalized to a decimal string, while `affectedRows` is returned as a safe
non-negative number and rejects an unsafe connector count. Native connector
batch execution uses the same string bind values as ordinary execution.

`MARIADB_NATIVE` is available as a parsed-object/Date compatibility profile;
nested JSON numbers may already have passed through JavaScript `JSON.parse` and
therefore are not lossless. `dateStrings: true` preserves DATE/TIME/DATETIME
text, including fractional seconds; `timezone` must be chosen explicitly when
TIMESTAMP values are used. MariaDB Connector does not expose effective
connection options publicly, so pass the matching descriptor explicitly when
using a non-default profile. SQLBraid does not add a JSON parser or temporal
type dependency.

MariaDB-specific DML `RETURNING` is supported by the database's native syntax:
use `sql.rows` with `INSERT ... RETURNING`, `DELETE ... RETURNING`, or
`REPLACE ... RETURNING` on a server version that documents the form. The adapter
does not claim `UPDATE ... RETURNING`, and `INSERT ... ON DUPLICATE KEY UPDATE ... RETURNING`
is only a server-version-tested capability.
`ON DUPLICATE KEY UPDATE` and `REPLACE` are classified as native UPSERT
forms, not SQL `MERGE`.

Bulk uses one Connector/Node.js `connection.batch()` call with one SQL shape and
N value sets. Root bulk has no portable transaction or auto-chunking promise;
use `db.tx(async (tx) => tx.bulk(...))` for callback atomicity. Native
DML-returning streams are not a PV16 support claim.

The Connector/Node.js profile records exact server and runtime versions in the
support manifest. Connector options are profile data, not assumptions shared with
mysql2. See the
[data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
