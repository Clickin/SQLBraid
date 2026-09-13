# @sqlbraid/mssql

Microsoft SQL Server dialect, Tedious adapter, and conservative catalog inspector for SQLBraid.

```sh
npm install @sqlbraid/mssql tedious
```

```ts
import { mssqlParameter, sql } from "@sqlbraid/mssql";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";

const query = sql.rows`
  SELECT id, display_name
  FROM dbo.users
  WHERE display_name = ${sql.bind("Ada", mssqlParameter.nvarchar(200))}
`;
const db = createTediousDatabase(connection);
const rows = await db.all(query);
```

The `./tedious` and `./inspector` entry points import Tedious and therefore
require the optional `tedious` peer. The portable root entry point does not
load a driver.

Ordinary strings, booleans, dates, safe numbers, bigint values, and
`Uint8Array` values use conservative adapter-local inference. `null` and
custom values require an explicit hint. Decimal and numeric inputs are
limited to values Tedious can represent without a JavaScript-number precision
loss; high-precision decimal strings are rejected before I/O.

The inspector reports positive evidence from SQL Server `sys` catalogs and
leaves result-set and routine facts unknown when the catalog does not prove
them. Tedious output parameters are currently unsupported and fail with
`BRAID_CALL_OUT_UNSUPPORTED`; result sets from `database.call()` remain
separate.
