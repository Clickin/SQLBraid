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

Use a database-specific package when you need PostgreSQL, MySQL, MariaDB, SQLite, Oracle, or SQL Server rendering. `sql.out(name, hint?)` is valid in row-returning DML and `sql.call` queries; `sql.inOut(name, value, hint?)` remains call-only. Drivers must support the selected output channel and native syntax.

See the [SQL tags and routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).
