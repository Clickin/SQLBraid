# @sqlbraid/postgres

PostgreSQL SQL dialect, pg database adapters, and metadata inspector for SQLBraid.

```sh
npm install @sqlbraid/postgres pg
```

```ts
import { sql } from "@sqlbraid/postgres";
import { createPgDatabase } from "@sqlbraid/postgres/pg";
const query = sql`SELECT * FROM users WHERE id = ${1}`;
```

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for connection and inspection setup.
