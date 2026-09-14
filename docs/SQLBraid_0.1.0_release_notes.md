# SQLBraid 0.1.0 — PV18 draft release notes

Write SQL. Keep TypeScript. Skip the query-builder translation layer.

Draft release notes; this document does not claim an npm RC or stable
publication. PV18 starts from review baseline
`2119d9676b05fb2531eaf7aac1ef37741600ba40`. Final Runtime, Docs and Release
dry-run gates for profile-coherent fidelity and container changes are pending,
so no final SHA or workflow run is claimed. Historical PV16/PV17 evidence remains below as
provenance only; publication steps remain skipped.

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
- PV18 value fidelity: exact database integers and decimals are canonical
  strings; IEEE-754 approximate binary values are JavaScript numbers. Numeric
  metadata separates database semantics, raw representation, and transport
  fidelity. `decodeExactInteger`/Decimal and richer numeric types remain
  application-owned transforms.
- JSON distinguishes lossless text from parsed-object convenience, and temporal
  text from native `Date` convenience. Driver options and user-authored SQL
  casts/format expressions are explicit profiles; SQLBraid does not rewrite SQL.
- PostgreSQL, mysql2, and MariaDB export profile descriptors plus
  `typePolicyForProfile({ json, temporal })`; runtime and codegen must reuse the
  same profile. Native PostgreSQL JSON roots are `unknown` unless narrowed by
  explicit application schema; native temporal mappings are per database type.
- Driver raw values and SQLBraid canonical values are separate evidence fields.
  Exact IDs use canonical decimal strings, while `affectedRows`, `rowCount`,
  procedure status, and bulk input counts remain safe operational numbers.
- Scalar fidelity does not recursively certify arrays, domains, ranges,
  composites, Oracle objects, SQL Server `sql_variant`, vectors, or parsed JSON
  roots. Container status remains unknown/unclassified/unsupported until
  container-specific transport and codegen evidence exists.
- Ordinary `undefined` IN binds fail before acquisition with
  `BRAID_BIND_VALUE_UNSUPPORTED`; `null` remains SQL `NULL`. Database IDs and
  counts are audited separately, and exact values never silently narrow.
- SQLite INTEGER uses internal native int64 transport but exposes canonical
  strings; no public integer mode remains.
- Metadata inspection and deterministic Row / Insert / Update code generation.
- An agent-native language server, CLI JSON inspection fallback, and a VS Code extension.
- Five-dialect tooling, a driver-free unscoped `sqlbraid` CLI package, and English/Korean documentation under mutable `/dev/` and immutable `/v/<version>/` URLs.
- Historical PV16/PV17 release evidence for Node 22.18.0, Bun 1.3.14, and Deno
  2.9.3 packed artifacts; PV18 requires new exact-SHA gates.

## Current limitations

- First-party targets include Oracle Thin and SQL Server. New combinations require
  same-revision CI before an Official support claim; Bun/Deno driver subpaths
  and Oracle Thick are outside this phase.
- Oracle calls support scalar OUT/INOUT, multiple REF CURSORs and implicit results.
  Tedious supports native procedure OUTPUT, RETURN and emitted sets; direct
  CURSOR VARYING OUTPUT remains Unsupported. Oracle exact NUMBER-family results
  are strings; Tedious native exact decimal/money paths fail closed rather than
  exposing lossy JavaScript numbers.
- PostgreSQL refcursors require an existing transaction. MySQL emitted sets retain
  independent metadata; OUT/INOUT descriptors are explicitly Unsupported because
  mysql2 cannot safely identify the protocol carrier. SQLite `call()` and
  `callStream()` are not implemented. Table/set-returning functions use row queries.
- Explicit hints are honored or rejected before execution. Ordinary PostgreSQL,
  MySQL and SQLite inputs reject hints; PostgreSQL cursor outputs use the dedicated
  refcursor classification hint. Oracle rejects precision/scale facets, IN length
  and uncertified exact decimal-string input. Ordinary `undefined` IN binds fail
  before acquisition; `null` is SQL `NULL`.
- Lossless JSON text and temporal text are separate profiles from parsed JSON and
  native `Date`; user-authored `CAST`/`CONVERT`/`TO_CHAR`/`JSON_SERIALIZE`
  workarounds remain visible SQL.
- Vite integration does not make runtime/driver modules browser-compatible.
  Database execution stays server-only; SQLite exact integer output is string,
  so ordinary JSON serialization does not require bigint handling.
- SQLBraid uses the database/session default transaction isolation. It does not currently select or change an isolation level.
- Metadata is open-world positive evidence. Unknown tables, routines, temporary objects, CTEs, and runtime UDFs are not rejected merely because they are absent from a snapshot.
- Generated models are derived artifacts from a selected TypePolicy/profile; reuse
  that descriptor at runtime and in codegen, then run `sqlbraid codegen --check`
  in CI after metadata or configuration changes.
- The VS Code extension requires a TypeScript project with SQLBraid package/config evidence in the workspace folder.
- MariaDB 11.8 evidence is separate from MySQL/mysql2; mysql2 on MariaDB is
  best-effort compatibility. The current Oracle Free 23.9 provisioner does not
  provide Oracle 19c evidence.

## Historical PV16 record

The earlier PV16/PV17 implementations used SQLite integer modes and exposed some
exact integer values as `bigint`. It also recorded its own revision-specific
Runtime, Docs and Release dry-run links. Those statements are retained as
historical provenance only and are superseded by the PV18 canonical-string
contract; they do not certify the current source or PV18 support targets.

## Artifact and provenance record

The immutable release workflow records the exact tag and commit in its preserved artifact manifest, validates every tarball before publication, derives npm publication order from workspace dependencies, and publishes only those unchanged tarballs. Final npm publication requires GitHub Actions trusted publishing/OIDC and npm provenance.

The GitHub Release is created as a draft after validated npm publication. The VSIX is attached by the release workflow after package inspection and a clean-profile VS Code host gate.
