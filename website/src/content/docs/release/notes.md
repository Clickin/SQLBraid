---
title: PV17 draft release notes
description: The pending PV17 surface for value fidelity, DML returning, bulk, MariaDB, Browser WASM, and D1.
---

PV17 starts from baseline `dccb69763e9e4a070280cf580d8f7b76368ec3d5`. Final
Runtime, Docs and Release dry-run evidence is pending; do not infer support
claims or release authorization from this draft. The docs-pages workflow
validates on push but deploys or updates history only from an explicit
`workflow_dispatch` with `deploy=true`. No final PV17 SHA, workflow run, npm RC,
or stable publication is claimed.

## Included contract

- PostgreSQL, MySQL, SQLite, Oracle Thin, and SQL Server/Tedious dialect and adapter paths, with explicit direct/pool ownership boundaries;
- `sql.rows`, `sql.command`, `sql.call`, safe value binds, structural fragments, and dynamic `@braid` directives;
- `db.stream()` as a real driver path rather than an `all()` buffer, with adapter-specific cleanup before physical lease release;
- Standard Schema mapping for rows and heterogeneous routine result-set tuples;
- routine channels for scalar `output`, ordered `resultSets`, and optional `returnValue`, with `sql.out`/`sql.inOut` direction helpers;
- PostgreSQL transaction-bound refcursor handling, Oracle explicit/implicit cursor results, SQL Server explicit procedure metadata for native RETURN status, and intentional SQLite routine rejection;
- MySQL raw prepared `Execute.stream()` support and explicit rejection of OUT/INOUT where mysql2 does not expose a proven carrier discriminator;
- materialized DML-returning contracts using native PostgreSQL/SQLite/MariaDB `RETURNING`, SQL Server `OUTPUT`, and Oracle `RETURNING ... INTO` plus `sql.out()`, without rewriting SQL across dialects;
- command-only `db.bulk(inputs, factory)` with pre-I/O shape validation, one physical lease, explicit `native-bulk`/`pipeline`/`prepared-loop`/`remote-batch` modes, and no implicit transaction or auto-chunking promise;
- separate `@sqlbraid/mariadb` dialect and MariaDB Connector/Node.js adapter path; `mysql2` connections to MariaDB remain best-effort compatibility;
- direct Browser SQLite WASM and Cloudflare D1 SQLite adapter paths, with D1 materialized execution and native remote batch;
- execution observers with `durationMs`, non-sensitive call result structure, and lazy diagnostic literalization;
- `@sqlbraid/vite` Vite 8 pre-transform that preserves TSX and source-map composition while leaving TypeScript and framework transforms to Vite;
- optional metadata, inspectors, deterministic code generation, CLI JSON inspection, standard stdio LSP, and thin VS Code integration.
- numeric fidelity helpers and data-representation profiles: exact numerics are
  canonical strings, approximate IEEE values are numbers, and
  `decodeExactInteger` is an opt-in application helper;
- JSON parsed/native and lossless-text profiles, temporal native convenience
  versus precision-preserving text profiles, and explicit SQL conversion
  workarounds where a driver cannot preserve exactness;
- ordinary `undefined` IN values fail before physical acquisition while `null`
  means SQL `NULL`; exact bind capabilities remain driver-specific and separate
  from query-builder SQL generation;
- SQLite INTEGER output is canonical decimal text; native bigint transport is
  internal and there is no public `integerMode` switch;

## Verification status

The shared manifest cells are pending PV17's final exact-SHA gates. The pending
runtime gates are one full Vitest pass on Node 22, the existing `test:all` pass
on Node 24, the fidelity benchmark, and the documentation/release dry-run on
one final revision. Actual publication was skipped; user acceptance and
explicit release authorization remain separate.

### Historical PV16 evidence

The prior PV16 revision-specific evidence and support labels remain available
in the [historical support evidence](/SQLBraid/reference/support/#release-evidence-provenance).
Those records do not certify PV17's changed value-fidelity contract.

## Upgrade discipline

Treat generated model files as derived artifacts. After metadata or config
changes, run `sqlbraid codegen` and commit the result, then run
`sqlbraid codegen --check`. Keep direct-vs-pool factories aligned with the
physical resource you own. Keep Vite transforms and the server database runtime
separate; never import Node-only database drivers into browser code.

See [routine calls](/SQLBraid/concepts/routines/), [streaming](/SQLBraid/runtime/streaming/),
[limitations](/SQLBraid/release/limitations/), and [runtime/driver support](/SQLBraid/reference/support/).
