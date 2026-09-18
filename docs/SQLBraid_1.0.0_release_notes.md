# SQLBraid 1.0.0

**Write SQL. Keep TypeScript. Skip the query-builder translation layer.**

SQLBraid is a SQL-first data-access toolkit for TypeScript. You write ordinary SQL; SQLBraid adds safe value
binding, explicit result contracts, result mapping, connection and transaction ownership, and driver adapters
without introducing a query-builder language between your application and the database.

1.0.0 is the first stable release. The public API is now GA; driver capabilities
vary by database and transport; see the support matrix for details.

## Install

```sh
pnpm add sqlbraid
```

The main `sqlbraid` package is a facade over the first-party runtime and driver packages. Import the subpath
for the driver you use:

```ts
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";
import { DatabaseSync } from "node:sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
native.prepare("INSERT INTO users (name) VALUES (?)").run("Ada");

const db = createNodeSqliteDatabase(native);

const userId = 1;
const users = await db.all(sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE id = ${userId}
`);

// [{ id: "1", name: "Ada" }]
```

The built-in `node:sqlite` quickstart uses Node.js 22.18 or newer. Other adapters have their own certified
runtime and driver combinations.

## What is in 1.0

- **SQL-first tagged templates.** Ordinary `${value}` interpolation is always a value bind. Structural SQL requires
  explicit helpers such as `sql.ident`, `sql.fragment`, `sql.list`, `sql.join`, and deliberately unsafe
  `sql.raw`.
- **Result contracts.** Queries declare row, command, call, or unknown result kinds. `all`, `one`,
  `maybeOne`, `execute`, and `call` enforce those contracts.
- **Standard Schema result mapping.** Schemas can be attached to row queries or supplied per execution without
  turning SQLBraid into an ORM or relation-hydration layer.
- **Physical connection ownership.** Direct executors and provider/lease pools share the same runtime contract.
  `session()` pins a lease; `tx()` pins a transaction and uses savepoints for supported nested transactions.
- **Prepared queries, streaming, bulk execution, cancellation, and routines.** These are exposed through one
  runtime API and enabled only where the selected adapter can provide the required semantics.
- **Exact-value policy.** Exact integers and decimals are represented as strings; approximate IEEE values remain
  numbers. JSON, temporal values, binary values, containers, and driver-specific types have separate fidelity
  contracts.
- **Metadata and tooling.** Includes database inspection, deterministic model generation, CLI
  tooling, a stdio language server, Vite lowering, and an optional OpenTelemetry observer integration.
- **Direct failure for unsupported features.** Unsupported behavior raises a SQLBraid error instead of being silently
  buffered, emulated, downgraded, or ignored.

SQLBraid deliberately does not provide ORM graph hydration, a query-builder-first DSL, automatic routing or
retries, a universal prepared-statement cache, or a complete SQL semantic engine.

## Databases and adapters

1.0 ships first-party support for:

- **PostgreSQL** — `pg`, plus PostgreSQL through Bun.SQL
- **MySQL** — `mysql2`, plus MySQL through Bun.SQL
- **MariaDB** — `mariadb`, plus MariaDB through Bun.SQL
- **SQLite** — `node:sqlite`, `better-sqlite3`, libSQL, SQLite WASM, Cloudflare D1, and Bun.SQL SQLite
- **Oracle Database** — `oracledb`
- **SQL Server** — `tedious`

Support is based on specific database, driver, runtime, representation profile, and capability combinations. See the
[versioned support records](https://github.com/Clickin/SQLBraid/tree/v1.0.0/support/targets) for the exact matrix.

Convenience subpaths include `sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`,
`sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`, `sqlbraid/oracledb`,
`sqlbraid/tedious`, and `sqlbraid/bun-sql`. Granular `@sqlbraid/*` packages are available for custom integrations.
## Important limits in 1.0

The stable API does not mean every adapter implements every capability.

- mysql2 supports emitted `CALL` result sets, but SQLBraid OUT/INOUT descriptor carriers are not supported.
- SQLite adapters do not implement `db.call` / `routine.call`.
- `callStream` is reserved but not implemented.
- PostgreSQL refcursors require an existing transaction; direct SQL Server cursor OUT parameters are unsupported.
- Bun 1.3.14 MySQL/MariaDB reject both explicit `readOnly: true` and `readOnly: false`; omitting the option
  preserves the native session default.
- Bun 1.3.14 does not provide SQLBraid active cancellation, streaming, or routine carriers.
- libSQL does not provide pinned ordinary sessions or streaming; SQLBraid does not buffer results to emulate a
  stream.

The full capability matrix is maintained in the support records rather than duplicated in release notes.

## Transaction and resource correctness

A major part of the 1.0 work was making connection ownership and failure semantics explicit across drivers.

- PostgreSQL and Bun PostgreSQL reject with `BRAID_TX_NOT_COMMITTED` if the server reports that a requested
  `COMMIT` actually rolled back.
- Oracle keeps auto-commit outside SQLBraid-managed transactions.
- Tedious savepoint rollback failures propagate instead of returning an uncertain connection as healthy.
- Failed pooled adapter initialization releases or discards its lease correctly.
- Streams finish cleanup before lease release, and observer failures do not replace the original execution or
  cleanup error.
- node:sqlite preserves exact command ROWIDs; libSQL does not advertise an `insertId` where its native result
  cannot guarantee exactness.

## Package versioning after 1.0

The initial 1.0.0 release is coordinated across the first-party packages. After 1.0, packages can version and
release independently.

A PostgreSQL driver fix, for example, can release as `@sqlbraid/postgres@1.0.1` without forcing an unrelated
Oracle, SQLite, CLI, or facade release. The `sqlbraid` facade depends on compatible `^1.0.0` first-party
ranges and only needs a new version when its own public facade surface or compatibility contract changes.

The coordinated `v1.0.0` release remains the common starting point for the first stable package line.

## Links

- [Documentation](https://clickin.github.io/SQLBraid/v/1.0.0/)
- [Getting started](https://clickin.github.io/SQLBraid/v/1.0.0/getting-started/sqlite/)
- [Support matrix](https://github.com/Clickin/SQLBraid/tree/v1.0.0/support/targets)
- [npm: sqlbraid](https://www.npmjs.com/package/sqlbraid)
- [Source](https://github.com/Clickin/SQLBraid)
