[한국어](README.ko.md)

# SQLBraid

**Write SQL. Keep TypeScript.**

SQLBraid is a SQL-first data-access toolkit for TypeScript. It keeps your SQL visible, binds ordinary values, supports readable dynamic SQL, and lets you attach runtime result validation and transformation.

📖 [Documentation](https://clickin.github.io/SQLBraid/latest/) · [Get Started](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [Driver support](https://clickin.github.io/SQLBraid/latest/reference/support/) · [Package map](https://clickin.github.io/SQLBraid/latest/reference/packages/)

```sh
npm install sqlbraid
```

## Quick Start

This `node:sqlite` quickstart requires Node.js 22.18+. That requirement is specific to this adapter; other runtime and driver combinations have their own requirements and support evidence. Save the example as `quickstart.mts` and run `node quickstart.mts`:

```ts
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";
import { DatabaseSync } from "node:sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
try {
  const db = createNodeSqliteDatabase(native);

  await db.execute(sql.command`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
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

Ordinary `${value}` interpolations become bound parameters; their contents are not inserted as SQL text. Use explicit helpers for identifiers and other SQL structure:
`sql.ident`, `sql.fragment`, `sql.list`, and `sql.join`.

`sql.raw` inserts trusted SQL verbatim. Never pass it untrusted input.

### 2. Readable Dynamic SQL

Use `/*@braid ...*/` directives to handle conditional logic directly in your SQL without breaking the string's readability.

```ts
const nameFilter: string | undefined = "Ada";
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${nameFilter != null}*/
      AND name = ${nameFilter}
    /*@braid end*/
  /*@braid end*/
`;
```

Without source transformation, JavaScript expressions inside template interpolations are evaluated when the tag is called. Use `@sqlbraid/compiler` to preserve lazy evaluation in inactive `@braid` branches.

Supported directives: `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`.

### 3. Result Mapping

`sql.rows<UserRow>` declares a TypeScript result type; it does not validate rows at runtime. Pass a [Standard Schema](https://standard-schema.dev/) object to validate or transform returned rows.

The following example uses Zod; install it separately with `npm install zod`.

```ts
import { z } from "zod";
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});
```

```ts
// Compile-time row contract only; no runtime validation
const rows = await db.all(sql.rows<UserRow>`SELECT id, name FROM users`);

// Runtime validation with Standard Schema
const userQuery = sql.rows(UserSchema)`SELECT id, name FROM users`;
const user = await db.one(userQuery);
```

## Runtime API

SQLBraid exposes a shared async API for common operations. Individual capabilities vary by adapter; consult the [support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/) before relying on an operation. Unsupported features fail explicitly rather than being buffered or emulated.

- **Queries**: `db.all()`, `db.one()`, `db.maybeOne()`, `db.stream()`
- **Commands (DDL/DML)**: `db.execute()`
- **Procedures**: `db.call()`
- **Batching**: `db.batch()`, `db.bulk()`
- **Resources**: `db.tx()` (transactions), `db.session()` (pinned connections)

### Transactions & Sessions

```ts
await db.tx({ isolation: "serializable" }, async (tx) => {
  await tx.all(sql.rows<{ id: string }>`SELECT id FROM users`);
});
```

## Scope

SQLBraid is not an ORM or a query builder. It does not parse arbitrary SQL to infer result types, implement a connection pool, retry queries, or route them. The optional compiler lowers guarded `@braid` directives; it is not a general SQL compiler.

## Package Map

Most applications install `sqlbraid` and the selected external driver; `node:sqlite` is built into Node.js. Import the matching facade subpath:

| Database        | Driver                    | Import                    |
| :-------------- | :------------------------ | :------------------------ |
| PostgreSQL      | `pg`                      | `sqlbraid/pg`             |
| MySQL           | `mysql2`                  | `sqlbraid/mysql2`         |
| MariaDB         | MariaDB Connector/Node.js | `sqlbraid/mariadb`        |
| SQLite          | Node `node:sqlite`        | `sqlbraid/node-sqlite`    |
| SQLite          | `better-sqlite3`          | `sqlbraid/better-sqlite3` |
| SQLite          | `@libsql/client`          | `sqlbraid/libsql`         |
| SQLite          | SQLite WASM               | `sqlbraid/sqlite-wasm`    |
| SQLite          | Cloudflare D1             | `sqlbraid/d1`             |
| Oracle Database | `oracledb`                | `sqlbraid/oracledb`       |
| SQL Server      | `tedious`                 | `sqlbraid/tedious`        |
| Bun.SQL         | Bun `Bun.SQL`             | `sqlbraid/bun-sql`        |

For Bun.SQL, choose the database dialect explicitly. Custom adapter authors can use the dialect-only subpaths `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle`, and `sqlbraid/mssql`. The [full package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) covers granular `@sqlbraid/*` packages and tooling.

---

[Get started](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [Documentation](https://clickin.github.io/SQLBraid/latest/) · [Driver support](https://clickin.github.io/SQLBraid/latest/reference/support/) · [Package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) · [Architecture](./docs/mental-model.md)
