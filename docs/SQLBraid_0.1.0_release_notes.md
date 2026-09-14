# SQLBraid 0.1.0

Write SQL. Keep TypeScript. Skip the query-builder translation layer.

Draft release notes; this document does not claim an npm RC or stable publication.
PV16 exact-final-SHA verification is pending.
Documentation baseline for the PV16 cleanup is
`b5600ebf8a3fed4b80c6f31550a37488ef057525`; the final revision is intentionally
not recorded yet.

SQLBraid 0.1.0 provides:

- SQL-first TypeScript tags with safe binds and explicit row, command, and routine result contracts.
- Dynamic SQL with `@braid` directives and structural SQL fragments.
- Standard Schema result mapping without changing the declared query contract.
- Direct and pool-backed PostgreSQL (`pg`) and MySQL (`mysql2`) adapters, plus SQLite through `node:sqlite`.
- A separate MariaDB dialect and official Connector/Node.js adapter path, plus
  Browser SQLite WASM and Cloudflare D1 SQLite adapter paths.
- Oracle Thin (`node-oracledb`) and SQL Server (`tedious`) adapters, explicit `sql.bind(value, hint)` database parameter metadata, and conservative catalog inspectors.
- Physical-connection-safe transactions, nested savepoints, streaming, prepared queries, and execution observers.
- Native streaming for the five PV15 drivers plus MariaDB with cleanup-before-release, bounded
  delivery, MySQL break/drain reuse and abort/discard behavior.
- Heterogeneous routine result tuples, scalar OUT/INOUT and separate actual
  return/status channels, with query-bound Standard Schema per channel.
- MySQL row streams reject multiple result sets and drain before connection
  reuse; cleanup failures discard the connection. A declared routine return
  schema makes the successful result's `returnValue` property required.
- MySQL ordinary materialized queries, including bare/unknown execution, reject
  multiple result sets with `BRAID_RESULT_SETS_UNSUPPORTED`; use `db.call()` for
  ordered routine sets. Fully materialized rejection leaves the connection reusable.
- Materialized DML-returning through native PostgreSQL/SQLite/MariaDB
  `RETURNING`, SQL Server `OUTPUT`, and Oracle `RETURNING ... INTO` with
  `sql.out()`. DML-returning streaming is not a cross-driver support claim.
- Command-only `db.bulk(inputs, factory)` with pre-I/O shape validation, one
  physical lease, and explicit native-bulk/pipeline/prepared-loop/remote-batch
  modes. Root bulk has no portable transaction or auto-chunking promise.
- Vite 8 guarded-template pre-transform and original TS/TSX source maps, exercised
  through a packed TanStack Start / Node 24 finance consumer.
- Explicit SQLite number/bigint integer modes for exact 64-bit application models.
- Numeric fidelity helpers and bilingual data-representation guidance. Exact
  integers use `bigint`; exact decimals remain strings. Tedious decimal/numeric
  results remain unsupported as arbitrary-precision decimals, and Oracle
  `NUMBER` results remain strings.
- Metadata inspection and deterministic Row / Insert / Update code generation.
- An agent-native language server, CLI JSON inspection fallback, and a VS Code extension.
- Five-dialect tooling, a driver-free unscoped `sqlbraid` CLI package, and English/Korean documentation under mutable `/dev/` and immutable `/v/<version>/` URLs.
- Release evidence for Node 22.18.0, Bun 1.3.14, and Deno 2.9.3 packed artifacts.

## Current limitations

- First-party targets now include Oracle Thin and SQL Server. New combinations require same-revision CI before an Official support claim; Bun/Deno driver subpaths and Oracle Thick are outside this phase.
- Oracle calls support scalar OUT/INOUT, multiple REF CURSORs and implicit results.
  Tedious supports native procedure OUTPUT, RETURN and emitted sets; direct
  CURSOR VARYING OUTPUT remains Unsupported. Oracle NUMBER results are exact
  strings; Tedious decimal/numeric results are JavaScript numbers, not
  arbitrary-precision decimals.
- PostgreSQL refcursors require an existing transaction. MySQL emitted sets retain
  independent metadata; OUT/INOUT descriptors are explicitly Unsupported because
  mysql2 cannot safely identify the protocol carrier. SQLite `call()` and
  `callStream()` are not implemented. Table/set-returning functions use row queries.
- Explicit hints are honored or rejected before execution. Ordinary PostgreSQL,
  MySQL and SQLite inputs reject hints; PostgreSQL cursor outputs use the dedicated
  refcursor classification hint. Oracle rejects precision/scale facets, IN length
  and NUMBER decimal-string input. Ordinary binds retain driver behavior.
- Vite integration does not make runtime/driver modules browser-compatible.
  Database execution stays server-only; SQLite bigint needs explicit application
  serialization rather than implicit JSON conversion.
- SQLBraid uses the database/session default transaction isolation. It does not currently select or change an isolation level.
- Metadata is open-world positive evidence. Unknown tables, routines, temporary objects, CTEs, and runtime UDFs are not rejected merely because they are absent from a snapshot.
- Generated models are derived artifacts; run `sqlbraid codegen --check` in CI after metadata or configuration changes.
- The VS Code extension requires a TypeScript project with SQLBraid package/config evidence in the workspace folder.
- MariaDB 11.8 evidence is separate from MySQL/mysql2; mysql2 on MariaDB is
  best-effort compatibility. The current Oracle Free 23.9 provisioner does not
  provide Oracle 19c evidence.

## Artifact and provenance record

The immutable release workflow records the exact tag and commit in its preserved artifact manifest, validates every tarball before publication, derives npm publication order from workspace dependencies, and publishes only those unchanged tarballs. Final npm publication requires GitHub Actions trusted publishing/OIDC and npm provenance.

The GitHub Release is created as a draft after validated npm publication. The VSIX is attached by the release workflow after package inspection and a clean-profile VS Code host gate.
