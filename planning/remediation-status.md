# SQLBraid remediation status

Reference: `external SQL reference@38ea32b2a16fd79c5c6a58efbdf57446593584bd`  
Baseline: `166cd2ec6e9de7953d5ea9090513a1987993b9bb`

Implementation commit: `working-tree`

## Closed in this working tree

- Package-local `dist` exports and tarball-consumer ESM/type boundaries.
- Query-specific `Database` Row inference; unverified `sql<T>` remains `unknown`.
- Lexical directive parsing without NUL sentinels; literals and ordinary comments survive.
- Compiler-generated lazy guarded capture; disabled binds/side effects are not evaluated.
- Immutable template IR, UTF-8 limits, structural item limits, empty-list/set policy.
- Basic SQL lexer/parser full statement diagnostics, scope aliases, joins, output aliases, bind ordinals.
- SQLite comment-prefixed SELECT and `RETURNING` row detection.
- PostgreSQL `int8` decode and MySQL command-result normalization.
- Standard Schema V1 `{ value }` / `{ issues }` handling.
- Conservative semantic classification and distinct template/shape fingerprints.
- Stdio LSP initialize/document diagnostics/hover/completion transport.
- SQLite/PostgreSQL/MySQL inspector seams and offline snapshot loading.
- Prepared-query shape locking and typed streaming seam.
- tsdown package builds with explicit package entries, external dependencies, and preserved CLI/server shebangs.
- Vitest project migration covering the existing regression matrix and native SQLite tests.
- Testcontainers PostgreSQL/MySQL global setup with exact images and serial DB projects.
- W01 executor/physical-connection ownership across multiple SQLBraid wrappers, same-tick transaction ordering, nested savepoint cleanup, leaked transaction handles, root-handle misuse, and rollback cleanup errors.
- W01 poisoned physical ownership state: failed outer rollback, failed nested rollback/release cleanup, failed BEGIN, and failed COMMIT conservatively poison the shared physical resource; later work from every wrapper fails with `BRAID_CONNECTION_POISONED` while retaining application/cleanup causes.
- W03 TypeScript checker overlay: bind assignability uses `TypeChecker.isTypeAssignableTo`, `sql<T>` uses interface/alias/union/readonly/optional structural contracts, unknown inferred rows fail closed, and directive branches use real TypeScript control-flow narrowing.
- W03 hygienic lowering: TypeScript AST factory transforms use fresh identifiers, preserve lexical `this` and source expressions, short-circuit `choose`, cache selected interpolation evaluation, and attach origin-aware source-map metadata.
- Strict TypeScript checking for production, tests, Vitest, and tsdown configuration.
- Unit watch mode limited to the unit project with source aliases; database and packed consumer checks remain explicit.
- Published package Node runtime metadata (`>=22.18.0`) and packed manifest validation.
- CLI source aliases derived from SQLBraid's own checkout location; installed consumers with conflicting `packages/` trees use package resolution.
- Parity evidence revision and `test:all` packed-package release gate.

## Verification run

- `pnpm install --frozen-lockfile` — passed with pnpm 12.3.4.
- `pnpm run typecheck` — passed with TypeScript 5.9.3.
- `pnpm run build` — tsdown 0.23.0 emitted ESM JavaScript, declarations, JavaScript maps, and declaration maps for all 12 packages; publint and ATTW passed during the build.
- `pnpm test` — 60 tests passed: 58 unit tests, 1 CLI test, and 1 native SQLite W01 test.
- `pnpm run test:db:sqlite` — 1 test passed on `node:sqlite` SQLite 3.53.4; independent observer state after the rollback race was `["B"]`.
- `pnpm run test:db:postgres` — 1 test passed on `postgres:16.4-alpine` / PostgreSQL 16.4; independent observer state after the rollback race was `["B"]`.
- `pnpm run test:db:mysql` — 1 test passed on `mysql:8.4.2` / Oracle MySQL 8.4.2; independent observer state after the rollback race was `["B"]`.
- `pnpm run test:consumer` — Vitest consumer test plus packed consumer validation passed for all 12 packages, including ESM imports, type resolution, CLI execution, Node engine metadata, and conflicting-monorepo path checks.
- `pnpm run test:all` — 63 tests passed across unit, CLI, native SQLite, PostgreSQL, MySQL, and consumer projects; packed validation passed for all 12 packages.
- The pre-fix same-tick root transaction regression reproduced the race: both `BEGIN` calls reached the executor before the first transaction completed.

## Open gates

- Real PostgreSQL/MySQL server inspectors, prepare/describe verification, and differential matrices require dedicated services and are not simulated here.
- Language-server diagnostics still use the stateless per-document service; incremental project caching remains open.
- Transaction-internal concurrent operation policy is intentionally not defined/implemented: `Promise.all` inside a transaction remains dependent on the driver command queue; pool lease ownership is not implemented.
- SQL parser covers the common vertical slice, not the full frozen PostgreSQL/MySQL/SQLite grammar matrix.
- Pool lease ownership, cancellation, prepare/stream/bulk/pipeline, plan governance, migration compatibility, routing/retry, OTEL, and custom dialect conformance remain open.
- The bare JavaScript tag path remains eager by language semantics; guarded safety is advertised only on transformed build/emit output.

No release/publish/tag/force-push or live schema/data mutation was performed.
