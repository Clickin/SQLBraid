---
title: Current limitations
description: Know what the pre-release contract deliberately does not promise.
---

- **Certification is tuple-, revision-, and evidence-specific.** The [runtime and driver support matrix](/SQLBraid/reference/support/) is the canonical evidence source and records the exact database/driver/profile/runtime/capability tuple with its revision and workflow evidence. A neighboring version or package installation is not certification. Final exact-SHA Runtime, Docs, and Release gates and explicit release authorization remain separate requirements. Passing CI does not authorize publication.
- **`db.all()` is materialized.** It returns a readonly array and uses O(row-count) application memory. Use `db.stream()` when bounded application memory matters.
- **Routine streaming is not included.** Materialized `db.call()` consumes and closes routine resources before mapping; raw cursors, portals, requests, and carrier rows never escape.
- **MySQL and MariaDB prepared CALL OUT/INOUT is unsupported.** Neither mysql2 3.x nor MariaDB Connector/Node.js exposes a proven public discriminator for prepared call OUT carriers, so SQLBraid does not guess a carrier row.
- **PostgreSQL refcursor calls require an existing transaction.** A refcursor is a transaction-bound portal, not an independent ResultSet; SQLBraid does not create a hidden transaction.
- **SQL Server cursor output is not an application cursor.** `CURSOR VARYING OUTPUT` is not exposed as a bindable client ResultSet; emitted `SELECT` rows remain ordinary result sets.
- **SQLite routine calls are unsupported.** Scalar/aggregate/window functions and virtual-table extensions remain ordinary SQL. D1 additionally has no callback transaction or incremental cursor.
- **DML-returning is materialized.** Use `sql.rows` with `db.execute`, `db.all`, `db.one`, or `db.maybeOne`. Do not infer that `RETURNING`/`OUTPUT` is streamable across drivers.
- **`db.bulk()` is command-only.** It locks one DML shape, validates all inputs before I/O, uses one lease, and reports the actual mode. Root bulk has no portable atomicity or auto-chunking promise; use `db.tx()` for atomicity.
- **Sessions and transactions are physical-scope APIs.** `db.session()` pins one provider lease; nested session/transaction work reuses it. Root escape and closed/sibling handles reject. Missing primitives use `BRAID_SESSION_UNSUPPORTED` or `BRAID_TX_UNSUPPORTED`.
- **Transaction options are fixed and capability-driven.** Isolation is one of `read-uncommitted`, `read-committed`, `repeatable-read`, or `serializable`; `readOnly` is separate. Malformed runtime values fail before acquisition with `TypeError` / `BRAID_TX_OPTIONS_INVALID`; valid but unsupported values use `BRAID_TX_OPTION_UNSUPPORTED`; nested explicit options use `BRAID_TX_OPTIONS_NESTED`.
- **Cancellation is capability-driven.** An already-aborted signal preserves its `reason`. An active signal without physical cancellation fails before I/O with `UnsupportedFeatureError` / `BRAID_CANCEL_UNSUPPORTED`; stopping iteration alone is not cancellation.
- **No universal input codec.** Ordinary interpolation is driver-bound; application JSON, temporal, custom-class, and binary conventions remain driver/application concerns.
- **Numeric fidelity is profile-specific.** Exact database integers and decimals are canonical strings; approximate IEEE values are numbers. `decodeExactInteger` is an opt-in application transform. Bun 1.3.14 uses `{ bigint: true }` for PostgreSQL/MySQL/MariaDB and `{ safeIntegers: true }` for SQLite. Integral `Number` rows reject; PostgreSQL decimal is text, MySQL/MariaDB DECIMAL and binary byte carriers reject without authored SQL text/hex conversion, and SQLite native decimal is unsupported. D1 remains guarded to its safe-integer range; use authored `CAST(... AS TEXT)` when exact text matters.
- **JSON and temporal fidelity are separate profiles.** Parsed JSON may contain rounded nested numbers; native `Date` may lose fractional precision or offset/zone semantics. Use a tested text profile or authored `JSON_SERIALIZE`/`TO_CHAR`/`CONVERT` SQL.
- **Containers are not scalar guarantees.** Arrays, domains, ranges, multiranges, composites, Oracle objects/collections, SQL Server `sql_variant`, vectors, and nested values remain unclassified or unsupported until tested.
- **Profile and codegen must agree.** Changing driver JSON/temporal/numeric options creates a different evidence profile; runtime and generated models must reuse its TypePolicy.
- **Bun SQL is user-selected.** `createBunSqlDatabase` requires `dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`; the adapter does not auto-detect. Bun 1.3.14 active cancellation fails with `BRAID_CANCEL_UNSUPPORTED`, and stream/routine carriers fail explicitly with `BRAID_STREAM_UNSUPPORTED` and `BRAID_CALL_UNSUPPORTED`. `result.rows`/`result.command` metadata is guarded by `bun-sql.result-kind-metadata`; for MySQL/MariaDB, empty `SELECT` and zero-affected DML/DDL fail after execution with `BRAID_RESULT_KIND_AMBIGUOUS`, so side effects may already have occurred.
- **Deno reuses existing adapters.** A public Node-compatible driver path may work in Deno; this does not create a Deno dialect or promote a support tuple.
- **No SQL-to-TypeScript inference.** Arbitrary SELECT/JOIN result inference and relation graph hydration are outside the contract.
- **No observer mutation/retry/routing.** Observers inspect or fail an operation but cannot rewrite SQL, change binds, retry, or route.
- **Metadata is evidence, not invalidity proof.** Missing objects are open-world and routine argument lists may be incomplete.
- **Custom drivers are not release support.** Implement `QueryExecutor`/`ConnectionProvider` and provide independent exact evidence.
- **Tooling is Node-first.** Compiler, CLI, LSP, metadata/codegen, and Vite integration have separate build/runtime concerns; do not ship Node-only drivers into browser bundles.

These are intentional boundaries, not hidden fallback behavior. See [routine
calls](/SQLBraid/concepts/routines/), [streaming](/SQLBraid/runtime/streaming/),
[transactions](/SQLBraid/runtime/transactions/), and the [support matrix](/SQLBraid/reference/support/).
