---
title: Safe binds
description: Keep values as driver parameters and make structural SQL explicit.
---

Every ordinary interpolation is a bind:

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE organization_id = ${organizationId}
    AND status = ${status}
`;
```

The rendered text contains a dialect placeholder (`$1`, `?`, and so on) and the values are passed separately to the adapter. A value never becomes SQL source merely because it was interpolated.

## Structural input is opt-in

Identifiers and SQL fragments are different from data. Use the explicit helpers in [structural SQL fragments](/SQLBraid/concepts/structural-fragments/):

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
