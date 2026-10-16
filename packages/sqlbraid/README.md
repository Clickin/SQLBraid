# sqlbraid

**Write SQL directly in TypeScript. No query builder required.**

SQLBraid is a SQL-first data-access library for TypeScript that lets you write raw SQL inside tagged templates. Interpolated values are always separated as bound parameters, dynamic conditions inspired by MyBatis live directly inside SQL comments, and each query declares its return row type or validation schema.

It provides a common execution API across 6 database dialects—PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL Server—and runs on Node.js, Bun, Deno, browsers (SQLite WASM), and Cloudflare D1.

```ts
const users = await db.all(sql.rows<User>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/   AND name = ${name}       /*@braid end*/
    /*@braid if ${teamId != null}*/ AND team_id = ${teamId}  /*@braid end*/
  /*@braid end*/
`);
// Rendered SQL when name = null, teamId = 7  ->  (pg) SELECT id, name FROM users WHERE team_id = $1   [7]
```

[Documentation](https://clickin.github.io/SQLBraid/latest/) · [5-minute quickstart](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [Interactive preview](https://clickin.github.io/SQLBraid/latest/interactive-preview/) · [Support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/)

## Motivation

I maintain Java framework libraries at work and have used iBatis/MyBatis XML mappers for years. I like being able to write SQL directly, keep dynamic conditions inside the query, and get typed results without mapping rows by hand.

When I looked for a similar workflow in TypeScript, I wasn't happy with the trade-offs I found:

- **Raw drivers:** Parameter binding is safe, but adding dynamic `WHERE` filters quickly turns into messy string concatenation and parameter index bookkeeping.
- **Query builders:** Type inference is great, but you have to translate the SQL already in your head into a library-specific method-chaining DSL.
- **ORMs:** I prefer writing SQL myself rather than relying on generated queries and an object model.

With coding agents available, I figured I'd try building it myself.

The biggest hurdle was that **JavaScript has no equivalent to JDBC**. In Java, MyBatis sits on top of the standard JDBC interfaces (`Connection`, `PreparedStatement`, `ResultSet`), so it never has to build a custom execution layer per driver. JavaScript has no standard interface across `pg`, `mysql2`, `oracledb`, `tedious`, and `node:sqlite`—connection management, placeholder syntax (`$1`, `?`, `:1`, `@p1`), transactions, streaming, and stored procedures all work differently.

Because of that, SQLBraid needed not only a MyBatis-style dynamic SQL processor, but also an execution layer that connects different JavaScript database drivers to a common API without hiding database-specific capabilities.

## Quickstart: SQLite

On Node.js 22.18 or newer, you can run SQLBraid immediately with the built-in `node:sqlite` module—no database server required.

```sh
pnpm add sqlbraid @sqlbraid/sqlite
```

Save the code below as `quickstart.mts` and run `node quickstart.mts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

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

