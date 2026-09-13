# @sqlbraid/sqlite

SQLite SQL dialect, Node `node:sqlite` adapter, and metadata inspector for SQLBraid.

```sh
npm install @sqlbraid/sqlite
```

```ts
import { sql } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
const query = sql`SELECT * FROM users WHERE id = ${1}`;
```

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for connection and inspection setup.
