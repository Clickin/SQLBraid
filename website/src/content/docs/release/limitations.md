---
title: Current limitations
description: Know what the PV16 pre-release contract deliberately does not promise.
---

- **PV16 final verification is pending.** These docs do not claim a final SHA, CI gate, publication, or release label; historical evidence is marked as historical in the [support matrix](/SQLBraid/reference/support/).
- **`db.all()` is materialized.** It returns a readonly array and uses O(row-count) application memory. Use `db.stream()` for row-producing queries when bounded application memory matters.
- **Routine streaming is not included.** Materialized `db.call()` consumes and closes routine resources before mapping; multi-cursor session ownership is reserved for a future API.
- **MySQL prepared CALL OUT/INOUT is unsupported.** The mysql2 3.x public API does not prove which extra result is the OUT carrier, so SQLBraid does not guess.
- **PostgreSQL refcursor calls require an existing transaction.** A refcursor is a transaction-bound portal, not an independent driver ResultSet; SQLBraid does not wrap a root call in a hidden transaction.
- **SQL Server cursor output is unsupported as an application cursor.** `CURSOR VARYING OUTPUT` is a T-SQL language capability but ordinary client APIs do not expose it as a bindable ResultSet. Emitted `SELECT` rows remain ordinary result sets.
- **SQLite routine calls are unsupported.** SQLite scalar/aggregate/window functions run inside ordinary SQL, and virtual-table/table-valued extensions are ordinary row queries. `integerMode: "bigint"` is explicit and requires the native statement capability.
- **DML-returning is materialized only.** Use `sql.rows` with `db.execute`, `db.all`, `db.one`, or `db.maybeOne`; `db.stream()` for `RETURNING`/`OUTPUT` is not a cross-driver PV16 support claim.
- **DML-returning syntax is native.** PostgreSQL/SQLite/MariaDB use documented `RETURNING` forms, SQL Server uses `OUTPUT`, Oracle uses `RETURNING ... INTO` with `sql.out()`, and MySQL has no generic DML `RETURNING` clause.
- **`db.bulk()` is command-only.** It locks one DML shape, validates all inputs before I/O, uses one physical lease, and reports `native-bulk`, `pipeline`, `prepared-loop`, or `remote-batch`. Empty input performs no acquire. Root bulk is not implicitly transactional and has no portable auto-chunking promise; use `db.tx()` for atomicity.
- **MariaDB is a separate dialect.** MariaDB Connector/Node.js evidence is independent from `mysql2`; a `mysql2` connection to MariaDB is best-effort compatibility and not an Official MariaDB capability claim. Exact `UPDATE RETURNING` support is not claimed.
- **Browser SQLite WASM is a direct resource.** It does not provide a pool; conflicting root operations during a transaction or stream reject rather than escape to another resource.
- **Cloudflare D1 is materialized and remote-batch only.** The Worker Binding API has no incremental cursor, so `db.stream()` and callback `db.tx()` are `BRAID_STREAM_UNSUPPORTED`; SQLBraid does not paginate or emulate transactions.
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
