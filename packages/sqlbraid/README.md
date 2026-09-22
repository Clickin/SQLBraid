# sqlbraid

The main entry point for SQLBraid. Use this package to choose a driver, write typed SQL, and execute queries.

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
Import the combined driver and dialect for your database:
`sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`, `sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`, `sqlbraid/oracledb`, and `sqlbraid/tedious`.

For custom adapters, use the dialect-only entry points:
`sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle`, and `sqlbraid/mssql`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

