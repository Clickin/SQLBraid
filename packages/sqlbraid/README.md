# sqlbraid

The canonical entry point for applications. The root import is database-neutral. To query a database, install its driver and import the matching `sqlbraid/<driver>` subpath.

```sh
npm install sqlbraid pg
```

```ts
import { Client } from "pg";
import { createPgDatabase, sql } from "sqlbraid/pg";

const client = new Client({ connectionString: "postgres://localhost:5432/app" });
await client.connect();

const db = createPgDatabase(client);
const users = await db.all(sql.rows<{ id: string }>`
  SELECT id FROM users
`);

await client.end();
```

### Driver Entry Points

The root import is database-neutral. It does not export an implicit `sql` tag. These entry points combine a driver and a dialect:
`sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`, `sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`, `sqlbraid/oracledb` and `sqlbraid/tedious`.
For Bun.SQL, use `sqlbraid/bun-sql` and select the dialect explicitly. Import `sql` from the matching dialect-only subpath.

The `node:sqlite` adapter uses the module that is part of Node. It does not need a separate driver package.

For custom adapters, use the dialect-only entry points:
`sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle` and `sqlbraid/mssql`.

`sqlbraid/compiled` is an advanced entry point for compiler-generated code. It is not an API for applications to write queries.

See the [full package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) and [driver support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/).
See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
