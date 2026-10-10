# @sqlbraid/migrate

Versioned SQL migrations and explicit startup checks for SQLBraid.
Migrations are SQL files only. The application supplies its `Database` and dialect. Creating a database does not run migrations.

```sh
npm install @sqlbraid/migrate
npm install --save-dev @sqlbraid/cli
```

Use `@sqlbraid/core` and `@sqlbraid/runtime` version `1.0.3` or later.
MySQL and SQL Server migrations also need `@sqlbraid/mysql` or `@sqlbraid/mssql` version `1.0.3` or later.
Earlier runtimes ignore the migration runner's simple-execution request.
Earlier MySQL and SQL Server adapters do not implement the required execution paths.
The CLI commands need `@sqlbraid/cli` and `@sqlbraid/tooling` version `1.0.3` or later.
Optional schema drift needs `@sqlbraid/metadata` version `1.0.3` or later.

[SQLBraid documentation](https://clickin.github.io/SQLBraid/)

## Migration files

```text
migrations/
  V001__create_users.sql
  V002__email_index.sql
  V002__email_index.postgres.sql
  V003__backfill.sql
  R__active_users.sql
```

`V<version>__` files run once, in numeric version order. Dots and underscores separate version components.
Leading zeroes do not change version identity. `R__` files run after versioned files and run again when their checksum changes.

A dialect-specific file has a dialect id after the first dot of its description, for example `.postgres.sql`.
The supported ids are `postgres`, `mysql`, `mariadb`, `sqlite`, `oracle` and `mssql`.
A description must not contain dots. The loader rejects any other text after the first dot.
The loader follows symbolic links to files and directories. It rejects a directory that it reaches two times.

A dialect-specific file takes precedence over the generic file for the same version.
A missing variant without a generic file fails; it is not skipped.
Use an empty dialect-specific file for an intentional no-op.

Checksums use SHA-256 of UTF-8 source text. The loader removes a leading BOM and changes CRLF to LF.
Other whitespace remains significant. Do not change an applied versioned migration. Write a new migration instead.

Only `.sql` files are migrations. A file with a migration name prefix (`V<version>__` or `R__`) and a different extension,
such as `V003__backfill.ts`, makes the loader fail with `BRAID_MIGRATE_SOURCE`. The loader does not skip it.
A `.sql` file with a name that is almost a migration name also fails, so that a typo cannot skip a migration.
Examples are `v2__users.sql`, `V2_users.sql`, `V2-users.sql`, `R_view.sql` and `r__view.sql`.
The loader ignores other files, such as `README.md` or `schema.snapshot.json`.
If a data change needs application logic, run it as application code or as a one-time script, not as a migration.

**Load only trusted files.** The runner executes SQL files as trusted SQL. It does not bind parameters in them.

## Startup

Call the check before accepting requests. This example uses Node's SQLite driver:

```ts
import { DatabaseSync } from "node:sqlite";
import { dialect } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { createMigrator } from "@sqlbraid/migrate";
import { loadMigrations } from "@sqlbraid/migrate/node";

const native = new DatabaseSync("application.sqlite");
const db = createNodeSqliteDatabase(native);
const migrator = createMigrator({
  manifest: await loadMigrations("./migrations", { dialects: ["sqlite"] }),
  dialect,
});

await migrator.startup(db, { mode: "verify", ahead: "allow" });
// Start the server only after this promise resolves.
```

The application owns the database connection and closes it at shutdown.
The Node version must also satisfy the selected driver's requirements.

| Mode     | Behavior                                                              |
| -------- | --------------------------------------------------------------------- |
| `off`    | Performs no database I/O.                                             |
| `report` | Reads history and returns differences without writing.                |
| `verify` | Reads history and rejects an incompatible state. This is the default. |
| `apply`  | Applies pending migrations, then verifies the result.                 |

A normal current check uses one history `SELECT`. A missing history table reports `uninitialized` without creating it.
`report` and `verify` need only read access to that table. Optional schema inspection needs catalog access too.

`ahead` defaults to `allow`. Set it to `error` to reject database versions newer than the application manifest.
Allowing a newer version does not prove that the application remains compatible with the changed schema.
Pending versions, changed repeatables, missing sources, checksum changes and out-of-order versions still prevent successful verification.
The runner always rejects an out-of-order version. Give it a version after the newest applied version.

`startup()` is the only method that checks and applies. `sqlbraid migrate up` calls it with `mode: "apply"`.
Use `apply` in one deployment step when possible. Use `verify` in production application instances.
For Workers, keep the migrator and database handle at module scope and call `migrator.once(db, options)` before handling requests.
It shares a promise for that database and check policy. A rejected check can retry after `retryIntervalMs` (default: 1000).
Choose either SQLBraid or Wrangler to own D1 migration history; this package does not import Wrangler history.

## CLI configuration

Keep migration configuration in the existing `sqlbraid.config.ts`, `.mjs`, `.js` or `.cjs` file.
Configuration files are executable code, not a sandbox.

```ts
import { DatabaseSync } from "node:sqlite";
import { defineConfig } from "@sqlbraid/cli/config";
import { dialect } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";

export default defineConfig({
  migrations: {
    directory: "./migrations",
    dialect,
    database() {
      const native = new DatabaseSync("application.sqlite");
      return {
        db: createNodeSqliteDatabase(native),
        cleanup: () => native.close(),
      };
    },
    options: { scope: "default", busyTimeoutMs: 30000 },
  },
});
```

The CLI calls `cleanup` after database commands, including failures.
If the factory fails before returning, the factory must clean up its acquired resources.
`new` and `manifest` do not call the database factory.
The migrations directory and configured snapshot path are relative to the config file.

```sh
sqlbraid migrate new create_users
sqlbraid migrate new email_index --dialect postgres
sqlbraid migrate status --json
sqlbraid migrate status --check
sqlbraid migrate up
sqlbraid migrate baseline 001
sqlbraid migrate repair
sqlbraid migrate accept-schema
sqlbraid migrate manifest --out-file ./src/migrations.mjs
sqlbraid migrate snapshot
```

`status` reports and exits with code 0. With `--check`, it exits with code 1 unless the report is `current`.
An `ahead` report passes the check when the configured `ahead` policy is `allow`. A configured `schemaCheck` applies too.

All commands accept `--config <path>`. `new` creates the next integer version without overwriting a file.
`new` includes migrations in subdirectories when it selects the next version.
`baseline` records an existing database at a manifest version without executing earlier migrations. It requires empty history for the selected scope.

**Inspect the database before running `repair`.** It removes `running` and `failed` attempts, not their database changes.
A later `up` can execute those migrations again. There are no down migrations.
Restore a backup or write a forward migration to reverse a schema change.

## SQL separators and ownership

| Dialect           | Splitting                                                                | Transaction and lock behavior                                                 |
| ----------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| PostgreSQL        | Semicolons outside quoted tokens; dollar-quoted bodies remain intact.    | Uses transactions for DDL and a native advisory lock with a pinned session.   |
| MySQL and MariaDB | Semicolons; use `DELIMITER` for routines.                                | Claims commit before DDL. Uses `GET_LOCK` with a pinned session.              |
| SQLite            | Semicolons; trigger `BEGIN ... END` bodies remain intact.                | Uses transactions when the adapter guarantees them. No extra lock table.      |
| Oracle            | Semicolons for SQL; `/` alone on a line ends PL/SQL.                     | Claims commit before DDL. No `DBMS_LOCK` grant is required.                   |
| SQL Server        | `GO` alone on a line separates batches. `GO` repeat counts are rejected. | Uses transactions and a session-owned application lock with a pinned session. |

SQL Server batches run as plain Tedious batches on one connection, as `sqlcmd` runs them.
Thus, `SET` options, `#temp` tables and `USE` stay in effect for later batches of the same migration.

D1 and SQLite WASM use the SQLite dialect. The runner checks the adapter's transaction capability; it does not simulate transactions or sessions.
DDL that cannot run in a transaction needs a leading directive:

```sql
-- @braid-migrate transaction=off
CREATE INDEX CONCURRENTLY users_email_idx ON users (email);
```

A nontransactional migration commits its history claim before it runs. If it fails, it leaves a `failed` row.

Use `-- @braid-migrate split=none` at the start to send one file as one statement. On SQL Server, the file is one batch.
On PostgreSQL and SQLite, a `split=none` file must contain exactly one statement. The runner rejects a file with more than one statement.
A `split=none` file that contains only comments is a no-op.
In that mode, omit client commands such as `GO`, `DELIMITER` and `/`; they are not driver SQL.

Write each directive as a `-- @braid-migrate <option>` line comment, with a space after `--`.
The runner rejects other comment forms that contain `@braid-migrate`, such as `#` comments, block comments and `--@braid-migrate`.

The quoted `_sqlbraid_migrations` table is the only history table. Oracle users must also quote this name in manual queries.
Options `table`, `schema` and `scope` select its location and migration set.
The primary key `(scope, installed_rank)` claims the next attempt, including when a pinned session is unavailable.
A competing runner rereads history after a claim conflict. It never executes the migration owned by that claim.

A transactional migration failure rolls back its claim and DDL.
Without transactional DDL, failure leaves a `failed` row. A stopped process can leave a `running` row.
A running row waits up to `busyTimeoutMs`, then fails. The runner cannot determine whether its owner crashed.
`busyTimeoutMs` must be an integer from `0` through `2147483647`, inclusive. Configuration validation uses the same limits.

Database statements use the existing execution observers. The optional `onEvent` callback reports startup, locks and migration start/end/error.
Event callbacks can throw. A callback failure cannot undo a completed nontransactional database change.
No migration code is added to `createDatabase()` or to runtime observers.
These paths do not assign new Official support labels to driver/runtime tuples.

## Deploy the SQL with the server

The migrator needs a manifest: the SQL text and the checksum of each migration.
Choose one of these ways to get the manifest into a server. In all three, the SQL stays on the server.

| Server build                           | Manifest source                                           | What you deploy                                      |
| -------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| Unbundled Node server                  | `loadMigrations("./migrations")` at startup               | The server and the `migrations/` directory           |
| Any bundler, `tsc`, Workers, Bun, Deno | `sqlbraid migrate manifest --out-file src/migrations.mjs` | The server only; the SQL is in the module            |
| Vite SSR                               | `import manifest from "virtual:sqlbraid-migrations"`      | The server bundle only; the SQL is in a server chunk |

### Generated manifest

`sqlbraid migrate manifest` writes a plain ESM module. The module has no imports.
It contains each SQL migration as a string literal, so any bundler, `tsc` copy step or runtime can load it.
`generateManifestModule()` from `@sqlbraid/migrate/node` returns the same source.
Without a `dialects` list, it includes only dialects with a source for every migration.
An explicit list rejects missing sources. `loadMigrations()` without a list checks sources when the selected dialect is accessed.
The runtime root performs no filesystem access.

The module does not update itself. Generate it again after you add or change a migration, for example in the build script.

The migrator checks the format of each checksum. It does not calculate the checksums again from the SQL text.
Treat the module as build output and do not edit it. If you edit a SQL string in it, the migrator runs the changed SQL
and records the old checksum. The checksum comparison of `status` and the startup check cannot find that change.

### Vite SSR

```ts
import { defineConfig } from "vite";
import migrations from "@sqlbraid/migrate/vite";

export default defineConfig({
  plugins: [migrations({ directory: "migrations", dialects: ["sqlite"] })],
});
```

Import the default manifest from `virtual:sqlbraid-migrations` in server code.
Add an ambient declaration for this virtual module to your application's environment declarations:

<!-- doc-snippet: skip -->

```ts
declare module "virtual:sqlbraid-migrations" {
  const manifest: import("@sqlbraid/migrate").MigrationManifest;
  export default manifest;
}
```

The plugin puts the SQL text into the server chunk as string literals. It does not emit `.sql` files as assets.
Do not copy SQL files as static assets. Vite copies `publicDir` into the client output, and a static server can serve emitted files.

The plugin keeps the SQL away from browsers:

- A client module cannot import `virtual:sqlbraid-migrations`. The build or the request fails.
- A client module cannot import a file in the migrations directory, for example with `?raw` or `?url`.
- The development server returns `404` for HTTP requests to files in the migrations directory, including `/@fs/` paths.
- The plugin rejects a migrations directory inside `publicDir`.

The server output contains the SQL. Do not serve the server output directory as static files.
The plugin does not own a database connection.
To enable development reports, pass `dev: { db, migrator: { dialect } }` to the plugin.
It runs read-only checks at startup and after migration file changes, and reports differences in the terminal and Vite overlay.

## Optional schema drift

Install `@sqlbraid/metadata` and supply a first-party `/inspector` implementation through `createSchemaDrift` from `@sqlbraid/migrate/drift`.
The helper accepts `{ inspector, snapshot? }`; `snapshot` is an optional validated `MetadataSnapshot` committed with the application.
Pass the returned adapter as the migrator's `drift` option.

After an apply, the runner records the inspected hash on its last successful history row.
With a drift adapter, `baseline` also inspects the schema and stores the hash on its baseline row.
`startup(db, { schema: "hash" })` compares a fresh inspection with the last stored hash.
With `mode: "apply"`, the runner does this comparison before it applies migrations. If the schema has drift, it applies nothing.
When a committed snapshot is supplied, differences include metadata paths.
These paths compare the inspected schema with the committed snapshot, not with the schema that produced the stored hash.
Catalog inspection occurs after releasing the migration session; it is not an atomic snapshot against external DDL.
If history has no stored schema hash, the check has no previous schema evidence to compare.

A stored hash can become stale. For example, an inspection can fail after an apply, or an apply can run without a drift adapter.
To accept the current schema as the expected schema, call `migrator.acceptSchema(db)` or run `sqlbraid migrate accept-schema`.
This operation inspects the schema and stores its hash on the latest successful history row of the scope.
It holds the migration lock where the dialect has one. It rejects uninitialized or incomplete history.
**Inspect the schema before you accept it.** The runner never accepts drift automatically.

To read the inspected snapshot, call `inspect()` on the drift adapter. The drift inspector owns its connection.

For the CLI, return `inspector` from the database factory alongside `db` and `cleanup`.
Set `options.schemaCheck: "hash"` for checks and optionally set `snapshot` to the committed snapshot path.
`sqlbraid migrate snapshot` writes `migrations/schema.snapshot.json` by default.

The runtime root, Node loader and optional drift helper require Node 16.20.2 or later.
Vite and CLI integration require Node 22.18.0 or later.
Runtime-only SQLBraid installs do not pull in this migration package.
