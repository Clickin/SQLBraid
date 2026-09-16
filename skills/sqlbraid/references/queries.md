# Query construction

Use this reference when writing or reviewing SQLBraid statements.

## Result contracts

```ts
const rows = sql.rows<UserRow>`SELECT id, name FROM users`;
const command = sql.command`UPDATE users SET active = true WHERE id = ${id}`;
```

Use `sql.call(...)` for routine semantics. Use plain `sql` only when the statement's result kind is genuinely unknown.

`sql.rows<T>` declares a TypeScript row contract; it does not validate rows at runtime or infer the selected shape from SQL. Keep the declared row type aligned with the selected columns. Use the project's Standard Schema mapping when validation or transformation is required.

Cardinality is explicit: `db.one(...)` requires exactly one row, `db.maybeOne(...)` permits zero or one, and `db.all(...)` returns the row set.

## Value binding

Every ordinary interpolation is a value bind:

```ts
sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`;
```

The driver owns physical placeholder or native request materialization. Do not write `$1`, `?`, `:1`, `@p1`, or named placeholders on SQLBraid's behalf.

Use `sql.bind(value, hint)` only when the selected first-party adapter supports the requested parameter hint. Do not infer a universal database type from a TypeScript primitive.

## Structural SQL

Structure is opt-in:

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
- `sql.fragment` creates a dialect-bound fragment and may contain ordinary value binds.
- `sql.list(values)` emits one bind per value and rejects an empty list.
- `sql.join(fragments, separator)` combines fragments, not ordinary values.
- `sql.raw(text)` emits trusted SQL text without validation or sanitization.
- `sql.empty` is an empty dialect-bound fragment.

Fragments are dialect-bound. Do not mix fragments created by different dialect tags.

Never route user-controlled text into `sql.raw`. Restrict user-facing structural choices to application-owned allowlists before selecting an identifier or trusted fragment.

## Dynamic SQL

Prefer SQLBraid's existing `@braid` directives or structural helpers when the project already uses them. Preserve SQL readability rather than rebuilding clauses through string concatenation or a TypeScript query-builder abstraction.

When an empty list changes query semantics, choose the behavior explicitly or guard the clause; do not assume `sql.list([])` becomes a portable false predicate.
