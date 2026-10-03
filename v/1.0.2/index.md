# SQLBraid

> Write SQL. Keep TypeScript. Skip the query-builder translation layer.

SQLBraid is a SQL-first data-access toolkit for TypeScript. It has no query-builder translation layer. Its boundaries are ready for production.

- **SQL stays visible.** Tagged templates keep ordinary SQL and the features of each database.
- **Values stay bound.** An ordinary value interpolation becomes a logical value parameter. The selected driver owns the placeholders and the materialization transport. Structural SQL requires an explicit helper.
- **Results stay explicit.** Declare `rows`, `command` or `call`. Runtime checks then find mismatches.
- **Runtime semantics stay honest.** Direct connections and pools use different factories. A transaction pins one physical connection.
- **Tooling stays optional.** Metadata, deterministic code generation, LSP, CLI inspection and VS Code support are not runtime dependencies.

:::tip Start with SQLite
The [five-minute SQLite quickstart](/SQLBraid/v/1.0.2/getting-started/sqlite.md) runs without an external server. For browsers and Workers, read [SQLite WASM and D1](/SQLBraid/v/1.0.2/getting-started/sqlite-browser.md). When you need a service database, go to [PostgreSQL](/SQLBraid/v/1.0.2/getting-started/postgres.md), [MySQL](/SQLBraid/v/1.0.2/getting-started/mysql.md) or [MariaDB](/SQLBraid/v/1.0.2/getting-started/mariadb.md).
:::

## What SQLBraid is not

SQLBraid does not infer the result types of arbitrary SELECT statements. It does not hydrate object graphs. It does not hide SQL behind a model DSL. Your SQL and your declared row type define the result. When a row needs validation or transformation, use Standard Schema mapping.

For the boundary between database values and application values, read [data
representations and numeric fidelity](/SQLBraid/v/1.0.2/concepts/data-representation.md).
The driver profiles document the raw integer, decimal, JSON, temporal and binary
values that the runtime can actually receive.

## Launch documentation

1.0.0 GA makes the public API stable. Driver capabilities are different for each
driver. Thus, read the [runtime and driver support matrix](/SQLBraid/v/1.0.2/reference/support.md)
for the exact features of your tuple of database, driver and runtime.

For more information, read the [release notes and limitations](/SQLBraid/v/1.0.2/release/notes.md).
