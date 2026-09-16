---
name: sqlbraid
description: Build, modify, review, and debug SQL-first TypeScript database code with SQLBraid. Use for SQLBraid queries, safe value binding, structural or dynamic SQL, typed result contracts, transactions, sessions, streaming, prepared queries, database adapters, metadata/codegen, LSP diagnostics, or SQLBraid configuration.
---

# SQLBraid

Use SQL directly. Do not translate SQLBraid code into an ORM or query-builder DSL unless the user explicitly asks for that migration.

## Start from the project

1. Inspect existing imports, `package.json`, and `sqlbraid.config.mjs`, `.js`, or `.cjs` before changing database code.
2. Check the installed SQLBraid version before relying on version-sensitive APIs. Prefer local types/source and the matching versioned documentation at `https://clickin.github.io/SQLBraid/v/<version>/llms.txt` when that release snapshot exists. Do not use newer `/latest` behavior to justify an API that is absent from the project.
3. Preserve the project's selected dialect, driver, runtime, and transaction behavior unless the task explicitly changes one of them.
4. Prefer the existing SQLBraid adapter and factory. Do not invent a driver, placeholder syntax, or transaction capability from the database name alone.

## Write queries with explicit result kinds

Use the dialect-configured `sql` export already used by the project, for example the combined PostgreSQL facade at `sqlbraid/pg`.

- Row-producing SQL: `sql.rows<T>`.
- DML or DDL that returns command metadata: `sql.command`.
- Procedures or routines with routine semantics: `sql.call(...)`.
- Plain `sql` means an intentionally unknown result kind; do not use it just to avoid choosing the correct contract.

Match runtime operations to the contract: `db.all`, `db.one`, `db.maybeOne`, and `db.stream` consume row queries; `db.execute` executes row, command, or unknown queries and checks the actual adapter result kind; `db.call` is for call queries.

SQLBraid does not infer arbitrary SELECT result types. A generic such as `sql.rows<UserRow>` is the developer's compile-time contract, not runtime validation. Use the project's Standard Schema mapping when runtime validation or transformation is required.

## Keep values and SQL structure separate

Ordinary interpolation is always a value bind:

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE organization_id = ${organizationId}
`;
```

Never manually rewrite bound values into PostgreSQL `$1`, MySQL `?`, Oracle `:1`, SQL Server `@p1`, or another placeholder form. The adapter owns physical placeholder/materialization transport.

When interpolation changes SQL structure, use an explicit structural helper:

- `sql.ident(...)` for identifiers.
- `sql.fragment\`...\`` for dialect-bound SQL fragments that may contain ordinary binds.
- `sql.list(values)` for a non-empty list of value binds.
- `sql.join(fragments, separator)` for combining fragments.
- `sql.raw(text)` only for application-trusted SQL text. Never pass user-controlled text to it.
- `sql.empty` for an empty dialect-bound fragment.

Do not interpolate an identifier, keyword, sort direction, clause, or SQL fragment as an ordinary value.

Read `references/queries.md` when changing query construction, result contracts, dynamic SQL, or binding behavior.

## Respect physical connection scope

`db.tx(...)` and `db.session(...)` pin physical execution scope. Inside their callbacks, perform scoped work through the callback handle, not the outer root `db`.

Inside nested transactions/savepoints, use the innermost handle. Do not overlap a live stream with transaction/savepoint work that requires the same pinned resource. Unsupported transaction, savepoint, session, streaming, cancellation, bulk, or prepared behavior must remain an explicit unsupported capability; do not silently emulate a stronger guarantee.

Read `references/runtime.md` for transactions, sessions, streaming, batch/bulk, and capability-sensitive changes.

## Use SQLBraid evidence when tooling is available

For an existing SQLBraid project, prefer the project's semantic evidence over reconstructing database facts from text:

1. Use standard LSP diagnostics, hover, completion, definition, references, symbols, and signature help when available.
2. Otherwise use `sqlbraid inspect query --file <path> --line <1-based> --column <1-based> --json`, `sqlbraid inspect symbol <name> --json`, or `sqlbraid inspect diagnostics --file <path> --json`.
3. Treat metadata as open-world positive evidence. Missing metadata is not proof that a relation, column, routine, extension object, UDF, temporary object, or CTE is invalid.
4. Generated models are derived artifacts. Change configuration or metadata, run `sqlbraid codegen`, then `sqlbraid codegen --check`; do not hand-edit generated models.

Read `references/tooling.md` for the evidence model and the independent dialect/driver/runtime/transaction axes.

## Before finishing

- Keep ordinary SQL readable and database-specific SQL intact unless the requested change requires otherwise.
- Preserve value binding and make every structural insertion explicit.
- Preserve result-kind and cardinality intent.
- Preserve transaction/session ownership and actual adapter capabilities.
- Run the project's normal TypeScript/tests plus SQLBraid diagnostics or `codegen --check` when the changed area uses them.
