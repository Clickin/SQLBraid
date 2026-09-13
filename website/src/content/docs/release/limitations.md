---
title: Current limitations
description: Know what 0.1.0 deliberately does not promise.
---

- **No Oracle or SQL Server adapter.** Oracle/node-oracledb needs a separate design for named and IN/OUT binds, cursors, LOBs, NUMBER and temporal representations, object types, result sets, and pool semantics.
- **No universal input codec.** Ordinary value interpolation is driver-bound; application JSON, temporal, custom-class, and binary conventions remain driver/application concerns.
- **No SQL-to-TypeScript inference.** Arbitrary SELECT/JOIN result inference and relation object-graph hydration are outside the contract.
- **No isolation API.** Transactions use the database/driver connection default unless the application issues explicit database SQL inside the callback.
- **No observer mutation/retry/routing.** Observers can inspect or fail an operation but cannot rewrite SQL, change binds, or retry.
- **Metadata is evidence, not a proof of invalidity.** Missing objects are open-world; routine argument lists can be incomplete.
- **SQLite routine calls are unsupported.** Streaming needs native statement iteration.
- **Custom drivers are not official support.** Implement `QueryExecutor`/`ConnectionProvider` and provide independent evidence.
- **Tooling is Node-first.** Compiler, CLI, LSP, and metadata/codegen tooling require the Node release environment even when runtime packages are portable.

These limitations are intentional release boundaries, not hidden fallback behavior. See the [roadmap](/SQLBraid/release/roadmap/) for post-release candidates.
