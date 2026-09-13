# @sqlbraid/oracle

Oracle SQL dialect, node-oracledb Thin-mode adapters, and metadata inspector for SQLBraid.

```sh
npm install @sqlbraid/oracle oracledb
```

The portable root has no driver import:

```ts
import { oracleParameter, sql } from "@sqlbraid/oracle";

const query = sql`SELECT * FROM users WHERE id = ${sql.bind(42n, oracleParameter.number())}`;
```

Use the Node.js adapter subpath with node-oracledb 7.0.1 (Thin mode is the first-party target):

```ts
import oracledb from "oracledb";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";

const connection = await oracledb.getConnection({ user, password, connectString });
const db = createOracledbDatabase(connection);
```

`createOracledbPoolProvider` and `createOracledbPoolDatabase` preserve physical pool leases. Oracle ResultSet streaming closes cursors on completion, early return, and abort. Routine calls are explicitly unsupported until an OUT/IN OUT descriptor is added.

`@sqlbraid/oracle/inspector` reads positive evidence from Oracle `ALL_*` catalog views. It reports visible objects and leaves unknown or inaccessible semantics unknown. Thick mode and Bun/Deno driver subpaths are not claimed Official in this release.

The integration fixture is pinned to `gvenzl/oracle-free:23.9-slim-faststart` (service `FREEPDB1`). Set `SQLBRAID_ORACLE_URL`, `SQLBRAID_ORACLE_USER`, and `SQLBRAID_ORACLE_PASSWORD` to use an external Oracle instance instead.
