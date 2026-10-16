# SQLBraid

> Write plain SQL in TypeScript, with type safety and no query builder.

SQLBraid is a SQL-first data-access library for TypeScript. You write raw SQL in tagged templates without translating queries into a builder DSL or ORM model.

- **Plain SQL in tagged templates:** Keep standard SQL syntax and database-specific features visible in your code.
- **Safe parameter binding:** Every `${value}` expression is extracted as a bound parameter, while the target driver adapter renders native placeholders (`$1`, `?`, `:1`, `@p1`). Structural SQL uses explicit helpers (`sql.ident`, `sql.list`, `sql.join`, `sql.fragment`).
- **Explicit result declarations:** Declare `sql.rows<T>`, `sql.command`, or `sql.call`, or pass a Standard Schema (Zod, Valibot, ArkType) for runtime validation and transformation.
- **Predictable connection ownership:** Direct clients and connection pools use separate factories, and `db.tx` pins a single physical connection across a transaction.
- **Optional tooling:** Schema codegen, migrations, build-time directive compilers (Vite, Webpack/Next.js), and the LSP/VS Code extension are optional and are not dependencies of the base runtime (adding zero external runtime dependencies).

:::tip Start with SQLite
The [five-minute SQLite quickstart](/SQLBraid/latest/getting-started/sqlite.md) runs without an external server. For browsers and Workers, read [SQLite WASM and D1](/SQLBraid/latest/getting-started/sqlite-browser.md). When you need a service database, go to [PostgreSQL](/SQLBraid/latest/getting-started/postgres.md), [MySQL](/SQLBraid/latest/getting-started/mysql.md) or [MariaDB](/SQLBraid/latest/getting-started/mariadb.md).
:::

## What SQLBraid is not

SQLBraid is not an ORM: it does not load relations automatically, maintain identity maps, or infer TypeScript types from arbitrary `SELECT` queries. You declare the expected row type or attach a Standard Schema, and optionally generate table models (`Row`, `Insert`, `Update`) with `@sqlbraid/codegen`.

For how SQLBraid handles 64-bit integers, exact decimals, JSON, and dates across drivers, see [Data representations and value fidelity](/SQLBraid/latest/concepts/data-representation.md).

## Launch documentation

The public API is stable and follows Semantic Versioning (`sqlbraid` 2.x and `@sqlbraid/*` 1.x). Because database drivers differ in what they support, check the [runtime and driver support matrix](/SQLBraid/latest/reference/support.md) for your exact database, driver, and runtime combination, along with the [release notes](/SQLBraid/latest/release/notes.md) and [current limitations](/SQLBraid/latest/release/limitations.md).
