# sqlbraid

The application-facing SQLBraid package. Choose a driver subpath, write typed
SQL tagged templates, and execute them through a `Database`.

```sh
npm install sqlbraid pg
```

```ts
import { Client } from "pg";
import { createPgDatabase, sql } from "sqlbraid/pg";

const client = new Client({ connectionString: "postgres://localhost:5432/app" });
await client.connect();

const db = createPgDatabase(client);
const users = await db.all(sql.rows<{ id: string }>`
  SELECT id FROM users
`);

await client.end();
```

The combined driver and dialect entrypoints are `sqlbraid/pg`,
`sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`,
`sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`,
`sqlbraid/d1`, `sqlbraid/oracledb`, and `sqlbraid/tedious`. Dialect-only entrypoints for custom adapters are
`sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle`,
and `sqlbraid/mssql`. The package root exports shared contracts and runtime
database constructors.

SQLite's synchronous `node:sqlite` and `better-sqlite3` adapters use the
`Awaitable<T>` physical SPI while keeping every public `Database` operation
async. The better-sqlite3 path therefore still blocks the JavaScript event loop;
SQLBraid does not turn synchronous native calls into background work.

The libSQL path requires `createLibsqlDatabase(client, { intMode: "string" })`.
It uses `@libsql/client`'s documented `execute`, `batch`, and interactive
`transaction()` handle. Ordinary calls do not provide a pinned-session
guarantee, and `db.stream()` is explicitly unsupported instead of buffering a
full result set. Use `readOnly: true` only where the driver's documented read
transaction mode is the desired contract; unsupported isolation options fail
explicitly.

For Bun, use `sqlbraid/bun-sql` with a separately selected SQLBraid dialect:

```ts
import { createBunSqlDatabase } from "sqlbraid/bun-sql";
import { sql } from "sqlbraid/postgres";

const client = new Bun.SQL("postgres://localhost:5432/app");
const db = createBunSqlDatabase(client, { dialect: "postgres" });
const users = await db.all(sql.rows`SELECT id FROM users`);
```

Bun ordinary statements use Bun.SQL's native callable value-template path.
SQLBraid does not generate `$1` or `?` placeholders. Structural/dynamic SQL is
lowered to final segments plus values before that call; Bun.SQL structural
helper-shaped values are rejected. `unsafe` is reserved for SQLBraid's
internal transaction-control statements.

The optional `@sqlbraid/cli`, compiler, Vite, metadata, and codegen packages
are available for project tooling.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
