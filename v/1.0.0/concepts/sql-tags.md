# SQL tags and result kinds

> Declare what a SQLBraid statement returns without hiding the SQL.

SQLBraid's tag is ordinary TypeScript plus SQL. The dialect package exports a configured `sql` tag:

```ts
import { sql } from "sqlbraid/postgres";

const users = sql.rows<{ id: string; name: string }>`
  SELECT id, name FROM users
`;
const update = sql.command`
  UPDATE users SET last_seen_at = now() WHERE id = ${userId}
`;
const routine = sql.call({
  resultSets: [RefreshSchema] as const,
})`
  CALL refresh_users()
`;
```

For the exact integer driver profiles documented here, the `id` field is
canonical decimal text. Approximate floating-point columns are declared as
`number`; use a Standard Schema transform when the application needs `bigint`
or an arbitrary-precision decimal.

Use the matching runtime operation:

- `db.all`, `db.one`, `db.maybeOne`, `db.stream`, and row prepared queries require `sql.rows`.
- `db.execute` handles row, command, and unknown queries and checks the adapter's actual result kind.
- `db.call` is for `sql.call`; see [routine calls](/SQLBraid/v/1.0.0/concepts/routines.md) for output directions, tuple result sets, cleanup, and database-specific limits.

The unqualified `sql` tag creates a query with result kind `unknown`. It is useful when a driver-specific statement can return either rows or command metadata, but it gives up the compile-time row contract.

## Cardinality is explicit

```ts
const user = await db.one(sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`);
const maybeUser = await db.maybeOne(sql.rows<UserRow>`SELECT id, name FROM users WHERE email = ${email}`);
const users = await db.all(sql.rows<UserRow>`SELECT id, name FROM users`);
```

`one` requires exactly one row. `maybeOne` permits zero or one. More than one row, or zero rows for `one`, throws a cardinality error rather than silently choosing a row.

## Result-kind checks happen after execution

Adapters report whether a statement produced rows or command metadata. If a query declared `rows` but the driver reports a command, SQLBraid throws `BRAID_RESULT_KIND` after execution. Put a write in `db.tx(...)` when a wrong declaration must roll back the write; a result-kind check cannot undo an already-completed root operation.

Bun 1.3.14 uses the guarded `bun-sql.result-kind-metadata` condition. For its
MySQL/MariaDB paths, an empty `SELECT` and zero-affected DML/DDL can produce
`BRAID_RESULT_KIND_AMBIGUOUS` only after execution because the driver reports
`command: null` and `affectedRows: 0`; side effects may already have occurred.

SQLBraid does not infer a TypeScript row shape from arbitrary SQL. The developer owns the correspondence between selected columns and the declared row type.

Set-returning functions and table-valued extensions remain ordinary row
queries: use `sql.rows`, `db.all`, or `db.stream`, not `db.call`.