> **Why is `id` returned as a string?** JavaScript `number` loses precision on large 64-bit integers (`BIGINT`) and exact decimals (`DECIMAL`). To prevent silent rounding, SQLBraid returns exact database numeric types as strings by default. You can convert them in application code or attach a Standard Schema to transform them automatically (see [Data representations](https://clickin.github.io/SQLBraid/latest/concepts/data-representation/)).

## Quickstart: PostgreSQL Connection Pool

You create the connection pool with your driver (`pg`, `mysql2`, etc.) and pass it to SQLBraid. SQLBraid leases one connection per operation or pins a single connection across a transaction.

```sh
pnpm add sqlbraid @sqlbraid/postgres pg
```

```ts
import { Pool } from "pg";
import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createPgPoolDatabase(pool);

const account = await db.one(sql.rows<{ id: string; email: string }>`
  SELECT id, email FROM accounts WHERE id = ${accountId}
`);

await db.tx(async (tx) => {
  await tx.execute(sql.command`UPDATE accounts SET active = true WHERE id = ${accountId}`);
});
```

For other databases, see the getting-started guides: [MySQL](https://clickin.github.io/SQLBraid/latest/getting-started/mysql/) · [MariaDB](https://clickin.github.io/SQLBraid/latest/getting-started/mariadb/) · [Oracle](https://clickin.github.io/SQLBraid/latest/getting-started/oracle/) · [SQL Server](https://clickin.github.io/SQLBraid/latest/getting-started/mssql/) · [Browser SQLite & Cloudflare D1](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite-browser/).

## How It Works

SQLBraid builds an executable statement from your template in three steps:

1. **Directive evaluation (`/*@braid ... */`):** Directives use standard SQL block comments so editors and SQL formatters treat your query as valid SQL. SQLBraid evaluates `if`, `choose` / `when` / `otherwise`, `where`, `set`, and `trim` blocks in order, drops inactive branches, and supports multi-line and nested blocks. `where` and `set` automatically strip leading `AND`/`OR` tokens or trailing commas.
2. **Parameter extraction (`${value}`):** Values used by active SQL branches are sent as bound parameters—never concatenated into the SQL string. Without the optional compiler, JavaScript still evaluates all template expressions before SQLBraid processes the directives.
3. **Driver placeholder rendering:** You write the same `${value}` syntax everywhere, and the target driver adapter emits the native placeholders (`$1`, `?`, `:1`, `@p1`).

```ts
sql.rows<User>`
  SELECT u.id, u.name
  FROM users u
  /*@braid if ${teamName != null}*/
    JOIN teams t
      ON t.id = u.team_id
     AND t.name = ${teamName}
  /*@braid end*/
  /*@braid where*/
    /*@braid if ${onlyActive}*/
      AND u.active = 1
      AND u.name IS NOT NULL
    /*@braid end*/
  /*@braid end*/
  /*@braid choose*/
    /*@braid when ${sort === "name"}*/    ORDER BY u.name
    /*@braid when ${sort === "created"}*/ ORDER BY u.created_at DESC
    /*@braid otherwise*/                  ORDER BY u.id
  /*@braid end*/
`;
// teamName = "core", onlyActive = true  ->  ... JOIN teams t ON t.id = u.team_id AND t.name = ? WHERE u.active = 1 AND u.name IS NOT NULL ORDER BY ...
// teamName = null,   onlyActive = false ->  SELECT u.id, u.name FROM users u ORDER BY ...
```

- **Zero-build runtime execution & optional compiler:** All directives work at runtime without a build step. If you want to skip evaluating `${...}` expressions inside inactive `/*@braid if ...*/` branches (lazy evaluation), add the optional compiler plugin (`@sqlbraid/vite`, `@sqlbraid/webpack`, or `@sqlbraid/cli`). The compiler only wraps expressions in thunks; final SQL assembly still happens at runtime (see [What the compiler does](https://clickin.github.io/SQLBraid/latest/concepts/dynamic-braid/#what-the-compiler-does)).
- **Dynamic identifiers & SQL fragments:** When you need to compose SQL structure dynamically—table names, column lists, or reusable sub-clauses—use the explicit helpers `sql.ident`, `sql.list`, `sql.join`, and `sql.fragment` (see [Structural SQL fragments](https://clickin.github.io/SQLBraid/latest/concepts/structural-fragments/)).

When you use the compiler, install `@sqlbraid/template` as a direct runtime dependency. Generated code imports its helpers.

## Result Declarations & Schema Validation

You declare the expected result kind for every query: `sql.rows<T>` for row sets, `sql.command` for `INSERT`/`UPDATE`/`DELETE`, and `sql.call` for stored procedures. SQLBraid throws if the database returns a different result kind than declared (see [SQL tags and result kinds](https://clickin.github.io/SQLBraid/latest/concepts/sql-tags/)). `sql.rows<T>` is a TypeScript type declaration; to validate row fields and values at runtime, pass a Standard Schema.

**Standard Schema integration (Zod, Valibot, ArkType, etc.):**

Pass any Standard Schema object instead of a type argument to validate rows at runtime and transform values (for example, parsing numeric strings into `number` or `bigint`; see [Standard Schema result mapping](https://clickin.github.io/SQLBraid/latest/concepts/result-mapping/)).

```ts
const user = await db.one(sql.rows(UserSchema)`SELECT id, name FROM users WHERE id = ${id}`);
```

**Using SQLBraid from plain JavaScript:**

Call `sql.rows` without a `<T>` type argument. Each returned row is a plain object whose keys match the database column names (or `AS` aliases) verbatim. SQLBraid never implicitly converts `user_id` into `userId`; write `SELECT user_id AS "userId"` in SQL when you want camelCase keys.

## Stored Procedures (`db.call`)

Instead of treating stored procedures as untyped raw queries, `sql.call` gives you a structured API for typed `OUT` parameters, multiple result sets, and return values.

Here is a PostgreSQL example that reads rows from a `refcursor` `OUT` parameter (PostgreSQL requires an open transaction to read a cursor, so it runs inside `db.tx`):

```sql
CREATE PROCEDURE list_active_users(OUT users refcursor) LANGUAGE plpgsql AS $$
BEGIN
  OPEN users FOR SELECT id, name FROM users WHERE active;
END $$;
```

```ts
import type { RoutineCallResult } from "sqlbraid";
import { postgresParameter, sql } from "@sqlbraid/postgres";

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

`RoutineCallResult<Output, Sets, ReturnValue>` declares the scalar `OUT` object type, the tuple of row types for each result set, and the return value type. Just like `sql.rows`, you can pass Standard Schemas to validate and transform each channel:

```ts
import { postgresParameter, sql } from "@sqlbraid/postgres";

const result = await db.tx(async (tx) =>
  tx.call(
    sql.call({ resultSets: [UserSchema] as const })`
      CALL list_active_users(${sql.out("users", postgresParameter.refcursor())})
    `,
  ),
);
```

See [Routine calls](https://clickin.github.io/SQLBraid/latest/concepts/routines/) and the [Support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/) for driver-specific support details.

## Comparison with Other Libraries

|                              | SQL you write                                               | Dynamic SQL handling                                                               | Result types                                                            | Supported databases                                                 |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Prisma**                   | Prisma schema & client API; `$queryRaw` for raw SQL         | Client API (skips `undefined` filters), or `Prisma.sql` / `Prisma.join` in raw SQL | Generated from schema; manual typing for raw queries                    | PostgreSQL, MySQL, SQLite, SQL Server, CockroachDB, MongoDB         |
| **Drizzle**                  | TypeScript schema & query API; `sql` template for raw parts | Query API (`and(...)` skips `undefined`)                                           | Inferred from schema                                                    | PostgreSQL, MySQL, SQLite, SingleStore, Gel                         |
| **Kysely**                   | Type-safe query builder; `sql` template for raw parts       | Builder method chaining (e.g., conditional `.where()`)                             | Inferred from DB interface                                              | PostgreSQL, MySQL, SQLite, SQL Server                               |
| **postgres.js / slonik**     | Raw SQL in tagged templates                                 | Fragment composition in JS (nested `sql`, `sql.fragment`, `sql.join`)              | Declared by you                                                         | PostgreSQL                                                          |
| **pgtyped**                  | Raw SQL files with `:name` parameters                       | Not built-in (write `:name IS NULL OR ...` in SQL)                                 | Generated at build time against a live DB                               | PostgreSQL                                                          |
| **sqlc** (TypeScript plugin) | Raw SQL files                                               | Not built-in (write `IS NULL OR ...` in SQL)                                       | Generated from SQL and schema files                                     | PostgreSQL (`pg`, `postgres`), MySQL (`mysql2`), SQLite (`sqlite3`) |
| **SQLBraid**                 | Raw SQL in tagged templates                                 | In-SQL comment directives (`/*@braid if ...*/`)                                    | Declared by you & validated via Standard Schema; optional table codegen | PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server              |

**When SQLBraid fits well:** Teams that design queries in SQL first, queries with many optional search filters or conditional joins, or projects that need a common execution and stored-procedure API across multiple database engines.

**What SQLBraid does not do:**

- **Not an ORM:** No automatic relation loading or identity maps.
- **No arbitrary `SELECT` type inference:** You declare the return row type or pass a Standard Schema, and optionally generate table models with `@sqlbraid/codegen`.
- **No silent SQL rewriting or feature emulation:** Calling a feature that the underlying driver does not support (such as query cancellation) throws an explicit error instead of faking it.
- **No built-in connection pool implementation:** You pass in your driver's pool, and SQLBraid leases connections per operation or per transaction.

## Core Execution Features

- **Transactions ([`db.tx`](https://clickin.github.io/SQLBraid/latest/runtime/transactions/)):** Savepoints, isolation levels, and read-only mode
- **Pinned sessions ([`db.session`](https://clickin.github.io/SQLBraid/latest/runtime/direct-pools/)):** Hold a single connection across multiple queries without starting a transaction
- **Streaming ([`db.stream`](https://clickin.github.io/SQLBraid/latest/runtime/streaming/)):** Consume large result sets incrementally with automatic cursor cleanup
- **Prepared queries & bulk DML:** [`db.prepare(...)`](https://clickin.github.io/SQLBraid/latest/runtime/prepared/) and [`db.bulk(...)`](https://clickin.github.io/SQLBraid/latest/concepts/bulk/)
- **Stored procedures ([`db.call`](https://clickin.github.io/SQLBraid/latest/concepts/routines/)):** Typed `OUT` parameters, multiple result sets, and return values
- **Control & observability:** Query cancellation via `AbortSignal`, [execution observers](https://clickin.github.io/SQLBraid/latest/runtime/observers/) for logging, and optional [OpenTelemetry spans and metrics](https://clickin.github.io/SQLBraid/latest/runtime/opentelemetry/)

Check the [Support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/) for exact support across databases, drivers, and runtimes.

## Supported Drivers

Install `sqlbraid`, the matching dialect or adapter package below, and your driver package. Built-in drivers and Cloudflare D1 bindings need no driver package.

| Database or adapter | Required package     |
| ------------------- | -------------------- |
| PostgreSQL          | `@sqlbraid/postgres` |
| MySQL               | `@sqlbraid/mysql`    |
| MariaDB             | `@sqlbraid/mariadb`  |
| SQLite              | `@sqlbraid/sqlite`   |
| Oracle              | `@sqlbraid/oracle`   |
| SQL Server          | `@sqlbraid/mssql`    |
| Bun.SQL             | `@sqlbraid/bun-sql`  |

`sqlbraid` depends only on `@sqlbraid/core`, `@sqlbraid/runtime` and `@sqlbraid/template`, with no dialect or adapter peers. Install each package you use explicitly. Import `sql` and dialect hints from package roots, and factories from the adapter paths below.

Version 2.0.0 removes driver and dialect facade subpaths. All publishable first-party packages and the VS Code extension move together to `2.0.0`.

**Official** means CI tests that exact driver version and runtime against a real database; **Compatible** means the adapter follows the same API requirements without a pinned certified target.

| Database                           | Driver                                 | Import path                       | Support    |
| ---------------------------------- | -------------------------------------- | --------------------------------- | ---------- |
| PostgreSQL                         | `pg`                                   | `@sqlbraid/postgres/pg`           | Official   |
| PostgreSQL                         | `postgres` (postgres.js)               | `@sqlbraid/postgres/postgres-js`  | Compatible |
| PostgreSQL                         | `@neondatabase/serverless` (WebSocket) | `@sqlbraid/postgres/neon`         | Compatible |
| PostgreSQL                         | `@neondatabase/serverless` (HTTP)      | `@sqlbraid/postgres/neon-http`    | Compatible |
| PostgreSQL                         | `@electric-sql/pglite`                 | `@sqlbraid/postgres/pglite`       | Compatible |
| MySQL                              | `mysql2`                               | `@sqlbraid/mysql/mysql2`          | Official   |
| MariaDB                            | `mariadb`                              | `@sqlbraid/mariadb/mariadb`       | Official   |
| SQLite                             | `node:sqlite`                          | `@sqlbraid/sqlite/node-sqlite`    | Official   |
| SQLite                             | `better-sqlite3`                       | `@sqlbraid/sqlite/better-sqlite3` | Compatible |
| SQLite                             | `@libsql/client` (libSQL)              | `@sqlbraid/sqlite/libsql`         | Compatible |
| SQLite                             | `@sqlite.org/sqlite-wasm` (browser)    | `@sqlbraid/sqlite/wasm`           | Official   |
| SQLite                             | Cloudflare D1 binding                  | `@sqlbraid/sqlite/d1`             | Compatible |
| Oracle                             | `oracledb` (Thin)                      | `@sqlbraid/oracle/oracledb`       | Official   |
| SQL Server                         | `tedious`                              | `@sqlbraid/mssql/tedious`         | Official   |
| PostgreSQL, MySQL, MariaDB, SQLite | Bun.SQL (built into Bun)               | `@sqlbraid/bun-sql`               | Official   |

## Optional Tooling

All packages below are optional and are not dependencies of the base runtime (adding zero external runtime dependencies). See the [Package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) for the full list.

- **Code generation (`@sqlbraid/codegen`, `@sqlbraid/cli`):** Inspects your database schema to generate `Row`, `Insert`, and `Update` types, with `codegen --check` for CI verification (see [Codegen configuration](https://clickin.github.io/SQLBraid/latest/metadata/config/)).
- **Editor support (`@sqlbraid/language-server`, [VS Code extension](https://marketplace.visualstudio.com/items?itemName=sqlbraid.sqlbraid-vscode)):** Diagnostics, autocomplete, and hover info for SQL inside tagged templates.
- **Vite plugin (`@sqlbraid/vite`):** Runs the directive expression compiler at build time (see [Vite integration](https://clickin.github.io/SQLBraid/latest/getting-started/vite/)).
- **Webpack, Rspack & Next.js (`@sqlbraid/webpack`):** Directive compiler loader supporting both Webpack and Turbopack in Next.js 16 (see the [Next.js example](https://github.com/Clickin/SQLBraid/tree/main/examples/nextjs-webpack)).
- **Migrations (`@sqlbraid/migrate`, `@sqlbraid/cli`):** Runs versioned plain-SQL migration files and explicit schema drift checks at startup.
- **Agent skill ([`skills/sqlbraid`](https://github.com/Clickin/SQLBraid/tree/main/skills/sqlbraid)):** Portable instructions that teach AI coding agents how to write idiomatic SQLBraid queries.

## Entry Points

The root import (`sqlbraid`) is database-neutral and does not export an implicit `sql` tag.
Only `sqlbraid` and `sqlbraid/compiled` remain as facade entry points.

- **Dialect roots:** Import `sql` and parameter hints from `@sqlbraid/postgres`, `@sqlbraid/mysql`, `@sqlbraid/mariadb`, `@sqlbraid/sqlite`, `@sqlbraid/oracle` or `@sqlbraid/mssql`.
- **Adapter subpaths:** Import database factories from the owning package, such as `@sqlbraid/postgres/pg` or `@sqlbraid/sqlite/node-sqlite`.
- **Bun.SQL:** Use `@sqlbraid/bun-sql` and pass the target dialect explicitly.
- **`sqlbraid/compiled`:** Advanced entry point for generated helpers, not for manual query authoring.

## Examples

Every example project is integration-tested in CI against the packed release tarballs.

| Example                                                                                                       | Description                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`nextjs-webpack`](https://github.com/Clickin/SQLBraid/tree/main/examples/nextjs-webpack)                     | Next.js App Router, Webpack/Turbopack loader setup, dynamic filters, and transactions           |
| [`bookstore-api`](https://github.com/Clickin/SQLBraid/tree/main/examples/bookstore-api)                       | Hono REST API on PostgreSQL: migrations, Standard Schema mapping, order transactions, streaming |
| [`sqlite-quickstart`](https://github.com/Clickin/SQLBraid/tree/main/examples/sqlite-quickstart)               | Minimal setup with built-in `node:sqlite` and the directive compiler                            |
| [`postgres`](https://github.com/Clickin/SQLBraid/tree/main/examples/postgres)                                 | PostgreSQL direct client and connection pool usage                                              |
| [`mysql`](https://github.com/Clickin/SQLBraid/tree/main/examples/mysql)                                       | MySQL connection pool usage                                                                     |
| [`codegen`](https://github.com/Clickin/SQLBraid/tree/main/examples/codegen)                                   | Generating `Row`, `Insert`, and `Update` types from a metadata snapshot                         |
| [`opentelemetry-slow-query`](https://github.com/Clickin/SQLBraid/tree/main/examples/opentelemetry-slow-query) | Collecting query spans and duration metrics with the OpenTelemetry observer                     |

## Requirements & Status

- **Runtime requirements:** Runtime packages (`sqlbraid` and driver adapters) support Node.js 16.20.2 or newer (subject to each driver's own minimum Node version; `node:sqlite` and CLI/build tools require Node.js 22.18+). Active LTS releases are recommended.
- **Current status:** `sqlbraid` 2.x and `@sqlbraid/*` 1.x. The public API is stable and follows Semantic Versioning (SemVer). See the [Release notes](https://clickin.github.io/SQLBraid/latest/release/notes/), [Current limitations](https://clickin.github.io/SQLBraid/latest/release/limitations/), and [Roadmap](https://clickin.github.io/SQLBraid/latest/release/roadmap/).

## Development and AI Usage

I designed SQLBraid's architecture and APIs based on my experience with Java and MyBatis. All code commits were produced using coding agents, primarily Codex, with Claude used for independent reviews of implementation details, edge cases, and security issues. I reviewed the results and made the final design decisions.

SQLBraid has no AI runtime dependency.

## Contributing & License

Issues and pull requests are welcome (see [CONTRIBUTING.md](https://github.com/Clickin/SQLBraid/blob/main/CONTRIBUTING.md) and [SECURITY.md](https://github.com/Clickin/SQLBraid/blob/main/SECURITY.md)). Licensed under [Apache-2.0](https://github.com/Clickin/SQLBraid/blob/main/LICENSE).
