# sqlbraid

The canonical SQLBraid runtime package for application developers.

```sh
pnpm add sqlbraid pg
```

```ts
import { createPgDatabase, sql } from "sqlbraid/pg";

const db = createPgDatabase(client);
const users = await db.all(sql.rows<{ id: string }>`
  SELECT id FROM users
`);
```

Combined driver+dialect/query entrypoints use the matching adapter:
`sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/mariadb`,
`sqlbraid/node-sqlite`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`,
`sqlbraid/oracledb`, and `sqlbraid/tedious`.

`sqlbraid/bun-sql` is a multi-dialect Bun.SQL adapter. Select the SQLBraid
dialect/query API separately and pass the same dialect explicitly:

```ts
import { createBunSqlDatabase } from "sqlbraid/bun-sql";
import { sql } from "sqlbraid/postgres";

const client = new Bun.SQL(process.env.DATABASE_URL!);
const db = createBunSqlDatabase(client, { dialect: "postgres" });
```

Dialect-only entrypoints are available for custom adapters at
`sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle`,
and `sqlbraid/mssql`. The root exports common runtime contracts and database
constructors without selecting a default dialect.

The granular `@sqlbraid/*` packages remain supported for library authors,
custom integrations, and deliberately narrower dependencies. Metadata, codegen,
compiler, Vite, and CLI tooling remain optional. Install the existing CLI with:

```sh
pnpm add -D @sqlbraid/cli
npx sqlbraid codegen --check
```

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
