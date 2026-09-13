---
title: Current limitations
description: Know what the PV15 pre-release contract deliberately does not promise.
---

- **PV15 final verification is pending.** These docs do not claim a final SHA, CI gate, publication, or release label; historical evidence is marked as historical in the [support matrix](/SQLBraid/reference/support/).
- **`db.all()` is materialized.** It returns a readonly array and uses O(row-count) application memory. Use `db.stream()` for row-producing queries when bounded application memory matters.
- **Routine streaming is not included.** Materialized `db.call()` consumes and closes routine resources before mapping; multi-cursor session ownership is reserved for a future API.
- **MySQL prepared CALL OUT/INOUT is unsupported.** The mysql2 3.x public API does not prove which extra result is the OUT carrier, so SQLBraid does not guess.
- **PostgreSQL refcursor calls require an existing transaction.** A refcursor is a transaction-bound portal, not an independent driver ResultSet; SQLBraid does not wrap a root call in a hidden transaction.
- **SQL Server cursor output is unsupported as an application cursor.** `CURSOR VARYING OUTPUT` is a T-SQL language capability but ordinary client APIs do not expose it as a bindable ResultSet. Emitted `SELECT` rows remain ordinary result sets.
- **SQLite routine calls are unsupported.** SQLite scalar/aggregate/window functions run inside ordinary SQL, and virtual-table/table-valued extensions are ordinary row queries. `integerMode: "bigint"` is explicit and requires the native statement capability.
- **Native SQL Server RETURN status needs explicit procedure metadata.** Use `sql.call({ procedure: { name, parameterNames } })`; SQLBraid does not parse arbitrary `EXEC` text to guess identity.
- **No universal input codec.** Ordinary interpolation is driver-bound; application JSON, temporal, custom-class, and binary conventions remain driver/application concerns.
- **No SQL-to-TypeScript inference.** Arbitrary SELECT/JOIN result inference and relation object-graph hydration are outside the contract.
- **No isolation API.** Transactions use the database/driver connection default unless the application issues explicit database SQL inside the callback.
- **No observer mutation/retry/routing.** Observers inspect or fail an operation but cannot rewrite SQL, change binds, or retry.
- **Metadata is evidence, not proof of invalidity.** Missing objects are open-world and routine argument lists may be incomplete.
- **Custom drivers are not release support.** Implement `QueryExecutor`/`ConnectionProvider` and provide independent evidence.
- **Tooling is Node-first.** Compiler, CLI, LSP, metadata/codegen, and Vite integration have separate build/runtime concerns; do not ship Node-only database drivers into a browser bundle.

These are intentional boundaries, not hidden fallback behavior. See [routine
calls](/SQLBraid/concepts/routines/), [streaming](/SQLBraid/runtime/streaming/),
and the [roadmap](/SQLBraid/release/roadmap/) for future work.
