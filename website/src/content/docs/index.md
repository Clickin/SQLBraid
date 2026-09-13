---
title: SQLBraid
description: Write SQL. Keep TypeScript. Skip the query-builder translation layer.
template: splash
hero:
  title: Write SQL. Keep TypeScript.
  tagline: SQLBraid adds safe binds, readable dynamic SQL, explicit result contracts, and a small runtime for PostgreSQL, MySQL, SQLite, Oracle, and SQL Server.
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
- **Values stay bound.** Ordinary value interpolation is a driver bind; structural SQL requires an explicit helper.
- **Results stay explicit.** Declare `rows`, `command`, or `call`, then let runtime checks catch mismatches.
- **Runtime semantics stay honest.** Direct connections and pools use different factories; transactions pin one physical connection.
- **Tooling stays optional.** Metadata, deterministic code generation, LSP, CLI inspection, and VS Code support do not enter the runtime dependency path.

:::tip Start with SQLite
The [five-minute SQLite quickstart](/SQLBraid/getting-started/sqlite/) runs without an external server. Move to [PostgreSQL](/SQLBraid/getting-started/postgres/) or [MySQL](/SQLBraid/getting-started/mysql/) when you need a service database.
:::

## What SQLBraid is not

SQLBraid does not infer arbitrary SELECT result types, hydrate object graphs, or hide SQL behind a model DSL. Your SQL and declared row type remain the contract. Standard Schema mapping is available when a row needs validation or transformation.

## Launch documentation

This is the 0.1.0 release candidate documentation for the planned September 18 release. npm publication is not complete yet. See [release notes and limitations](/SQLBraid/release/notes/) and the [tested runtime/driver matrix](/SQLBraid/reference/support/) before choosing an integration.
