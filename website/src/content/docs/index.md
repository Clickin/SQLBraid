---
title: SQLBraid
description: Write plain SQL in TypeScript, with type safety and no query builder.
template: splash
hero:
  title: Write SQL. Keep TypeScript.
  tagline: Safe parameter binds, in-SQL dynamic directives, explicit result declarations, and one unified execution API for PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server, Browser WASM, and Cloudflare D1.
  actions:
    - text: Get started
      link: /SQLBraid/getting-started/sqlite/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/Clickin/SQLBraid
      variant: minimal
---

SQLBraid is a SQL-first data-access library for TypeScript. You write raw SQL in tagged templates without translating queries into a builder DSL or ORM model.

- **Plain SQL in tagged templates:** Keep standard SQL syntax and database-specific features visible in your code.
- **Safe parameter binding:** Every `${value}` expression is extracted as a bound parameter, while the target driver adapter renders native placeholders (`$1`, `?`, `:1`, `@p1`). Structural SQL uses explicit helpers (`sql.ident`, `sql.list`, `sql.join`, `sql.fragment`).
- **Explicit result declarations:** Declare `sql.rows<T>`, `sql.command`, or `sql.call`, or pass a Standard Schema (Zod, Valibot, ArkType) for runtime validation and transformation.
- **Predictable connection ownership:** Direct clients and connection pools use separate factories, and `db.tx` pins a single physical connection across a transaction.
- **Optional tooling:** Schema codegen, migrations, build-time directive compilers (Vite, Webpack/Next.js), and the LSP/VS Code extension are optional and are not dependencies of the base runtime (adding zero external runtime dependencies).

:::tip Start with SQLite
The [five-minute SQLite quickstart](/SQLBraid/getting-started/sqlite/) runs without an external server. For browsers and Workers, read [SQLite WASM and D1](/SQLBraid/getting-started/sqlite-browser/). When you need a service database, go to [PostgreSQL](/SQLBraid/getting-started/postgres/), [MySQL](/SQLBraid/getting-started/mysql/) or [MariaDB](/SQLBraid/getting-started/mariadb/).
:::

## What SQLBraid is not

SQLBraid is not an ORM: it does not load relations automatically, maintain identity maps, or infer TypeScript types from arbitrary `SELECT` queries. You declare the expected row type or attach a Standard Schema, and optionally generate table models (`Row`, `Insert`, `Update`) with `@sqlbraid/codegen`.

For how SQLBraid handles 64-bit integers, exact decimals, JSON, and dates across drivers, see [Data representations and value fidelity](/SQLBraid/concepts/data-representation/).

## Launch documentation

The 1.x public API is stable and follows Semantic Versioning. Because database drivers differ in what they support, check the [runtime and driver support matrix](/SQLBraid/reference/support/) for your exact database, driver, and runtime combination, along with the [release notes](/SQLBraid/release/notes/) and [current limitations](/SQLBraid/release/limitations/).
