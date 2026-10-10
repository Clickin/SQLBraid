---
title: Package map
description: Find the SQLBraid package that owns each concern.
---

| Package                     | Responsibility                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sqlbraid`                  | Canonical runtime facade; combined driver+dialect/query subpaths use matching adapters, while `/bun-sql` is a multi-dialect adapter with an explicit dialect |
| `@sqlbraid/core`            | Public interfaces, Standard Schema-facing types, and rendered parameter metadata                                                                             |
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
| `@sqlbraid/migrate`         | Optional SQL migrations and startup checks; `/node` loader, `/vite` manifest plugin and `/drift` adapter                                                     |
| `@sqlbraid/codegen`         | Metadata + TypePolicy to Row/Insert/Update declarations                                                                                                      |
| `@sqlbraid/tooling`         | Shared config/workspace evidence and semantic indexes                                                                                                        |
| `@sqlbraid/operations`      | Fingerprints and declaration manifests                                                                                                                       |
| `@sqlbraid/cli`             | Optional codegen, inspect, diagnostics, drift and `migrate` commands                                                                                         |
| `@sqlbraid/language-server` | Standard stdio LSP integration                                                                                                                               |

Install `sqlbraid` in application code. Then use a subpath that combines a driver
and a dialect:
`sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`,
`sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`, `sqlbraid/oracledb`
or `sqlbraid/tedious`. For Bun.SQL, use the `sqlbraid/bun-sql` adapter, which
supports many dialects. Import `sql` from the root of the selected dialect, and
give that dialect explicitly:

```ts
import { createBunSqlDatabase } from "sqlbraid/bun-sql";
import { sql } from "sqlbraid/postgres";

const client = new Bun.SQL(process.env.DATABASE_URL!);
const db = createBunSqlDatabase(client, { dialect: "postgres" });
```

The `node:sqlite` adapter uses the module that is part of Node. It does not need a separate driver package. Install the other external drivers that your application uses.

The root is database-neutral. It does not export an implicit `sql` tag. The
dialect-only subpaths `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`,
`sqlbraid/oracle` and `sqlbraid/mssql` are for custom adapters. The granular
`@sqlbraid/*` packages stay supported for library authors and for deliberately
narrower dependencies.

`sqlbraid/compiled` is an advanced entry point for the `capture` and
`assertDirectiveCondition` helpers that the compiler generates. It is not an API
for applications to write queries. It does not import the compiler. Use the same
version for the compiler and the runtime.

The string array that you give to `capture` is SQL text, as with `sql.raw()`.
Never build it from input. `capture` accepts only the template node kinds that
the compiler emits. Other nodes fail with `BRAID_STRUCTURE`.

- `@sqlbraid/bun-sql` has no static Bun import and requires an explicit
  `dialect`. It does not detect SQL semantics automatically.
- Runtime packages do not get metadata, codegen, compiler, editor or Vite
  dependencies. Install tooling packages only in development and build
  environments.
- The Oracle, SQL Server, MariaDB and Bun dependencies stay out of the portable
  roots.
- `@sqlbraid/vite` keeps Vite as a peer and does not import a framework.
- `@sqlbraid/opentelemetry` keeps `@opentelemetry/api` as a peer. It does not
  install an SDK, an exporter, a logger, driver instrumentation or a database
  driver.

The synchronous SQLite adapters use the physical SPI `Awaitable<T>`. The public
`Database` methods stay async.

- `better-sqlite3` still blocks the event loop. It reads exact integers with a
  setting on each statement.
- libSQL requires `{ intMode: "string" }` and uses an interactive transaction
  handle. It does not claim `session.pinned`. It reports
  `BRAID_STREAM_UNSUPPORTED` and does not buffer.

These are transport and capability boundaries. They are not broad support
labels.

- `db.session()` pins one provider lease. `db.tx()` uses that lease again. It
  supports savepoints and options only where the selected adapter advertises
  them.
- Prepared queries lock the logical shape, not the physical placeholders.
- Active cancellation comes from capabilities. Without the capability, it fails
  with `BRAID_CANCEL_UNSUPPORTED`.
- Bun 1.3.14 uses `{ bigint: true }` for PostgreSQL, MySQL and MariaDB, and
  `{ safeIntegers: true }` for SQLite. There is no column metadata. Thus, integral
  `Number` rows, and integral approximate `Number` rows, are rejected as
  ambiguous.
- PostgreSQL decimal is text. MySQL and MariaDB DECIMAL and binary byte carriers
  reject, unless your SQL converts them to text or hex.
- SQLite native decimal is unsupported.
- In Bun, an empty MySQL or MariaDB `SELECT` and DML or DDL that affects zero
  rows use the guarded `bun-sql.result-kind-metadata` condition. They can fail
  after execution with `BRAID_RESULT_KIND_AMBIGUOUS`.

Bun.SQL MySQL and MariaDB also reject explicit `readOnly: true` and
`readOnly: false` before I/O (`BRAID_TX_OPTION_UNSUPPORTED`,
`transaction.read-only`). If you omit the option, the native session default
stays. The access modes of Bun.SQL PostgreSQL do not change. Read the
[transaction option boundary](/SQLBraid/runtime/transaction-profiles/).

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
