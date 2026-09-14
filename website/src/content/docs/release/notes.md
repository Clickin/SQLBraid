---
title: PV16 release notes
description: The pre-release surface for DML returning, bulk, MariaDB, Browser WASM, and D1.
---

Exact-final-SHA
verification is pending; these notes make no final SHA, CI, publication, or
Official support claim.
The documentation baseline is
`b5600ebf8a3fed4b80c6f31550a37488ef057525`; the final revision remains
unrecorded.

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
- numeric fidelity helpers and data-representation profiles: exact integers use
  `bigint`, exact decimals remain strings, Oracle `NUMBER` remains text, and
  Tedious `decimal`/`numeric` is not exact decimal support;

## Verification status

Main owns PV16 final verification. Until that evidence is supplied, treat the
support matrix as Pending and historical exact-SHA links as provenance only.
Do not infer publication or release-gate completion from this site or from a
package README.

## Upgrade discipline

Treat generated model files as derived artifacts. After metadata or config
changes, run `sqlbraid codegen` and commit the result, then run
`sqlbraid codegen --check`. Keep direct-vs-pool factories aligned with the
physical resource you own. Keep Vite transforms and the server database runtime
separate; never import Node-only database drivers into browser code.

See [routine calls](/SQLBraid/concepts/routines/), [streaming](/SQLBraid/runtime/streaming/),
[limitations](/SQLBraid/release/limitations/), and [runtime/driver support](/SQLBraid/reference/support/).
