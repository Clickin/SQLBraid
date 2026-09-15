# @sqlbraid/mariadb

MariaDB dialect and official MariaDB Connector/Node.js adapters for SQLBraid.

```sh
npm install @sqlbraid/mariadb mariadb
```

The application creates and connects the MariaDB Connector/Node.js connection
or pool. Configure the lossless profile on that connection before creating the
SQLBraid database.

```ts
import mariadb from "mariadb";
import { MARIADB_LOSSLESS_TEXT, sql } from "@sqlbraid/mariadb";
import { createMariaDbPoolDatabase } from "@sqlbraid/mariadb/mariadb";

const pool = mariadb.createPool({
  host: process.env.MARIADB_HOST,
  user: process.env.MARIADB_USER,
  password: process.env.MARIADB_PASSWORD,
  database: process.env.MARIADB_DATABASE,
  ...MARIADB_LOSSLESS_TEXT.connectionOptions,
});
const db = createMariaDbPoolDatabase(pool, { profile: MARIADB_LOSSLESS_TEXT });
const rows = await db.all(sql.rows<{ id: string }>`
  SELECT CAST(1 AS BIGINT) AS id
`);
// rows[0].id is the exact decimal string "1"
```

For a connected connection, use `createMariaDbDatabase(connection)` from
`@sqlbraid/mariadb/mariadb`. Connections and pools are supplied by the
application.

## Default result representations

`MARIADB_LOSSLESS_TEXT` sets `bigIntAsNumber: false`, `decimalAsNumber: false`,
`insertIdAsNumber: false`, `autoJsonMap: false`, `dateStrings: true`, and
`timezone: "Z"`. With that profile:

- MariaDB integer types and `DECIMAL`/`NEWDECIMAL` are decimal `string` values.
- `FLOAT` and `DOUBLE` are JavaScript `number` values.
- JSON, DATE, DATETIME, TIMESTAMP, and TIME values are strings.
- Text values are strings, binary values are `Uint8Array` values, `insertId`
  is a decimal string, and `affectedRows` is a number.

The root package also exports `MARIADB_NATIVE`, `MARIADB_JSON_TEXT`,
`MARIADB_DATE_TEXT`, `representationProfiles`, and `typePolicyForProfile` for
intentional JSON and temporal representation changes. Pass the matching
profile explicitly when using a wrapper that hides Connector/Node.js options.

`db.stream()` uses Connector/Node.js `queryStream()`. `db.bulk()` uses one
native `connection.batch()` call for one SQL shape and many value sets; wrap it
in `db.tx(async (tx) => tx.bulk(...))` when callback atomicity is needed.
Root bulk does not automatically chunk input. Active cancellation is honored
only when the connector can cancel the physical operation; otherwise it is
rejected before I/O.

Use MariaDB's documented native `RETURNING` syntax with `sql.rows` where the
server version supports it. SQLBraid does not rewrite MySQL-family writes.
Routine result sets can be consumed through the normal routine API, but OUT
and INOUT carriers are not claimed by this adapter.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/),
[MariaDB setup](https://clickin.github.io/SQLBraid/getting-started/mariadb/), and
[data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
