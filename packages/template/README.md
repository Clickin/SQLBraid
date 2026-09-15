# @sqlbraid/template

Tagged-template primitives for custom SQLBraid dialects and adapters. The
default `sql` tag uses SQLBraid's PostgreSQL lexical profile; database packages
provide ready-to-use dialect tags.

```sh
npm install @sqlbraid/template
```

```ts
import { createSqlTag, sql } from "@sqlbraid/template";
import type { Dialect } from "@sqlbraid/core";

const query = sql.rows<{ id: number }>`
  SELECT id FROM users WHERE id = ${1}
`;
const routine = sql.call({ resultSets: [] as const })`
  CALL refresh_accounts(${1})
`;

declare const customDialect: Dialect; // supply a dialect implementation
const customSql = createSqlTag({ dialect: customDialect });
```

The tag supports `rows`, `command`, and `call` queries plus `bind`, `out`,
`inOut`, `fragment`, `empty`, `ident`, `raw`, `join`, and `list` helpers.
`/*@braid if ...*/`, `choose`, `where`, `set`, and `trim` directives provide
structural templates. Rendered queries remain logical statements until an
adapter chooses its transport.

See the [SQL tags and routine guide](https://clickin.github.io/SQLBraid/concepts/routines/)
and the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
