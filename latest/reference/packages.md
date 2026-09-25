# Package map

> Find the SQLBraid package that owns each concern.

| Package                     | Responsibility                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sqlbraid`                  | Canonical runtime facade; combined driver+dialect/query subpaths use matching adapters, while `/bun-sql` is a multi-dialect adapter with an explicit dialect |
| `@sqlbraid/core`            | Public contracts, Standard Schema-facing types, and rendered parameter metadata                                                                              |
| `@sqlbraid/template`        | Tagged templates, directives, rendering, structural fragments, and `sql.bind`                                                                                |
| `@sqlbraid/runtime`         | Execution, mapping, result-kind checks, transactions, streaming, and prepared shapes                                                                         |
| `@sqlbraid/postgres`        | PostgreSQL dialect/TypePolicy; `/pg` adapter; `/inspector`                                                                                                   |
| `@sqlbraid/mysql`           | MySQL dialect/TypePolicy; `/mysql2` adapter; `/inspector`                                                                                                    |
| `@sqlbraid/sqlite`          | SQLite dialect; `/node-sqlite`, `/better-sqlite3`, `/libsql`, `/wasm`, and `/d1` adapters; `/inspector`                                                      |
| `@sqlbraid/mariadb`         | MariaDB dialect/TypePolicy; `/mariadb` adapter; `/inspector`                                                                                                 |
| `@sqlbraid/bun-sql`         | Bun.SQL adapter family with required user-selected PostgreSQL/MySQL/MariaDB/SQLite dialect                                                                   |
| `@sqlbraid/oracle`          | Oracle dialect/TypePolicy and parameter hints; `/oracledb` adapter; `/inspector`                                                                             |
| `@sqlbraid/mssql`           | SQL Server dialect/TypePolicy and parameter hints; `/tedious` adapter; `/inspector`                                                                          |
| `@sqlbraid/compiler`        | TypeScript discovery and guarded-template lowering                                                                                                           |
| `@sqlbraid/vite`            | Vite 8 pre-transform for guarded-template lowering with source maps                                                                                          |
| `@sqlbraid/opentelemetry`   | Optional OpenTelemetry DB client spans and duration metrics through observers                                                                                |
| `@sqlbraid/metadata`        | DB-fact snapshots, validation, identity, and drift                                                                                                           |
| `@sqlbraid/codegen`         | Metadata + TypePolicy to Row/Insert/Update declarations                                                                                                      |
| `@sqlbraid/tooling`         | Shared config/workspace evidence and semantic indexes                                                                                                        |
| `@sqlbraid/operations`      | Fingerprints and declaration manifests                                                                                                                       |
| `@sqlbraid/cli`             | Optional codegen, inspect, diagnostics, drift, and command-line tooling                                                                                      |
| `@sqlbraid/language-server` | Standard stdio LSP integration                                                                                                                               |

Install `sqlbraid` in application code, then use a combined driver+dialect/query
subpath:
`sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`,
`sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`, `sqlbraid/oracledb`,
or `sqlbraid/tedious`. For Bun.SQL, use the multi-dialect `sqlbraid/bun-sql`
adapter, import `sql` from the selected dialect root, and pass that dialect
explicitly:

```ts
import { createBunSqlDatabase } from "sqlbraid/bun-sql";
import { sql } from "sqlbraid/postgres";

const client = new Bun.SQL(process.env.DATABASE_URL!);
const db = createBunSqlDatabase(client, { dialect: "postgres" });
```

Node's built-in `node:sqlite` adapter needs no separate driver package; install other external drivers used by your application.

The root is database-neutral and does not export an implicit `sql` tag. The
dialect-only subpaths `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`,
`sqlbraid/oracle`, and `sqlbraid/mssql` are for custom adapters. The granular
`@sqlbraid/*` packages remain supported for library authors and deliberately
narrower dependencies.
`sqlbraid/compiled` is an advanced entrypoint for compiler-generated `capture`
and `assertDirectiveCondition` helpers, not an application query-authoring API.
It does not import the compiler; use matching compiler and runtime versions.
`@sqlbraid/bun-sql` has no static Bun import and requires an explicit `dialect`;
it does not auto-detect SQL semantics. Runtime packages do not acquire metadata,
codegen, compiler, editor, or Vite dependencies. Install tooling packages only
in development/build environments. The Oracle, SQL Server, MariaDB, and Bun
dependencies are kept out of portable roots. `@sqlbraid/vite` keeps Vite
as a peer and does not import a framework.
`@sqlbraid/opentelemetry` keeps `@opentelemetry/api` as a peer and does not
install an SDK, exporter, logger, driver instrumentation, or database driver.

The synchronous SQLite adapters use the `Awaitable<T>` physical SPI while
keeping public `Database` methods async. `better-sqlite3` remains event-loop
blocking and uses statement-local exact-integer reads. libSQL requires
`{ intMode: "string" }`, uses an interactive transaction handle, does not
claim `session.pinned`, and reports `BRAID_STREAM_UNSUPPORTED` instead of
buffering. These are transport and capability boundaries, not broad support
labels.

`db.session()` pins one provider lease; `db.tx()` reuses that lease and supports
savepoints/options only where the selected adapter advertises them. Prepared
queries lock logical shape, not physical placeholders. Active cancellation is
capability-driven and otherwise fails with `BRAID_CANCEL_UNSUPPORTED`. Bun 1.3.14
uses `{ bigint: true }` for PostgreSQL/MySQL/MariaDB and `{ safeIntegers: true }`
for SQLite; no column metadata means integral or integral-approximate `Number`
rows are rejected as ambiguous. PostgreSQL decimal is text; MySQL/MariaDB
DECIMAL and binary byte carriers reject without authored SQL text/hex conversion.
SQLite native decimal is unsupported. Bun MySQL/MariaDB empty `SELECT` and zero-affected DML/DDL use
guarded `bun-sql.result-kind-metadata` and may fail after execution with
`BRAID_RESULT_KIND_AMBIGUOUS`.

Bun.SQL MySQL/MariaDB also reject explicit `readOnly: true` and
`readOnly: false` before I/O (`BRAID_TX_OPTION_UNSUPPORTED`,
`transaction.read-only`). Omission preserves the native session default;
Bun.SQL PostgreSQL access modes are unchanged. See the
[transaction option boundary](/SQLBraid/latest/runtime/transaction-profiles.md).

The dependency direction is:

```text
core / compiler / metadata / codegen
                 ↓
          tooling / vite
             ↙     ↘
           CLI      LSP
                      ↑
                VS Code client
```
