---
title: Structural SQL fragments
description: Make identifiers, lists, joins and trusted raw SQL visible in the API.
---

If an interpolation changes the SQL structure and does not supply a value, use a structural helper:

```ts
const column = sql.ident("created_at");
const direction = sql.raw(sortDescending ? "DESC" : "ASC");
const ids = sql.list([10, 20, 30]);

const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  WHERE id IN (${ids})
  ORDER BY ${column} ${direction}
`;
```

- `sql.ident("schema.table")` quotes each identifier part.
- `sql.fragment` creates a dialect-bound fragment. The fragment can contain ordinary binds.
- `sql.list(values)` emits one bind for each value. It rejects an empty array.
- `sql.join(fragments, separator)` combines only fragments. It rejects ordinary values.
- `sql.raw(text)` emits trusted SQL text without quotes.
- `sql.empty` is an empty dialect-bound fragment.

Each fragment carries the dialect that created it. If you combine a PostgreSQL fragment with a MySQL or SQLite tag, SQLBraid throws `BRAID_DIALECT`.

A safe helper can limit a choice that the user makes, before the choice gets to `sql.ident` or `sql.raw`:

```ts
const columns = { name: sql.ident("name"), created: sql.ident("created_at") } as const;
const order = columns[sortKey as keyof typeof columns] ?? columns.name;
```

`sql.raw` stays explicit on purpose. SQLBraid cannot prove that arbitrary SQL text is trusted.
