# SQLBraid remediation status

Reference: `external SQL reference@38ea32b2a16fd79c5c6a58efbdf57446593584bd`  
Baseline: `166cd2ec6e9de7953d5ea9090513a1987993b9bb`

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

## Verification run

- `pnpm test` — 44 tests passed.
- `pnpm run build` — TypeScript emit and package-local artifact copy passed.
- Packed consumer smoke — PostgreSQL root and `/pg` imports succeeded outside the workspace; packed consumer type-check rejects `unknown` downstream properties.
- Native SQLite smoke — ordinary SELECT, comment-prefixed SELECT, and INSERT RETURNING returned rows.

## Open gates

- Real PostgreSQL/MySQL server inspectors, prepare/describe verification, and differential matrices require dedicated services and are not simulated here.
- Compiler discovery still supports direct imported tag symbols; project-wide re-export resolution and full TS virtual-program integration remain partial.
- SQL parser covers the common vertical slice, not the full frozen PostgreSQL/MySQL/SQLite grammar matrix.
- Pool lease ownership, cancellation, prepare/stream/bulk/pipeline, plan governance, migration compatibility, routing/retry, OTEL, and custom dialect conformance remain open.
- The bare JavaScript tag path remains eager by language semantics; guarded safety is advertised only on transformed build/emit output.

No release/publish/tag/force-push or live schema/data mutation was performed.
