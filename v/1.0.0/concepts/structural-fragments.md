# Structural SQL fragments

> Make identifiers, lists, joins, and trusted raw SQL visible in the API.

Use a structural helper when interpolation changes SQL structure rather than supplying a value:

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
- `sql.fragment` creates a dialect-bound fragment with ordinary binds inside it.
- `sql.list(values)` emits one bind per value and rejects an empty array.
- `sql.join(fragments, separator)` combines fragments only; it rejects ordinary values.
- `sql.raw(text)` emits trusted SQL text without quoting.
- `sql.empty` is an empty dialect-bound fragment.

Fragments carry the dialect that created them. Combining a PostgreSQL fragment with a MySQL or SQLite tag throws `BRAID_DIALECT`.

A safe helper can restrict a user-facing choice before it reaches `sql.ident` or `sql.raw`:

```ts
const columns = { name: sql.ident("name"), created: sql.ident("created_at") } as const;
const order = columns[sortKey as keyof typeof columns] ?? columns.name;
```

`sql.raw` remains intentionally explicit because SQLBraid cannot prove that arbitrary SQL text is trusted.
