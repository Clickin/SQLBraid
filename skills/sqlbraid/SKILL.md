---
name: sqlbraid
description: Build, modify, review, and debug SQL-first TypeScript database code with SQLBraid. Use for SQLBraid queries, safe value binding, structural or dynamic SQL, typed result declarations, transactions, sessions, streaming, prepared queries, database adapters, metadata/codegen, LSP diagnostics, or SQLBraid configuration.
---

# SQLBraid

Use SQL directly. Do not translate SQLBraid code into an ORM or a query-builder DSL. Do this only if the user explicitly asks for that migration.

## Start from the project

1. Before you change database code, inspect the existing imports, `package.json` and `sqlbraid.config.mjs`, `.js` or `.cjs`.
2. Before you use a version-sensitive API, check the installed SQLBraid version. Use the local types and source first. If the release snapshot exists, use the matching versioned documentation at `https://clickin.github.io/SQLBraid/v/<version>/llms.txt`. Do not use newer `/latest` behavior to justify an API that the project does not have.
3. Keep the dialect, driver, runtime and transaction behavior that the project selected. Change one only if the task explicitly requires it.
4. Use the existing SQLBraid adapter and factory. Do not invent a driver, a placeholder syntax or a transaction capability from the database name alone.

## Write queries with explicit result kinds

Use the dialect-configured `sql` export that the project already uses. An example is the combined PostgreSQL facade at `sqlbraid/pg`.

- SQL that produces rows: `sql.rows<T>`.
- DML or DDL that returns command metadata: `sql.command`.
- Procedures or routines with routine semantics: `sql.call(...)`.
- Plain `sql` means that the result kind is unknown on purpose. Do not use it only to avoid the selection of the correct result kind.

Match the runtime operation to the result kind:

- `db.all`, `db.one`, `db.maybeOne` and `db.stream` read row queries.
- `db.execute` executes row, command or unknown queries. It checks the actual result kind from the adapter.
- `db.call` is for call queries.

SQLBraid does not infer the result types of arbitrary SELECT statements. A generic such as `sql.rows<UserRow>` is a compile-time declaration by the developer. It is not runtime validation. When runtime validation or transformation is necessary, use the Standard Schema mapping of the project.

## Keep values and SQL structure separate

Ordinary interpolation is always a value bind:

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE organization_id = ${organizationId}
`;
```

Do not manually rewrite bound values into PostgreSQL `$1`, MySQL `?`, Oracle `:1`, SQL Server `@p1` or another placeholder form. The adapter owns the physical placeholders and the materialization transport.

If an interpolation changes the SQL structure, use an explicit structural helper:

- `sql.ident(...)` for identifiers.
- `sql.fragment\`...\`` for dialect-bound SQL fragments. A fragment can contain ordinary binds.
- `sql.list(values)` for a non-empty list of value binds.
- `sql.join(fragments, separator)` to combine fragments.
- `sql.raw(text)` only for SQL text that the application trusts. Do not give it text that a user controls.
- `sql.empty` for an empty dialect-bound fragment.

Do not interpolate an identifier, keyword, sort direction, clause or SQL fragment as an ordinary value.

Before you change query construction, result declarations, dynamic SQL or binding behavior, read `references/queries.md`.

## Respect physical connection scope

`db.tx(...)` and `db.session(...)` pin the physical execution scope. Inside their callbacks, do scoped work through the callback handle. Do not use the outer root `db`.

Inside nested transactions or savepoints, use the innermost handle. Do not let a live stream overlap with transaction or savepoint work that needs the same pinned resource. Unsupported transaction, savepoint, session, streaming, cancellation, bulk or prepared behavior must stay an explicit unsupported capability. Do not silently emulate a stronger guarantee.

For transactions, sessions, streaming, batch and bulk, and changes that depend on capabilities, read `references/runtime.md`.

## Use SQLBraid evidence when tooling is available

In an existing SQLBraid project, use the semantic evidence of the project. Do not reconstruct database facts from text.

1. If they are available, use the standard LSP diagnostics, hover, completion, definition, references, symbols and signature help.
2. If not, use `sqlbraid inspect query --file <path> --line <1-based> --column <1-based> --json`, `sqlbraid inspect symbol <name> --json` or `sqlbraid inspect diagnostics --file <path> --json`.
3. Treat metadata as open-world positive evidence. Missing metadata does not prove that a relation, column, routine, extension object, UDF, temporary object or CTE is invalid.
4. Generated models are derived artifacts. Change the configuration or the metadata. Run `sqlbraid codegen`, then `sqlbraid codegen --check`. Do not edit generated models manually.

For the evidence model and the independent dialect, driver, runtime and transaction axes, read `references/tooling.md`.

## Before finishing

- Keep ordinary SQL readable. Keep database-specific SQL unchanged, unless the requested change requires a change.
- Keep value binding. Make each structural insertion explicit.
- Keep the intended result kind and cardinality.
- Keep the transaction and session ownership and the actual adapter capabilities.
- Run the normal TypeScript checks and tests of the project. If the changed area uses them, also run SQLBraid diagnostics or `codegen --check`.
