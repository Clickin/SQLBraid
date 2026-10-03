---
title: SQLBraid
description: Write SQL. Keep TypeScript. Skip the query-builder translation layer.
template: splash
hero:
  title: Write SQL. Keep TypeScript.
  tagline: SQLBraid gives safe binds, readable dynamic SQL, explicit result declarations and a small runtime for PostgreSQL, MySQL, MariaDB, SQLite, Oracle and SQL Server. It also supports Browser WASM and D1.
  actions:
    - text: Get started
      link: /SQLBraid/getting-started/sqlite/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/Clickin/SQLBraid
      variant: minimal
---

SQLBraid is a SQL-first data-access toolkit for TypeScript. It has no query-builder translation layer. Its boundaries are ready for production.

- **SQL stays visible.** Tagged templates keep ordinary SQL and the features of each database.
- **Values stay bound.** An ordinary value interpolation becomes a logical value parameter. The selected driver owns the placeholders and the materialization transport. Structural SQL requires an explicit helper.
- **Results stay explicit.** Declare `rows`, `command` or `call`. Runtime checks then find mismatches.
- **Runtime semantics stay honest.** Direct connections and pools use different factories. A transaction pins one physical connection.
- **Tooling stays optional.** Metadata, deterministic code generation, LSP, CLI inspection and VS Code support are not runtime dependencies.

:::tip Start with SQLite
The [five-minute SQLite quickstart](/SQLBraid/getting-started/sqlite/) runs without an external server. For browsers and Workers, read [SQLite WASM and D1](/SQLBraid/getting-started/sqlite-browser/). When you need a service database, go to [PostgreSQL](/SQLBraid/getting-started/postgres/), [MySQL](/SQLBraid/getting-started/mysql/) or [MariaDB](/SQLBraid/getting-started/mariadb/).
:::

## What SQLBraid is not

SQLBraid does not infer the result types of arbitrary SELECT statements. It does not hydrate object graphs. It does not hide SQL behind a model DSL. Your SQL and your declared row type define the result. When a row needs validation or transformation, use Standard Schema mapping.

For the boundary between database values and application values, read [data
representations and numeric fidelity](/SQLBraid/concepts/data-representation/).
The driver profiles document the raw integer, decimal, JSON, temporal and binary
values that the runtime can actually receive.

## Launch documentation

1.0.0 GA makes the public API stable. Driver capabilities are different for each
driver. Thus, read the [runtime and driver support matrix](/SQLBraid/reference/support/)
for the exact features of your tuple of database, driver and runtime.

For more information, read the [release notes and limitations](/SQLBraid/release/notes/).
