# SQLBraid 1.0.0

This document records the 1.0.0 release. It is not the installation guide for 2.0.
For current installation and imports, see the [README](../README.md#quickstart-sqlite)
and [current release notes](../website/src/content/docs/release/notes.md).

**Write SQL and keep TypeScript, without a query-builder translation layer.**

SQLBraid is a SQL-first data-access toolkit for TypeScript. You write ordinary SQL; SQLBraid adds safe value
binding, explicit result declarations, result mapping, connection and transaction ownership, and driver adapters
without introducing a query-builder language between your application and the database.

1.0.0 is the first stable release. The public API is now GA; driver capabilities
vary by database and transport; see the support matrix for details.

## Install

Use the [versioned 1.0.0 installation guide](https://clickin.github.io/SQLBraid/v/1.0.0/getting-started/sqlite/)
for that release. For 2.0, install each dialect package and external driver explicitly.
The current [SQLite quickstart](../README.md#quickstart-sqlite) shows the package imports.

## What is in 1.0

- **SQL-first tagged templates.** Ordinary `${value}` interpolation is always a value bind. Structural SQL requires
  explicit helpers such as `sql.ident`, `sql.fragment`, `sql.list`, `sql.join`, and deliberately unsafe
  `sql.raw`.
- **Result declarations.** Queries declare row, command, call, or unknown result kinds. `all`, `one`,
  `maybeOne`, `execute`, and `call` enforce those declarations.
- **Standard Schema result mapping.** Schemas can be attached to row queries or supplied per execution without
  turning SQLBraid into an ORM or relation-hydration layer.
- **Physical connection ownership.** Direct executors and provider/lease pools follow the same runtime rules.
  `session()` pins a lease; `tx()` pins a transaction and uses savepoints for supported nested transactions.
- **Prepared queries, streaming, bulk execution, cancellation, and routines.** These are exposed through one
  runtime API and enabled only where the selected adapter can provide the required semantics.
- **Exact-value policy.** Exact integers and decimals are represented as strings; approximate IEEE values remain
  numbers. JSON, temporal values, binary values, containers, and driver-specific types have separate fidelity
  rules.
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

The 1.0 facade exposed convenience entry points for these adapters.
Version 2.0 removes those entry points. Import dialect tags from the owning
`@sqlbraid/*` package and factories from its adapter subpaths.

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

A PostgreSQL driver fix could release independently of unrelated adapters.
In 1.x, the facade depended on compatible first-party package ranges.
Version 2.0 removes dialect and adapter dependencies from the facade.

The coordinated `v1.0.0` release remains the common starting point for the first stable package line.

## Links

- [Documentation](https://clickin.github.io/SQLBraid/v/1.0.0/)
- [Getting started](https://clickin.github.io/SQLBraid/v/1.0.0/getting-started/sqlite/)
- [Support matrix](https://github.com/Clickin/SQLBraid/tree/v1.0.0/support/targets)
- [npm: sqlbraid](https://www.npmjs.com/package/sqlbraid)
- [Source](https://github.com/Clickin/SQLBraid)
