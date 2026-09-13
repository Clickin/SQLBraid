# SQLBraid 0.1.0

Write SQL. Keep TypeScript. Skip the query-builder translation layer.

Draft release notes; this document does not claim an npm RC or stable publication.

SQLBraid 0.1.0 provides:

- SQL-first TypeScript tags with safe binds and explicit row, command, and routine result contracts.
- Dynamic SQL with `@braid` directives and structural SQL fragments.
- Standard Schema result mapping without changing the declared query contract.
- Direct and pool-backed PostgreSQL (`pg`) and MySQL (`mysql2`) adapters, plus SQLite through `node:sqlite`.
- Oracle Thin (`node-oracledb`) and SQL Server (`tedious`) adapters, explicit `sql.bind(value, hint)` database parameter metadata, and conservative catalog inspectors.
- Physical-connection-safe transactions, nested savepoints, streaming, prepared queries, and execution observers.
- Native streaming for all five drivers with cleanup-before-release, bounded
  delivery, MySQL break/drain reuse and abort/discard behavior.
- Heterogeneous routine result tuples, scalar OUT/INOUT and separate actual
  return/status channels, with query-bound Standard Schema per channel.
- Vite 8 guarded-template pre-transform and original TS/TSX source maps, exercised
  through a packed TanStack Start / Node 24 finance consumer.
- Explicit SQLite number/bigint integer modes for exact 64-bit application models.
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

## Artifact and provenance record

The immutable release workflow records the exact tag and commit in its preserved artifact manifest, validates every tarball before publication, derives npm publication order from workspace dependencies, and publishes only those unchanged tarballs. Final npm publication requires GitHub Actions trusted publishing/OIDC and npm provenance.

The GitHub Release is created as a draft after validated npm publication. The VSIX is attached by the release workflow after package inspection and a clean-profile VS Code host gate.
