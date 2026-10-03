# Query construction

Use this reference when you write or review SQLBraid statements.

## Result declarations

```ts
const rows = sql.rows<UserRow>`SELECT id, name FROM users`;
const command = sql.command`UPDATE users SET active = true WHERE id = ${id}`;
```

Use `sql.call(...)` for routine semantics. Use plain `sql` only when the result kind of the statement is really unknown.

`sql.rows<T>` declares a TypeScript row type. It does not validate rows at runtime. It does not infer the selected shape from the SQL. Keep the declared row type the same as the selected columns. When validation or transformation is necessary, use the Standard Schema mapping of the project.

Cardinality is explicit:

- `db.one(...)` requires exactly one row.
- `db.maybeOne(...)` permits zero rows or one row.
- `db.all(...)` returns the row set.

## Value binding

Every ordinary interpolation is a value bind:

```ts
sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`;
```

The driver owns the materialization of physical placeholders or native requests. Do not write `$1`, `?`, `:1`, `@p1` or named placeholders for SQLBraid.

Use `sql.bind(value, hint)` only when the selected first-party adapter supports the requested parameter hint. Do not infer a universal database type from a TypeScript primitive.

## Structural SQL

You must ask for structure explicitly:

```ts
const orderBy = sql.ident("created_at");
const direction = descending ? sql.raw("DESC") : sql.raw("ASC");
const ids = sql.list([10, 20, 30]);

const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE id IN (${ids})
  ORDER BY ${orderBy} ${direction}
`;
```

- `sql.ident("schema.table")` quotes identifier parts.
- `sql.fragment` creates a dialect-bound fragment. The fragment can contain ordinary value binds.
- `sql.list(values)` emits one bind for each value. It rejects an empty list.
- `sql.join(fragments, separator)` combines fragments. It does not combine ordinary values.
- `sql.raw(text)` emits trusted SQL text. It does not validate or sanitize the text.
- `sql.empty` is an empty dialect-bound fragment.

Fragments are dialect-bound. Do not mix fragments from different dialect tags.

Do not send text that a user controls into `sql.raw`. If a user selects a structure, limit the choices to an allowlist that the application owns. Do this before you select an identifier or a trusted fragment.

## Dynamic SQL

If the project already uses `@braid` directives or structural helpers, use them. Keep the SQL readable. Do not build clauses again with string concatenation or a TypeScript query-builder abstraction.

If an empty list changes the meaning of the query, select the behavior explicitly or guard the clause. Do not assume that `sql.list([])` becomes a portable false predicate.
