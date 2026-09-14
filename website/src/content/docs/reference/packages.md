---
title: Package map
description: Find the SQLBraid package that owns each concern.
---

| Package | Responsibility |
| --- | --- |
| `@sqlbraid/core` | Public contracts, Standard Schema-facing types, and rendered parameter metadata |
| `@sqlbraid/template` | Tagged templates, directives, rendering, structural fragments, and `sql.bind` |
| `@sqlbraid/runtime` | Execution, mapping, result-kind checks, transactions, streaming, and prepared shapes |
| `@sqlbraid/postgres` | PostgreSQL dialect/TypePolicy; `/pg` adapter; `/inspector` |
| `@sqlbraid/mysql` | MySQL dialect/TypePolicy; `/mysql2` adapter; `/inspector` |
| `@sqlbraid/sqlite` | SQLite dialect; `/node-sqlite`, `/wasm`, and `/d1` adapters; `/inspector` |
| `@sqlbraid/mariadb` | MariaDB dialect/TypePolicy; `/mariadb` adapter |
| `@sqlbraid/bun-sql` | Bun.SQL adapter family with required user-selected PostgreSQL/MySQL/MariaDB/SQLite dialect |
| `@sqlbraid/oracle` | Oracle dialect/TypePolicy and parameter hints; `/oracledb` adapter; `/inspector` |
| `@sqlbraid/mssql` | SQL Server dialect/TypePolicy and parameter hints; `/tedious` adapter; `/inspector` |
| `@sqlbraid/compiler` | TypeScript discovery and guarded-template lowering |
| `@sqlbraid/vite` | Vite 8 pre-transform for guarded-template lowering with source maps |
| `@sqlbraid/metadata` | DB-fact snapshots, validation, identity, and drift |
| `@sqlbraid/codegen` | Metadata + TypePolicy to Row/Insert/Update declarations |
| `@sqlbraid/tooling` | Shared config/workspace evidence and semantic indexes |
| `@sqlbraid/operations` | Fingerprints and declaration manifests |
| `@sqlbraid/cli` | Codegen, inspect, diagnostics, drift, and command-line fallback |
| `@sqlbraid/language-server` | Standard stdio LSP integration |
| `sqlbraid` | Unscoped CLI convenience package; provides the `sqlbraid` executable without database drivers |

The package set includes the scoped runtime/tooling packages plus the unscoped CLI convenience package. `@sqlbraid/bun-sql` has no static Bun import and requires an explicit `dialect`; it does not auto-detect SQL semantics. Runtime packages do not acquire metadata, codegen, compiler, editor, or Vite dependencies. Install tooling packages only in development/build environments. The Oracle, SQL Server, MariaDB, and Bun driver dependencies are kept out of portable roots. `@sqlbraid/vite` keeps Vite as a peer and does not import a framework.

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
