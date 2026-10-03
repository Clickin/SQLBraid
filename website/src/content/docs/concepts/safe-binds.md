---
title: Safe binds
description: Keep values as driver parameters and make structural SQL explicit.
---

Each ordinary interpolation is a bind:

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE organization_id = ${organizationId}
    AND status = ${status}
`;
```

Rendering first produces one immutable logical statement:

- `segments` contains the resolved structural SQL.
- `parameters` contains the ordered value records: `value`, an optional
  `interpolation` and an optional `hint`.

The invariant is `segments.length === parameters.length + 1`. An interpolated
value never becomes SQL source.

The selected driver materializes that statement only after the pure binding
description and the hint validation. The driver owns the physical transport. It
can emit `$1`, `?`, `:1`, `@p1`, named bindings or a native value-template
request. The dialect and the template renderer are not responsible for the
placeholder syntax.

If the database parameter type must be explicit, use `sql.bind(value, hint)`:

```ts
import { mssqlParameter, sql } from "sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(displayName, mssqlParameter.nvarchar(200))}
`;
```

`${value}` uses the normal inference of the driver. `${sql.bind(value, hint)}` requests an explicit database parameter type. SQLBraid does not infer a universal database type from a TypeScript `number`, `string` or `Date`. This API sets parameter types. It is not application input validation and not a codec framework. Read [parameter type hints](/SQLBraid/concepts/parameter-hints/).

## You must ask for structural input explicitly

Identifiers and SQL fragments are different from data. Use the explicit helpers in [structural SQL fragments](/SQLBraid/concepts/structural-fragments/):

```ts
const order = sql.ident(sortColumn);
const query = sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY ${order}
`;
```

`sql.ident` quotes identifier parts. `sql.raw` is an escape hatch for SQL text that your application already trusts. It does not validate or sanitize input. Do not give text that a user controls to `sql.raw`.

Lists are still binds:

```ts
const ids = [10, 20, 30];
const query = sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id IN (${sql.list(ids)})
`;
```

`sql.list([])` throws `BRAID_EMPTY_LIST`. Select an explicit strategy for an empty set, or guard the clause with `@braid if`.

The render limits of SQLBraid also limit the SQL byte size, the bind count, the structural items and the nesting depth. If an application needs stricter limits, configure them with `createSqlTag({ dialect, limits })`.

PostgreSQL, MySQL and SQLite explicitly reject ordinary hints with
`BRAID_BIND_HINT_UNSUPPORTED`. They never silently ignore a hint. The PostgreSQL
`postgresParameter.refcursor()` is only for routines. It classifies an OUT or
INOUT portal. If you need a different database type API, use the matching
first-party Oracle or SQL Server adapter.
