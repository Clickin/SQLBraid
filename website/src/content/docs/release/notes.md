---
title: PV18 draft release notes
description: The Stage A PV18 surface for profile-coherent fidelity, containers, DML returning, bulk, MariaDB, Browser WASM, and D1.
---

PV18 starts from review baseline `2119d9676b05fb2531eaf7aac1ef37741600ba40`.
Stage A implementation revision
`53db135bd156b6d65dc91785a671dec5249c95d4` has passed the [Runtime
portability run 34851691821](https://github.com/Clickin/SQLBraid/actions/runs/34851691821)
and [Documentation site run
34851706964](https://github.com/Clickin/SQLBraid/actions/runs/34851706964).
The [Release dry-run
34851703042](https://github.com/Clickin/SQLBraid/actions/runs/34851703042)
also passed. The eight eligible exact profiles are Official for Stage A; D1
remains Compatible because its managed SQLite version is unreported. These
records are revision-specific. Any later revision, including the revision
produced by this update, requires separate Stage B exact-final SHA verification
by Runtime, Docs, and Release gates; no Stage B completion or package
publication is claimed. The docs-pages workflow
validates on push but deploys or updates history only from an explicit
`workflow_dispatch` with `deploy=true`.

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
- numeric fidelity helpers and profile-coherent data-representation contracts: exact numerics are
  canonical strings, approximate IEEE values are numbers, and
  `decodeExactInteger` is an opt-in application helper;
- JSON parsed/native and lossless-text profiles, temporal native convenience
  versus precision-preserving text profiles, and explicit SQL conversion
  workarounds where a driver cannot preserve exactness;
- profile descriptors and `typePolicyForProfile({ json, temporal })` selectors
  shared by runtime and codegen for PostgreSQL, mysql2, and MariaDB;
- separate driver-raw and SQLBraid-canonical evidence, exact string IDs versus
  safe operational counts, and container-specific (not recursive) support
  status for arrays, domains, ranges, composites, objects, `sql_variant`,
  vectors, and parsed JSON roots;
- ordinary `undefined` IN values fail before physical acquisition while `null`
  means SQL `NULL`; exact bind capabilities remain driver-specific and separate
  from query-builder SQL generation;
- SQLite INTEGER output is canonical decimal text; native bigint transport is
  internal and there is no public `integerMode` switch;

## Verification status

The Stage A shared-manifest artifacts for PG16.4, scoped PG18.6, MySQL 8.4.2,
MariaDB 11.8.9, Oracle Free 23.9, SQL Server 2022 CU18 Developer, Node SQLite
3.50.2, and browser WASM 3.53.4 report `exactTupleObserved=true` and
`missingTests=[]`. These records are tied to the Stage A revision above and
remain revision-specific and are Official for Stage A. Any later revision
requires separate Stage B exact-final SHA verification. Actual publication is not claimed, and
user acceptance plus explicit release authorization remain separate. D1 remains
Compatible because its managed SQLite version is unreported.

### Historical PV16 evidence

The prior PV16/PV17 revision-specific evidence and support labels remain available
in the [historical support evidence](/SQLBraid/reference/support/#release-evidence-provenance).
Those records do not certify PV18's changed profile/container contract.

## Upgrade discipline

Treat generated model files as derived artifacts. After metadata or config
changes, run `sqlbraid codegen` and commit the result, then run
`sqlbraid codegen --check`. Keep direct-vs-pool factories aligned with the
physical resource you own. Keep Vite transforms and the server database runtime
separate; never import Node-only database drivers into browser code.

See [routine calls](/SQLBraid/concepts/routines/), [streaming](/SQLBraid/runtime/streaming/),
[limitations](/SQLBraid/release/limitations/), and [runtime/driver support](/SQLBraid/reference/support/).
