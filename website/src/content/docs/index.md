---
title: SQLBraid
description: Write SQL. Keep TypeScript. Skip the query-builder translation layer.
template: splash
hero:
  title: Write SQL. Keep TypeScript.
  tagline: SQLBraid adds safe binds, readable dynamic SQL, explicit result contracts, and a small runtime for PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL Server, with Browser WASM and D1 paths.
  actions:
    - text: Get started
      link: /SQLBraid/getting-started/sqlite/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/Clickin/SQLBraid
      variant: minimal
---

SQLBraid is a SQL-first TypeScript data-access toolkit. Keep the SQL you know, without a query-builder translation layer, while retaining the boundaries that matter in production.

- **SQL stays visible.** Tagged templates preserve ordinary SQL and database-specific features.
- **Values stay bound.** Ordinary value interpolation becomes a logical value parameter; the selected driver owns placeholder/materialization transport, while structural SQL requires an explicit helper.
- **Results stay explicit.** Declare `rows`, `command`, or `call`, then let runtime checks catch mismatches.
- **Runtime semantics stay honest.** Direct connections and pools use different factories; transactions pin one physical connection.
- **Tooling stays optional.** Metadata, deterministic code generation, LSP, CLI inspection, and VS Code support do not enter the runtime dependency path.

:::tip Start with SQLite
The [five-minute SQLite quickstart](/SQLBraid/getting-started/sqlite/) runs without an external server. For browser and Worker resources, see [SQLite WASM and D1](/SQLBraid/getting-started/sqlite-browser/). Move to [PostgreSQL](/SQLBraid/getting-started/postgres/), [MySQL](/SQLBraid/getting-started/mysql/), or [MariaDB](/SQLBraid/getting-started/mariadb/) when you need a service database.
:::

## What SQLBraid is not

SQLBraid does not infer arbitrary SELECT result types, hydrate object graphs, or hide SQL behind a model DSL. Your SQL and declared row type remain the contract. Standard Schema mapping is available when a row needs validation or transformation.

For the database-to-application value boundary, see [data representations and
numeric fidelity](/SQLBraid/concepts/data-representation/). Driver profiles
document the raw integer, decimal, JSON, temporal, and binary values that the
runtime can actually receive.

## Launch documentation

This is the 0.1.0 pre-release documentation. PV16 exact-final-SHA verification
is pending; these pages do not claim a final SHA, CI gate, publication, or
release label. See [release notes and limitations](/SQLBraid/release/notes/)
and the [runtime/driver evidence matrix](/SQLBraid/reference/support/) before
choosing an integration.
