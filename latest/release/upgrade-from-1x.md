# Upgrade from 1.x to 2.0

> Replace the removed sqlbraid driver subpaths with the dialect and adapter packages.

SQLBraid 2.0 removes the driver and dialect subpaths of the `sqlbraid` package. Query APIs and runtime behavior do not change. An upgrade changes the installed packages and the import paths.

Only `sqlbraid` moves to `2.0.0`. Each other first-party package keeps its own version line.

## What changes

In 1.x, `sqlbraid` depended on every dialect and adapter package. A subpath such as `sqlbraid/node-sqlite` exported the adapter factory and the `sql` tag together.

In 2.0, `sqlbraid` has only the `sqlbraid` and `sqlbraid/compiled` entry points. Its dependencies are `@sqlbraid/core`, `@sqlbraid/runtime` and `@sqlbraid/template`. The old subpaths do not exist. There are no compatibility aliases.

Two packages replace each old subpath:

- The dialect package exports `sql`, `dialect`, `typePolicy`, the representation profile constants and the parameter hints.
- The adapter subpath of the same package exports the factory, such as `createNodeSqliteDatabase`.

Your external driver does not change. Keep the `pg`, `mysql2`, `oracledb` or `tedious` version that you use now.

## 1. Find the old imports

Run this command in your project root:

```bash
grep -rEn "from \"sqlbraid/(pg|postgres|mysql2|mysql|mariadb|node-sqlite|better-sqlite3|libsql|sqlite-wasm|d1|sqlite|oracledb|oracle|tedious|mssql|bun-sql)\"" src
```

Keep imports from `sqlbraid` and `sqlbraid/compiled`. Replace all other matches.

## 2. Install the packages

Install the dialect package for each database that your application uses. Keep `sqlbraid` for the shared types and the runtime factories.

```bash
pnpm add sqlbraid@2 @sqlbraid/sqlite
```

Use the package from the table for your database:

| 1.x subpath               | 2.0 factory import                | 2.0 dialect import   | Package to install   |
| ------------------------- | --------------------------------- | -------------------- | -------------------- |
| `sqlbraid/pg`             | `@sqlbraid/postgres/pg`           | `@sqlbraid/postgres` | `@sqlbraid/postgres` |
| `sqlbraid/postgres`       | none                              | `@sqlbraid/postgres` | `@sqlbraid/postgres` |
| `sqlbraid/mysql2`         | `@sqlbraid/mysql/mysql2`          | `@sqlbraid/mysql`    | `@sqlbraid/mysql`    |
| `sqlbraid/mysql`          | none                              | `@sqlbraid/mysql`    | `@sqlbraid/mysql`    |
| `sqlbraid/mariadb`        | `@sqlbraid/mariadb/mariadb`       | `@sqlbraid/mariadb`  | `@sqlbraid/mariadb`  |
| `sqlbraid/node-sqlite`    | `@sqlbraid/sqlite/node-sqlite`    | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/better-sqlite3` | `@sqlbraid/sqlite/better-sqlite3` | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/libsql`         | `@sqlbraid/sqlite/libsql`         | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/sqlite-wasm`    | `@sqlbraid/sqlite/wasm`           | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/d1`             | `@sqlbraid/sqlite/d1`             | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/sqlite`         | none                              | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/oracledb`       | `@sqlbraid/oracle/oracledb`       | `@sqlbraid/oracle`   | `@sqlbraid/oracle`   |
| `sqlbraid/oracle`         | none                              | `@sqlbraid/oracle`   | `@sqlbraid/oracle`   |
| `sqlbraid/tedious`        | `@sqlbraid/mssql/tedious`         | `@sqlbraid/mssql`    | `@sqlbraid/mssql`    |
| `sqlbraid/mssql`          | none                              | `@sqlbraid/mssql`    | `@sqlbraid/mssql`    |
| `sqlbraid/bun-sql`        | `@sqlbraid/bun-sql`               | the selected dialect | `@sqlbraid/bun-sql`  |

For Bun.SQL, import `sql` from the dialect package that you select. Pass the dialect to the adapter explicitly. See the [Bun.SQL notes](/SQLBraid/latest/release/limitations.md).

## 3. Replace the imports

Split each old import into the factory import and the dialect import.

<!-- doc-snippet: skip -->

```ts
// 1.x
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";
```

```ts
// 2.0
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";
```

The rule is the same for all drivers. Names that configure the dialect come from the dialect package. Examples are `sql`, `typePolicy`, `postgresParameter` and `MYSQL2_NATIVE`. Names that create a database from a driver come from the adapter subpath.

## 4. Check the result

Run the type check and your tests:

```bash
pnpm exec tsc --noEmit
```

An old import fails with one of these errors:

- TypeScript reports `Cannot find module 'sqlbraid/node-sqlite'`.
- Node reports `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## Other packages

- `@sqlbraid/migrate` goes from `0.1.1` to `0.2.0`.
- Upgrade `@sqlbraid/compiler` and `@sqlbraid/cli` to `1.1.0`. Older compiler versions recognize only the removed subpaths.
- Install `@sqlbraid/template` as a direct dependency if your application uses compiled queries.

See the [release notes](/SQLBraid/latest/release/notes.md) for the full list of changes.
