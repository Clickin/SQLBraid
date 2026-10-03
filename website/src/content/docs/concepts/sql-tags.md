---
title: SQL tags and result kinds
description: Declare what a SQLBraid statement returns without hiding the SQL.
---

A SQLBraid tag is ordinary TypeScript with SQL. The dialect package exports a configured `sql` tag:

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

For the exact integer driver profiles on this page, the `id` field is canonical
decimal text. Approximate floating-point columns have the type `number`. If the
application needs `bigint` or an arbitrary-precision decimal, use a Standard
Schema transform.

Use the matching runtime operation:

- `db.all`, `db.one`, `db.maybeOne`, `db.stream` and row prepared queries require `sql.rows`.
- `db.execute` accepts row, command and unknown queries. It checks the actual result kind from the adapter.
- `db.call` is for `sql.call`. For output directions, tuple result sets, cleanup and the limits of each database, read [routine calls](/SQLBraid/concepts/routines/).

The plain `sql` tag creates a query with the result kind `unknown`. Use it when a driver-specific statement can return rows or command metadata. But it does not give a compile-time row type.

## Cardinality is explicit

```ts
const user = await db.one(sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`);
const maybeUser = await db.maybeOne(sql.rows<UserRow>`SELECT id, name FROM users WHERE email = ${email}`);
const users = await db.all(sql.rows<UserRow>`SELECT id, name FROM users`);
```

`one` requires exactly one row. `maybeOne` permits zero rows or one row. If there is more than one row, or zero rows for `one`, SQLBraid throws a cardinality error. It does not silently select a row.

## Result-kind checks occur after execution

Adapters report if a statement produced rows or command metadata. If a query declared `rows` but the driver reports a command, SQLBraid throws `BRAID_RESULT_KIND` after execution. A result-kind check cannot undo a root operation that is already complete. Thus, if a wrong declaration must roll back a write, put the write in `db.tx(...)`.

Bun 1.3.14 uses the guarded `bun-sql.result-kind-metadata` condition. On its
MySQL and MariaDB paths, an empty `SELECT` and DML or DDL that affects zero rows
can produce `BRAID_RESULT_KIND_AMBIGUOUS`. This occurs only after execution,
because the driver reports `command: null` and `affectedRows: 0`. Side effects
can already have occurred.

SQLBraid does not infer a TypeScript row shape from arbitrary SQL. The developer is responsible for the match between the selected columns and the declared row type.

Set-returning functions and table-valued extensions stay ordinary row queries.
Use `sql.rows`, `db.all` or `db.stream`. Do not use `db.call`.
