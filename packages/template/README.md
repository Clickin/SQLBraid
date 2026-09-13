# @sqlbraid/template

Dialect-neutral SQL tagged-template primitives for SQLBraid integrations.

```sh
npm install @sqlbraid/template
```

```ts
import { sql } from "@sqlbraid/template";
const query = sql.rows<{ id: number }>`SELECT id FROM users WHERE id = ${1}`;
const routine = sql.call({ resultSets: [] as const })`CALL refresh_accounts(${1})`;
```

Use a database-specific package when you need PostgreSQL, MySQL, SQLite, Oracle, or SQL Server rendering. Routine parameters use `sql.out(name, hint?)` and `sql.inOut(name, value, hint?)`; they are valid only in `sql.call` queries.

See the [SQL tags and routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).
