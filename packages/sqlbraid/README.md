# sqlbraid

**Write SQL. Keep TypeScript. Skip the query-builder translation layer.**

SQLBraid lets you write plain SQL in TypeScript with tagged templates. Values are always bound as parameters, dynamic conditions live inside the SQL itself, and you declare what each query returns.

It works with PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL Server, on Node.js, Bun, Deno, browsers (SQLite WASM), and Cloudflare D1.

Here is a query with two optional filters. A `/*@braid if ...*/` directive keeps its line only when the condition is true. `/*@braid where*/` adds `WHERE` only if a line is left, and removes the leading `AND`. The values are sent to the database as bound parameters.

```ts
const users = await db.all(sql.rows<User>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/   AND name = ${name}       /*@braid end*/
    /*@braid if ${teamId != null}*/ AND team_id = ${teamId}  /*@braid end*/
  /*@braid end*/
`);
// name = null, teamId = 7  ->  (pg) SELECT id, name FROM users WHERE team_id = $1   [7]
```

[Documentation](https://clickin.github.io/SQLBraid/latest/) · [5-minute quickstart](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [Interactive preview](https://clickin.github.io/SQLBraid/latest/interactive-preview/) · [Support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/)

## Why I built this

At work I write Java, and I use MyBatis a lot. I like its approach when the team knows SQL well: you write almost any SQL you want, you keep dynamic conditions inside one statement, and you still get typed results without mapping rows by hand.

When I looked for the same thing in TypeScript, I couldn't find it. Raw drivers are safe but dynamic `WHERE` clauses turn into string building. Query builders have great types, but I have to translate SQL I already know into a builder API. ORMs hide the SQL completely.

SQLBraid is my attempt to bring the MyBatis style to TypeScript: SQL stays SQL, dynamic SQL stays readable, and results stay typed.

## Quickstart: SQLite

Requires Node.js 22.18 or newer. This example uses the built-in `node:sqlite`, so you don't need a database server.

```sh
npm install sqlbraid
```

Save as `quickstart.mts` and run `node quickstart.mts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
try {
  native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  native.prepare("INSERT INTO users (name) VALUES (?)").run("Ada");

  const db = createNodeSqliteDatabase(native);
  const userId = 1;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name FROM users WHERE id = ${userId}
  `);

  console.log(users); // [{ id: "1", name: "Ada" }]
} finally {
  native.close();
}
```

> **Why is `id` a string?** SQLBraid returns exact database numbers (integers, decimals) as strings by default, so large values never lose precision. Convert them in your own code or with a schema (see [data representations](https://clickin.github.io/SQLBraid/latest/concepts/data-representation/)).

## Quickstart: PostgreSQL with a pool

Use this when you have a PostgreSQL server. You create the `pg` pool, and SQLBraid takes one connection for each operation.

```sh
npm install sqlbraid pg
```

```ts
import { Pool } from "pg";
import { createPgPoolDatabase, sql } from "sqlbraid/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createPgPoolDatabase(pool);

const account = await db.one(sql.rows<{ id: string; email: string }>`
  SELECT id, email FROM accounts WHERE id = ${accountId}
`);

await db.tx(async (tx) => {
  await tx.execute(sql.command`UPDATE accounts SET active = true WHERE id = ${accountId}`);
});
```

## Quickstart: stored procedures

With a query builder or a raw-SQL library, a stored procedure is usually a plain query that you read yourself. In SQLBraid you write the `CALL` statement and mark each OUT parameter. `db.call` returns the OUT values in `output`, each result set in `resultSets`, and the return value in `returnValue` when the driver gives one.

This example uses PostgreSQL and the `db` from the previous quickstart. The procedure returns its rows through a `refcursor` OUT parameter. PostgreSQL needs an open transaction for this, so call it inside `db.tx`.

```sql
CREATE PROCEDURE list_active_users(OUT users refcursor) LANGUAGE plpgsql AS $$
BEGIN
  OPEN users FOR SELECT id, name FROM users WHERE active;
END $$;
```

```ts
import type { RoutineCallResult } from "sqlbraid";
import { postgresParameter, sql } from "sqlbraid/pg";

interface UserRow {
  id: string;
  name: string;
}

const result = await db.tx(async (tx) =>
  tx.call(
    sql.call<RoutineCallResult<{}, [UserRow]>>`
      CALL list_active_users(${sql.out("users", postgresParameter.refcursor())})
    `,
  ),
);

console.log(result.resultSets[0].rows); // UserRow[]: [{ id: "1", name: "Ada" }]
```

`RoutineCallResult<Output, Sets, ReturnValue>` declares the whole result. `Output` is the type of the scalar OUT values, `Sets` is a tuple with one row type for each result set, and `ReturnValue` is the return value. Each result set can have a different row type. Here the refcursor becomes a result set, so `Output` is empty.

As with `sql.rows`, you can use Standard Schema instead of a type argument. The schema checks each row and can convert it. The row type is the output type of the schema:

```ts
import { postgresParameter, sql } from "sqlbraid/pg";

const result = await db.tx(async (tx) =>
  tx.call(
    sql.call({ resultSets: [UserSchema] as const })`
      CALL list_active_users(${sql.out("users", postgresParameter.refcursor())})
    `,
  ),
);
// With a schema that turns id into a number: [{ id: 1, name: "Ada" }]
```

`output` and `returnValue` accept a schema in the same way.

Driver support for OUT parameters, multiple result sets and return values differs. See [routine calls](https://clickin.github.io/SQLBraid/latest/concepts/routines/) and the [support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/).

Other databases: [MySQL](https://clickin.github.io/SQLBraid/latest/getting-started/mysql/) · [MariaDB](https://clickin.github.io/SQLBraid/latest/getting-started/mariadb/) · [Oracle](https://clickin.github.io/SQLBraid/latest/getting-started/oracle/) · [SQL Server](https://clickin.github.io/SQLBraid/latest/getting-started/mssql/) · [SQLite in the browser and D1](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite-browser/)

## How it works

SQLBraid reads your template, builds one statement, and gives it to the driver. Three steps:

1. **Directives pick the SQL text.** The `/*@braid ... */` directives are SQL comments, so your editor still sees normal SQL. Each `if`, `when` or `where` is evaluated in order. Inactive parts are dropped. Available directives: `if`, `choose` / `when` / `otherwise`, `where`, `set`, and `trim`.
2. **Every `${value}` becomes a parameter.** The result is SQL text with the values kept apart. The values are never pasted into the text.
3. **The driver writes the placeholders.** You write the same `${value}` everywhere. The driver adapter turns it into `$1`, `?`, `:1`, or `@p1`.

```ts
sql.rows<User>`
  SELECT id, name FROM users
  /*@braid choose*/
    /*@braid when ${sort === "name"}*/    ORDER BY name
    /*@braid when ${sort === "created"}*/ ORDER BY created_at DESC
    /*@braid otherwise*/                  ORDER BY id
  /*@braid end*/
`;
// sort = "created"  ->  SELECT id, name FROM users ORDER BY created_at DESC
```

Directives work at runtime with no build step. If you also want inactive branches to skip evaluating their `${...}` expressions, run the optional compiler (`@sqlbraid/cli` or the Vite plugin). See [dynamic @braid](https://clickin.github.io/SQLBraid/latest/concepts/dynamic-braid/).

To put SQL structure in a statement (a table name, a column list, a fragment), you use an explicit helper: `sql.ident`, `sql.list`, `sql.join`, or `sql.fragment`. See [structural fragments](https://clickin.github.io/SQLBraid/latest/concepts/structural-fragments/).

## What a query returns

**You declare the result.** `sql.rows<T>` is for queries that return rows, `sql.command` is for INSERT/UPDATE/DELETE, and `sql.call` is for stored procedures. If the declaration doesn't match what the database returned, you get an error instead of silently wrong data.

**Validate rows with any Standard Schema library** (Zod, Valibot, ArkType, ...):

```ts
const user = await db.one(sql.rows(UserSchema)`SELECT id, name FROM users WHERE id = ${id}`);
```

### Using SQLBraid from JavaScript

SQLBraid works in plain JavaScript. Write `sql.rows` without the `<T>` type argument.

- Each row is a plain object. Its keys are the column names or aliases that the database returns, exactly as written.
- SQLBraid does **not** convert names. `user_id` stays `user_id`. It does not become `userId`. If you want camelCase keys, write the alias in SQL: `SELECT user_id AS "userId"` (the quoting depends on the database).
- Values follow the same rules as in TypeScript. Exact numbers are strings, and `null` is `null`.

```js
const rows = await db.all(sql.rows`SELECT id, created_at FROM users`);
// [{ id: "1", created_at: ... }]   (keys are the same as the SQL columns)
```

## Similar libraries

Every tool below is good. They make different trade-offs.

|                              | SQL you write                                                 | Dynamic SQL                                                                                            | Result types                                                           | Databases                                                           |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Prisma**                   | Prisma schema and client API; `$queryRaw` for raw SQL         | Through the client API (`undefined` filters are skipped), or `Prisma.sql` and `Prisma.join` in raw SQL | Generated from the schema; raw queries are typed by you                | PostgreSQL, MySQL, SQLite, SQL Server, CockroachDB, MongoDB         |
| **Drizzle**                  | TypeScript schema and query API, `sql` template for raw parts | Through the query API (`and(...)` skips `undefined`)                                                   | Inferred from the schema                                               | PostgreSQL, MySQL, SQLite, SingleStore, Gel                         |
| **Kysely**                   | Type-safe query builder; `sql` template for raw parts         | Builder method chaining, such as a conditional `.where()`                                              | Inferred from a DB interface                                           | PostgreSQL, MySQL, SQLite, SQL Server                               |
| **postgres.js / slonik**     | Raw SQL in tagged templates                                   | Composing fragments in JS (postgres.js: nested `sql`; slonik: `sql.fragment`, `sql.join`, `sql.and`)   | Declared by you                                                        | PostgreSQL                                                          |
| **pgtyped**                  | Raw SQL files with `:name` parameters                         | Not built in; write `:name IS NULL OR ...` in SQL                                                      | Generated by checking SQL against a live database                      | PostgreSQL                                                          |
| **sqlc** (TypeScript plugin) | Raw SQL files                                                 | Not built in; write `IS NULL OR ...` in SQL                                                            | Generated from the SQL and schema files                                | PostgreSQL (`pg`, `postgres`), MySQL (`mysql2`), SQLite (`sqlite3`) |
| **SQLBraid**                 | Raw SQL in tagged templates                                   | Directives inside the SQL                                                                              | Declared by you, checked at runtime; optional codegen for table models | PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server              |

Choose SQLBraid if you already think in SQL, your queries have many optional conditions, or you need the same API across several databases.

Choose something else if you want relations loaded automatically, or result types inferred from arbitrary `SELECT` statements. SQLBraid does none of these.

## What SQLBraid does not do

- It is not an ORM. No relation loading, no identity map.
- It does not infer the type of an arbitrary `SELECT`. You declare the row type, or generate table models with codegen.
- It does not rewrite your SQL or emulate missing database features. If a driver can't do something (for example, cancel a query), you get an explicit error.
- It does not create connection pools. You create the pool with your driver and pass it in. SQLBraid then takes one connection per operation, or one for a whole transaction.

## Features

- Transactions with savepoints, isolation levels, and read-only mode: `db.tx(...)`
- Sessions that keep one connection: `db.session(...)`
- Streaming large results: `db.stream(...)`
- Prepared queries: `db.prepare(...)`
- Bulk insert/update: `db.bulk(...)`
- Stored procedures with OUT parameters and multiple result sets: `db.call(...)`
- Cancellation with `AbortSignal`
- Query observers for logging, plus optional OpenTelemetry spans and metrics

Driver support differs. Check the [support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/) for your database, driver, and runtime.

## Supported drivers

Install `sqlbraid` plus your driver, then import the matching subpath. The postgres.js, Neon and PGlite adapters come from `@sqlbraid/postgres`, so install that package instead of `sqlbraid` for them.

| Database                           | Driver                | Import                           |
| ---------------------------------- | --------------------- | -------------------------------- |
| PostgreSQL                         | `pg`                  | `sqlbraid/pg`                    |
| PostgreSQL                         | postgres.js           | `@sqlbraid/postgres/postgres-js` |
| PostgreSQL                         | Neon (WebSocket)      | `@sqlbraid/postgres/neon`        |
| PostgreSQL                         | Neon (HTTP)           | `@sqlbraid/postgres/neon-http`   |
| PostgreSQL                         | PGlite                | `@sqlbraid/postgres/pglite`      |
| MySQL                              | `mysql2`              | `sqlbraid/mysql2`                |
| MariaDB                            | `mariadb`             | `sqlbraid/mariadb`               |
| SQLite                             | `node:sqlite`         | `sqlbraid/node-sqlite`           |
| SQLite                             | `better-sqlite3`      | `sqlbraid/better-sqlite3`        |
| SQLite                             | libSQL                | `sqlbraid/libsql`                |
| SQLite                             | SQLite WASM (browser) | `sqlbraid/sqlite-wasm`           |
| SQLite                             | Cloudflare D1         | `sqlbraid/d1`                    |
| Oracle                             | `oracledb` (Thin)     | `sqlbraid/oracledb`              |
| SQL Server                         | `tedious`             | `sqlbraid/tedious`               |
| PostgreSQL, MySQL, MariaDB, SQLite | Bun.SQL               | `sqlbraid/bun-sql`               |

## Optional tooling

None of these are runtime dependencies.

- **Codegen** (`@sqlbraid/codegen`, `@sqlbraid/cli`): reads your database schema and generates `Row`, `Insert`, and `Update` types. `codegen --check` can run in CI.
- **Editor support** (`@sqlbraid/language-server`, [VS Code extension](https://marketplace.visualstudio.com/items?itemName=sqlbraid.sqlbraid-vscode)): diagnostics, completion, and hover for SQL inside templates.
- **Vite plugin** (`@sqlbraid/vite`): runs the directive compiler in your build.
- **Migrations** (`@sqlbraid/migrate`): versioned SQL files and explicit startup checks. Migrations are plain SQL files. Creating a database does not run them. The `migrate` commands are in `@sqlbraid/cli`.

See the [package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) for every package.

## Entry points

The root import (`sqlbraid`) is database-neutral. It does not export an implicit `sql` tag. Import `sql` from a driver subpath such as `sqlbraid/pg`, or from a dialect-only subpath.

- Driver subpaths combine a driver and a dialect: `sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`, `sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`, `sqlbraid/oracledb` and `sqlbraid/tedious`.
- For Bun.SQL, use `sqlbraid/bun-sql` and select the dialect explicitly.
- The `node:sqlite` adapter uses the module that is part of Node. It does not need a separate driver package.
- For custom adapters, use the dialect-only subpaths: `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle` and `sqlbraid/mssql`.
- `sqlbraid/compiled` is an advanced entry point for compiler-generated code. It is not an API for applications to write queries.

See the [full package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) and the [driver support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/).

## Status

Version 1.x. The public API is stable and follows semantic versioning. See the [release notes](https://clickin.github.io/SQLBraid/latest/release/notes/), [current limitations](https://clickin.github.io/SQLBraid/latest/release/limitations/), and [roadmap](https://clickin.github.io/SQLBraid/latest/release/roadmap/).

## About AI use

I used AI coding assistants for parts of the implementation, test coverage across six databases, code review, and documentation. The design and API decisions are mine. SQLBraid has no AI runtime dependency.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/Clickin/SQLBraid/blob/main/CONTRIBUTING.md). For security issues, see [SECURITY.md](https://github.com/Clickin/SQLBraid/blob/main/SECURITY.md).

## License

[Apache-2.0](https://github.com/Clickin/SQLBraid/blob/main/LICENSE)
