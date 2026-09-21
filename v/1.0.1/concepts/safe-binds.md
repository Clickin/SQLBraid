# Safe binds

> Keep values as driver parameters and make structural SQL explicit.

Every ordinary interpolation is a bind:

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE organization_id = ${organizationId}
    AND status = ${status}
`;
```

Rendering first produces one immutable logical statement: `segments` contains
resolved structural SQL and `parameters` contains ordered value records
(`value`, optional `interpolation`, optional `hint`). The invariant is
`segments.length === parameters.length + 1`. A value never becomes SQL source
merely because it was interpolated.

The selected driver materializes that statement only after pure binding
description and hint validation. It owns the physical transport and may emit
`$1`, `?`, `:1`, `@p1`, named bindings, or a native value-template request.
Placeholder syntax is not a dialect or template-renderer responsibility.

When the database parameter type must be explicit, use `sql.bind(value, hint)`:

```ts
import { mssqlParameter, sql } from "sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(name, mssqlParameter.nvarchar(200))}
`;
```

`${value}` uses the driver's normal inference. `${sql.bind(value, hint)}` requests an explicit database parameter type. SQLBraid does not infer a universal database type from a TypeScript `number`, `string`, or `Date`; this API is parameter typing, not application input validation or a codec framework. See [parameter type hints](/SQLBraid/v/1.0.1/concepts/parameter-hints.md).

## Structural input is opt-in

Identifiers and SQL fragments are different from data. Use the explicit helpers in [structural SQL fragments](/SQLBraid/v/1.0.1/concepts/structural-fragments.md):

```ts
const order = sql.ident(sortColumn);
const query = sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY ${order}
`;
```

`sql.ident` quotes identifier parts. `sql.raw` is an escape hatch for SQL text that your application already trusts; it does not validate or sanitize input. Never feed user-controlled text to `sql.raw`.

Lists are still binds:

```ts
const ids = [10, 20, 30];
const query = sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id IN (${sql.list(ids)})
`;
```

`sql.list([])` throws `BRAID_EMPTY_LIST`; choose an explicit empty-set strategy or guard the clause with `@braid if`.

SQLBraid's render limits also bound SQL byte size, bind count, structural items, and nesting depth. Configure limits through `createSqlTag({ dialect, limits })` when an application needs stricter bounds.

PostgreSQL, MySQL, and SQLite explicitly reject ordinary hints with
`BRAID_BIND_HINT_UNSUPPORTED`; they never silently ignore one. PostgreSQL's
routine-only `postgresParameter.refcursor()` classifies an OUT/INOUT portal.
Use the matching first-party Oracle or SQL Server adapter when another database
type API is required.
