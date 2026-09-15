# @sqlbraid/mysql

MySQL dialect and `mysql2` adapters for SQLBraid.

```sh
npm install @sqlbraid/mysql mysql2
```

The application creates and connects the `mysql2` connection or pool. Use the
lossless profile options when exact integer and decimal text is required.

```ts
import mysql from "mysql2/promise";
import { MYSQL2_LOSSLESS_TEXT, sql } from "@sqlbraid/mysql";
import { createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
});
const db = createMysql2PoolDatabase(pool, { profile: MYSQL2_LOSSLESS_TEXT });
const rows = await db.all(sql.rows<{ id: string }>`
  SELECT CAST(1 AS BIGINT) AS id
`);
// rows[0].id is the exact decimal string "1"
```

For a connected `mysql2` connection, use `createMysql2Database(connection)`
from `@sqlbraid/mysql/mysql2`. The connection or pool is always supplied by
the application.

## Default result representations

`MYSQL2_LOSSLESS_TEXT` configures `supportBigNumbers: true`,
`bigNumberStrings: true`, `decimalNumbers: false`, `rowsAsArray: false`,
`jsonStrings: true`, and `dateStrings: true`. Under this profile:

- MySQL integer types and `DECIMAL`/`NEWDECIMAL` are decimal `string` values.
- `FLOAT` and `DOUBLE` are JavaScript `number` values.
- JSON and DATE/DATETIME/TIMESTAMP values are strings.
- Text values are strings, binary values are `Uint8Array` values (a `Buffer`
  from mysql2 is a `Uint8Array`), and `affectedRows` is a number.

The root package also exports `MYSQL2_NATIVE`, `MYSQL2_JSON_TEXT`,
`MYSQL2_DATE_TEXT`, `representationProfiles`, and `typePolicyForProfile` for
intentional JSON/temporal representation changes. Pass the matching profile
to the adapter when a wrapper does not expose mysql2 connection options.

MySQL has no generic PostgreSQL-style DML `RETURNING`; SQLBraid does not
rewrite writes. Use native MySQL syntax and a separate query when returned
rows are needed. `db.stream()` uses mysql2's prepared `execute().stream()`
path and accepts `streamHighWaterMark`. Active cancellation destroys the
physical connection and the pool must replace it. If an adapter connection
cannot be destroyed, an active signal is rejected before I/O.

Routine result sets are available through `db.call()`. OUT and INOUT
parameters are not mapped by this adapter because mysql2 has no stable public
carrier for their extra result. Stored functions do not emit result sets.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/),
[MySQL setup](https://clickin.github.io/SQLBraid/getting-started/mysql/), and
[data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
