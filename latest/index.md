# SQLBraid

> Write SQL. Keep TypeScript. Skip the query-builder translation layer.

SQLBraid is a SQL-first TypeScript data-access toolkit. Keep the SQL you know, without a query-builder translation layer, while retaining the boundaries that matter in production.

- **SQL stays visible.** Tagged templates preserve ordinary SQL and database-specific features.
- **Values stay bound.** Ordinary value interpolation becomes a logical value parameter; the selected driver owns placeholder/materialization transport, while structural SQL requires an explicit helper.
- **Results stay explicit.** Declare `rows`, `command`, or `call`, then let runtime checks catch mismatches.
- **Runtime semantics stay honest.** Direct connections and pools use different factories; transactions pin one physical connection.
- **Tooling stays optional.** Metadata, deterministic code generation, LSP, CLI inspection, and VS Code support do not enter the runtime dependency path.

:::tip Start with SQLite
The [five-minute SQLite quickstart](/SQLBraid/latest/getting-started/sqlite.md) runs without an external server. For browser and Worker resources, see [SQLite WASM and D1](/SQLBraid/latest/getting-started/sqlite-browser.md). Move to [PostgreSQL](/SQLBraid/latest/getting-started/postgres.md), [MySQL](/SQLBraid/latest/getting-started/mysql.md), or [MariaDB](/SQLBraid/latest/getting-started/mariadb.md) when you need a service database.
:::

## What SQLBraid is not

SQLBraid does not infer arbitrary SELECT result types, hydrate object graphs, or hide SQL behind a model DSL. Your SQL and declared row type remain the contract. Standard Schema mapping is available when a row needs validation or transformation.

For the database-to-application value boundary, see [data representations and
numeric fidelity](/SQLBraid/latest/concepts/data-representation.md). Driver profiles
document the raw integer, decimal, JSON, temporal, and binary values that the
runtime can actually receive.

## Launch documentation

This is the 0.1.0 pre-release documentation. The current tree includes
session/lease ownership, fixed transaction options, prepared input factories,
capability-driven cancellation, and explicit unsupported errors. Targets
are documented by the [runtime and driver support matrix](/SQLBraid/latest/reference/support.md),
which records support labels for exact database/driver/profile/runtime/capability
tuples and their revision and workflow evidence. A neighboring version or
package installation is not certification. Final exact-SHA Runtime, Docs, and
Release gates and explicit release authorization remain separate requirements.
See [release notes and limitations](/SQLBraid/latest/release/notes.md) before choosing an
integration.
