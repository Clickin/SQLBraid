# @sqlbraid/bun-sql

SQLBraid adapter for Bun's `Bun.SQL` client.

```sh
pnpm add @sqlbraid/bun-sql @sqlbraid/postgres
```

This adapter uses the native value-template transport of Bun. `Bun.SQL` does not infer the dialect. You must give the dialect explicitly, for example `"postgres"`.

## Example

This example uses an in-memory SQLite database. It needs Bun 1.3.14 or later and no database server.

```sh
pnpm add sqlbraid @sqlbraid/bun-sql @sqlbraid/sqlite
```

```ts
import { createBunSqlDatabase } from "@sqlbraid/bun-sql";
import { sql } from "@sqlbraid/sqlite";

interface UserRow {
  id: string;
  name: string;
}

const client = new Bun.SQL("sqlite://:memory:");
try {
  const db = createBunSqlDatabase(client, { dialect: "sqlite" });
  await db.execute(sql.command`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
  await db.execute(sql.command`INSERT INTO users (name) VALUES (${"Ada"})`);
  console.log(await db.all(sql.rows<UserRow>`SELECT CAST(id AS TEXT) AS id, name FROM users`));
} finally {
  await client.close();
}
```

Run it with `bun run index.ts`. The output is `[{ id: "1", name: "Ada" }]`.

Bun.SQL returns an integer as a JavaScript `number`, without column type metadata.
SQLBraid rejects such a value with `BRAID_RESULT_EXACTNESS`. Cast exact integers to text in the SQL, as the example does.

### Key Details

- **Tested version**: Bun 1.3.14.
- **Capabilities**: Streams, routine calls and active cancellation are unsupported. They fail with explicit `BRAID_*` errors.
- **Precision**: Exact integers are strings. Exact decimals are strings in PostgreSQL. In MySQL, MariaDB and SQLite, exact decimals are unsupported.
  See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) and the [Bun SQL guide](https://bun.com/docs/runtime/sql) for details.
