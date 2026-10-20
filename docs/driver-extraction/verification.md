# Extraction verification record

Baseline: `a99811f82ca80c0a230975fef82ddfda5c925e71`.
Experimental branch: `experiment/driver-abstraction-extraction`.

## Before implementation

The following command sequence completed before native driver implementation changed:

```sh
pnpm install --frozen-lockfile
pnpm run build:packages
pnpm exec vitest run --project unit --project db-sqlite --project db-postgres
```

Result: 104 test files passed; 1,473 tests passed. Duration: 36.89 seconds.
PostgreSQL evidence reported server 16.4, pg 8.23.0, and Node 24.22.0.
The run included real PostgreSQL transaction, cancellation, cursor, metadata, and representation tests.
It also included native SQLite integration and the shared runtime suites.

The command capture transport timed out after 30 seconds. The process continued.
The completed test summary and database records were recovered from the capture tool's indexed output.
No failed result was treated as a pass, and the baseline suite was not rerun to obtain this record.

Built baseline PostgreSQL and SQLite outputs were copied into
`tests/performance/.builds/extraction-baseline/` before implementation changed.
That ignored directory is local benchmark input, not a published artifact.

## After extraction

| Check                                                                   | Observed result                                                                                            |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm install --lockfile-only`, then `pnpm install --frozen-lockfile`   | Passed; private workspace link added                                                                       |
| `pnpm run typecheck`                                                    | Passed, including runtime floor and test TypeScript projects                                               |
| `pnpm run build`                                                        | Passed; stable runtime floor audit passed                                                                  |
| `pnpm run docs:snippets`                                                | Passed: 221 blocks, 17 signature sketches skipped                                                          |
| `node tests/driver-extraction/runner.mjs`                               | Passed: isolated tarball installation, 14 fault tests, SQLite, PostgreSQL and Kysely examples              |
| `SQLBRAID_USE_PREBUILT_DIST=true pnpm run test:runtime` on Node 24.22.0 | Failed the gate's exact Node 22.18.0 pin before runtime assertions                                         |
| Same portability script under Node 22.18.0, Bun 1.3.14, Deno 2.9.3      | Passed for all three exact runtimes                                                                        |
| `pnpm exec vitest run`                                                  | Passed: 133 files, 1,809 tests; real PostgreSQL, MySQL, MariaDB, SQLite, Oracle and SQL Server suites      |
| `pnpm run pack:check`                                                   | Passed: 22 stable packed packages, ESM/types/exports/engines, CLI/LSP and VSIX host checks                 |
| `pnpm run dependency:ownership`                                         | Passed: 56 test imports, no forbidden root dependency                                                      |
| Packed prototype runner under Node 22.18.0                              | Passed: same 14 fault checks and SQLite/pg/Kysely examples                                                 |
| `pnpm run lint`                                                         | Passed with no warnings; deliberate test-only generator/cleanup/sequential-work exceptions are path-scoped |
| `pnpm run fmt:check`                                                    | Passed                                                                                                     |
| `pnpm run benchmark:driver-extraction`                                  | Passed: seven rounds, five workloads per engine, stage diagnostics and raw GC/heap samples                 |

The pinned runtime command was:

```sh
SQLBRAID_USE_PREBUILT_DIST=true pnpm --package=node@22.18.0 dlx node tests/scripts/runtime-portability.mjs node bun deno
```

The runtime-version failure was an environment mismatch, not a waived assertion.
The successful run used the required binary without changing support records.
These are local working-tree results, not a new exact-SHA certification or support promotion.

The packed prototype passed with pg 8.23.0 and Kysely 0.29.7 on Node 24.22.0 and Node 22.18.0.
Its PostgreSQL container uses the image pinned in `support/targets/postgres.json`.
The runner always owns the container. It does not use an environment-provided application database.
It removes its temporary consumer and database resources after execution.

The full Vitest run used PostgreSQL 16.4, MySQL 8.4.2, MariaDB 11.8.9,
Oracle Free 23.9, and SQL Server 2022-CU18 container configurations.
It passed in 221.47 seconds. No supported-driver label or stable manifest changed.

## Scope of the gates

The complete `pnpm run test:all` orchestration was not run.
Its standalone browser, D1, TanStack/webpack, and full certification-stress commands were not rerun separately.
The full Vitest suite, packed consumer/editor checks, and exact runtime portability gate did run.
Do not read those results as a release authorization.

No stable public signature, export map, dependency declaration, package version, or support target changed.
The only stable implementation edits are native materialized dispatch calls in the pg and node:sqlite adapters.
The experimental package, tests, and documentation are removable from this branch.
