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

Driver entrypoints combine the existing dialect/query API with the matching
adapter: `sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/mariadb`,
`sqlbraid/node-sqlite`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`,
`sqlbraid/oracledb`, `sqlbraid/tedious`, and `sqlbraid/bun-sql`.
Dialect-only entrypoints are available for custom adapters at
`sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/mariadb`, `sqlbraid/sqlite`,
`sqlbraid/oracle`, and `sqlbraid/mssql`. The root exports common runtime
contracts and database constructors without selecting a default dialect.

The granular `@sqlbraid/*` packages remain supported for library authors,
custom integrations, and deliberately narrower dependencies. Metadata, codegen,
compiler, Vite, and CLI tooling remain optional. Install the existing CLI with:

```sh
pnpm add -D @sqlbraid/cli
npx sqlbraid codegen --check
```

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
