# @sqlbraid/template

Dialect-neutral SQL tagged-template primitives for SQLBraid integrations.

```sh
npm install @sqlbraid/template
```

```ts
import { sql } from "@sqlbraid/template";
const query = sql`SELECT * FROM users WHERE id = ${1}`;
```

Use a database-specific package when you need PostgreSQL, MySQL, or SQLite rendering. See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
