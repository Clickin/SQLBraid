[한국어](README.ko.md)

# SQLBraid

**Write SQL. Keep TypeScript.**

SQLBraid is a SQL-first data-access toolkit for TypeScript. You write the SQL. SQLBraid binds ordinary values as parameters. It also supports readable dynamic SQL and optional runtime validation and transformation of results.

📖 [Documentation](https://clickin.github.io/SQLBraid/latest/) · [Get Started](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [Driver support](https://clickin.github.io/SQLBraid/latest/reference/support/) · [Package map](https://clickin.github.io/SQLBraid/latest/reference/packages/)

```sh
npm install sqlbraid
```

## Quick Start

This `node:sqlite` quickstart requires Node.js 22.18 or later. Only this adapter has this requirement. Other runtime and driver combinations have their own requirements and support evidence.

1. Save the example as `quickstart.mts`.
2. Run `node quickstart.mts`.

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

Each ordinary `${value}` interpolation becomes a bound parameter. SQLBraid does not put the value into the SQL text. For identifiers and other SQL structure, use these explicit helpers:
`sql.ident`, `sql.fragment`, `sql.list` and `sql.join`.

`sql.raw` puts trusted SQL into the statement without change. Do not give it untrusted input.

### 2. Readable Dynamic SQL

Use `/*@braid ...*/` directives to write conditions directly in your SQL. The SQL stays readable.

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

Without source transformation, JavaScript evaluates every interpolated expression when the tag runs. To skip the expressions in inactive `@braid` branches, use `@sqlbraid/compiler`.

Supported directives: `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`.

### 3. Result Mapping

`sql.rows<UserRow>` declares a TypeScript result type. It does not validate rows at runtime. To validate or transform the returned rows, give a [Standard Schema](https://standard-schema.dev/) object.

The example that follows uses Zod. Install it separately with `npm install zod`.

```ts
import { z } from "zod";
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});
```

```ts
// Compile-time row type only; no runtime validation
const rows = await db.all(sql.rows<UserRow>`SELECT id, name FROM users`);

// Runtime validation with Standard Schema
const userQuery = sql.rows(UserSchema)`SELECT id, name FROM users`;
const user = await db.one(userQuery);
```

## Runtime API

SQLBraid gives one async API for common operations. Capabilities are different for each adapter. Before you use an operation, read the [support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/). An unsupported feature fails with an explicit error. SQLBraid does not buffer or emulate it.

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

SQLBraid is not an ORM and not a query builder. It does not do these things:

- parse arbitrary SQL to infer result types;
- implement a connection pool;
- retry or route queries.

The optional compiler lowers guarded `@braid` directives only. It is not a general SQL compiler.

## Package Map

Most applications install `sqlbraid` and one external driver. `node:sqlite` is part of Node.js. Import the facade subpath for your driver:

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

For Bun.SQL, select the database dialect explicitly. Authors of custom adapters can use the dialect-only subpaths `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle` and `sqlbraid/mssql`. The [full package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) shows the granular `@sqlbraid/*` packages and the tooling.

---

[Get started](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [Documentation](https://clickin.github.io/SQLBraid/latest/) · [Driver support](https://clickin.github.io/SQLBraid/latest/reference/support/) · [Package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) · [Architecture](./docs/mental-model.md)
