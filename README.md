[한국어](README.ko.md)

# SQLBraid

**Write SQL. Keep TypeScript.**

SQLBraid is a SQL-first data-access toolkit for TypeScript. It lets you write ordinary SQL—including DDL, DML, and complex queries—while providing safe value binding, readable dynamic SQL, and explicit result mapping.

Unlike ORMs or query builders, SQLBraid does not abstract SQL away. To keep the core lean, it is **not**:
- An ORM or a query builder.
- A complete SQL parser or compiler.
- A connection pool implementation (it wraps existing ones).
- A retry or routing framework.


📖 [Documentation](https://clickin.github.io/SQLBraid/latest/) · [Get Started](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/)



```sh
pnpm add sqlbraid
```

## Quick Start

On Node.js 22.18+, save this as `quickstart.mts` and run `node quickstart.mts`:

```ts
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";
import { DatabaseSync } from "node:sqlite";

interface UserRow {
  id: string;
  name: string;
  team_id: string | null;
}

const native = new DatabaseSync(":memory:");
try {
  const db = createNodeSqliteDatabase(native);
  
  await db.execute(sql.command`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, team_id TEXT)`);
  const name = "Ada";
  await db.execute(sql.command`INSERT INTO users (name) VALUES (${name})`);

  const userId = 1;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name FROM users WHERE id = ${userId}
  `);
  console.log(users); // [{ id: "1", name: "Ada" }]
} finally {
  native.close();
}
```

## Key Concepts

### 1. Safe by Default

Every `${value}` interpolation is automatically treated as a bound parameter. You never have to worry about SQL injection for ordinary values.

For structural SQL (like table or column names), use explicit helpers:
`sql.ident`, `sql.fragment`, `sql.list`, `sql.join`, and `sql.raw`.

### 2. Readable Dynamic SQL

Use `/*@braid ...*/` directives to handle conditional logic directly in your SQL without breaking the string's readability.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${teamId != null}*/
      AND team_id = ${teamId}
    /*@braid end*/
  /*@braid end*/
`;
```

Supported directives: `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`.

### 3. Result Mapping

You can define result types via generics or use [Standard Schema](https://standard-schema.dev/) for runtime validation and transformation.

```ts
// Simple type casting
const rows = await db.all(sql.rows<UserRow>`SELECT id, name, team_id FROM users`);

// Runtime validation with Standard Schema
const userQuery = sql.rows(UserSchema)`SELECT id, name, team_id FROM users`;
const user = await db.one(userQuery);
```

## Runtime API

SQLBraid provides a lean API for common database operations:

- **Queries**: `db.all()`, `db.one()`, `db.maybeOne()`, `db.stream()`
- **Commands (DDL/DML)**: `db.execute()`

- **Procedures**: `db.call()`
- **Batching**: `db.batch()`, `db.bulk()`
- **Resources**: `db.tx()` (transactions), `db.session()` (pinned connections)

### Transactions & Sessions

```ts
await db.tx({ isolation: "serializable", readOnly: true }, async (tx) => {
  await tx.all(sql.rows<{ id: string }>`SELECT id FROM accounts`);
});
```

## Package Map

SQLBraid uses a modular architecture. You install the `sqlbraid` facade and the specific driver you need (e.g., `sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/node-sqlite`).

| Package              | Responsibility                         |
| :------------------- | :------------------------------------- |
| `sqlbraid`           | Main facade and driver subpaths        |
| `@sqlbraid/core`     | Shared contracts and observers         |
| `@sqlbraid/template` | SQL tags and directives                |
| `@sqlbraid/runtime`  | Execution, transactions, and streaming |
| `@sqlbraid/metadata` | Database schema snapshots              |
| `@sqlbraid/codegen`  | TypeScript model generation            |
| `@sqlbraid/cli`      | CLI for codegen and schema inspection  |


---

[Get started](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [Documentation](https://clickin.github.io/SQLBraid/latest/) · [Architecture](./docs/mental-model.md)
