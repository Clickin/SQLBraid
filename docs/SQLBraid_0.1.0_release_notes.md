# SQLBraid 0.1.0

Write SQL. Keep TypeScript. Skip the query-builder translation layer.

SQLBraid 0.1.0 provides:

- SQL-first TypeScript tags with safe binds and explicit row, command, and routine result contracts.
- Dynamic SQL with `@braid` directives and structural SQL fragments.
- Standard Schema result mapping without changing the declared query contract.
- Direct and pool-backed PostgreSQL (`pg`) and MySQL (`mysql2`) adapters, plus SQLite through `node:sqlite`.
- Physical-connection-safe transactions, nested savepoints, streaming, prepared queries, and execution observers.
- Metadata inspection and deterministic Row / Insert / Update code generation.
- An agent-native language server, CLI JSON inspection fallback, and a VS Code extension.
- Release evidence for Node 22.18.0, Bun 1.3.14, and Deno 2.9.3 packed artifacts.

## Current limitations

- The supported first-party database targets are PostgreSQL + `pg`, MySQL + `mysql2`, and SQLite + `node:sqlite`. Other compatible servers and drivers are custom integrations, not official support claims.
- SQLBraid uses the database/session default transaction isolation. It does not currently select or change an isolation level.
- Metadata is open-world positive evidence. Unknown tables, routines, temporary objects, CTEs, and runtime UDFs are not rejected merely because they are absent from a snapshot.
- Generated models are derived artifacts; run `sqlbraid codegen --check` in CI after metadata or configuration changes.
- The VS Code extension requires a TypeScript project with SQLBraid package/config evidence in the workspace folder.

## Artifact and provenance record

The immutable release workflow records the exact tag and commit in its preserved artifact manifest, validates every tarball before publication, derives npm publication order from workspace dependencies, and publishes only those unchanged tarballs. Final npm publication requires GitHub Actions trusted publishing/OIDC and npm provenance.

The GitHub Release is created as a draft after validated npm publication. The VSIX is attached by the release workflow after package inspection and a clean-profile VS Code host gate.
