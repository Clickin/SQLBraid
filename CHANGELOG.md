# Changelog

This changelog covers SQLBraid package releases. The initial 1.0.0 release is coordinated; subsequent workspace packages may version and release independently. It
summarizes durable compatibility and release information; detailed behavior
and support evidence live in the [public API audit](docs/public-api-audit.md),
[release notes](docs/SQLBraid_1.0.0_release_notes.md), and
[versioned support records](support/targets/).

## 1.0.0

- Released 1.0.0 GA: SQL-first authoring, safe value binds, explicit
  row/command/call result kinds, and Standard Schema result mapping. Stable
  contracts do not imply universal capabilities across drivers.
- Standardized physical session and transaction ownership, nested savepoints,
  expiring scoped handles, and once-only prepared rendering with logical
  shape checks before I/O.
- Standardized exact integer/decimal strings and approximate IEEE numbers;
  JSON, temporal, and container fidelity are handled by separate profiles.
- Support is based on exact database/driver/profile/runtime/capability tuples.
- Routine limits: mysql2 emitted `CALL` sets are supported, but OUT/INOUT descriptor carriers are not; SQLite `db.call` / `routine.call` is unsupported, and `callStream` remains reserved and unimplemented.
- Bun 1.3.14 MySQL/MariaDB reject both explicit `readOnly` booleans before
  I/O; omission preserves the native default. Bun PostgreSQL access modes
  remain separate. PostgreSQL and Bun PostgreSQL reject `COMMIT` outcomes
  that report rollback with `BRAID_TX_NOT_COMMITTED`.
- Retain Oracle auto-commit outside managed transactions and propagate
  Tedious savepoint rollback failures without returning uncertain resources
  as healthy.

## 1.0.0-rc.2 (historical candidate)

- Prepared a new immutable 1.0 RC candidate after the release workflow and
  VS Code publishing paths were separated. Certification and publication
  remain separate maintainer actions.
- Preserve exact node:sqlite command ROWIDs, keep Oracle auto-commit outside
  managed transactions, release pooled connections when adapter initialization
  fails, and preserve explicit transaction access-mode semantics where supported.
- Bun.SQL MySQL/MariaDB now reject both explicit `readOnly` values before I/O
  (`BRAID_TX_OPTION_UNSUPPORTED`, `transaction.read-only`): native Bun 1.3.14
  can retain read-only statement failures beyond rollback. Omitted options
  preserve session defaults; contaminated reservations are discarded after
  scope cleanup. PostgreSQL access modes and representation profiles are unchanged.
- Reject PostgreSQL and Bun PostgreSQL transactions when COMMIT reports
  ROLLBACK, and propagate Tedious savepoint rollback failures without returning
  uncertain connections as healthy.
- Require capability-driven semantic contract evidence alongside the existing
  database/version matrix; missing integration or native-boundary coverage
  blocks release certification.
- Omit unreliable optional `command.insertId` for local and protocol-unknown
  libSQL clients. Exact `RETURNING` rows, affected-row counts, transactions and
  bulk execution remain supported; rounded native ROWIDs are never advertised
  as exact IDs.
- Deliver `stream:end` to every registered observer despite earlier observer
  failures, preserving the original stream/cleanup failure and ordered observer
  failures. Pre-I/O notifications remain fail-fast.
- MySQL/MariaDB inline string diagnostics use non-executable JSON markers
  instead of SQL literals whose backslash meaning depends on session SQL mode.
  Bound execution is unchanged.
- Remove external MariaDB and Oracle connection URLs from setup diagnostics.
  Classify `sqlbraid/compiled` as an Advanced generated-code entrypoint and
  require facade export changes to update the marked API audit inventory.
- Clarify that npm manifests, pack-check stamps and prior-run recovery do not
  attest or restore a VSIX. The separate VS Code Release workflow validates
  the exact extension artifact used by Open VSX and the manual Marketplace handoff.
  Make the root SQLite quickstart runnable, default SQL Server TLS to certificate
  verification, and synchronize the Korean documentation.

## 1.0.0-rc.1 (historical candidate)

- Finalized the 1.0 RC candidate on the exact release revision, retaining the
  SQL-first API, explicit result contracts, capability-driven unsupported
  behavior, and tuple-specific support evidence.
- Release preparation remains immutable: validated package/VSIX bytes,
  dependency-ordered npm staging, provenance, and durable evidence are
  separate from human approval and publication.

The 1.0 RC tags are historical candidate identities, not claims of publication.

## 0.1.0-rc.2 (unreleased)

- RC2 hardening documents the compatibility discipline for the Application,
  SPI, serialized metadata, compiler, and tooling surfaces.
- Prepared-query calling semantics are explicit: input factories use the
  required-input form by default (or `{ input: "required" }`), while
  zero-input factories must declare `{ input: "none" }` and remain
  options-only at execution. Implementations must not infer the form from
  JavaScript `Function.length` or option-shaped input values.
- Metadata identity encoding for new first-party snapshots is now marked
  `metadata.identityEncoding: "escaped-qualified-v1"` while
  `formatVersion` remains `1`. Backward-compatible readers retain legacy dot
  identities for unmarked historical snapshots and reject unknown markers.
  Re-inspect the database when adopting escaped identities: objects lost to
  collisions in a legacy snapshot cannot be recovered from that snapshot.
- Pending and active pinned streams reject overlapping transactions before
  control I/O; queued parent operations recheck savepoint ownership before
  execution. Empty batches perform no acquisition or query lifecycle.
- Compiler and Vite lowering emit executable JS/JSX without TypeScript helper
  syntax and preserve hashbangs, directive prologues, and source locations.
- Inspectors preserve structured SQLite flags, native MySQL/MariaDB defaults,
  prototype-like catalog names, and qualified identity segments. Inspector
  imports remain usable without installing the optional metadata package.
- Owned unsupported, exactness, and result-kind failures expose consistent
  classes and codes. Abort signals retain their original reasons, including
  `null`. Observer readonly contracts do not promise a deep clone or sandbox.
- Prepared logical names are scoped to their live database handles, so
  independent session/transaction scopes may reuse a name without sharing a
  native statement identity; prepared handles still expire with their scope.
- Malformed routine results now complete the observer lifecycle with one
  terminal `query:error`, truthful execution flags, and exactly-once resource
  cleanup.
- Release candidates include validated VSIX bytes and durable evidence.
  Explicit prior-run recovery restores candidate bytes instead of repacking;
  unknown stage outcomes require reconciliation rather than another upload.
- Documentation pushes on `main` and version tags build and deploy Pages;
  manual Documentation dispatch defaults to validation-only and requires
  `deploy=true` for deployment. Private vulnerability reporting is available
  through the repository's Security tab.

## Earlier pre-release surface

Initial pre-release SQL-first surface:

- tagged SQL templates with safe value binds, bounded `@braid` directives,
  explicit result kinds, Standard Schema mapping, and structural helpers;
- direct and pooled execution with explicit sessions, transactions,
  savepoints, streams, bulk operations, observers, and capability-driven
  unsupported errors;
- prepared queries, first-party dialect and driver adapters, metadata
  inspection, deterministic code generation, CLI/LSP/Vite tooling, and the
  browser playground;
- exact-value representation policies and tuple-specific support evidence.

See the current [SQLBraid 1.0.0 release notes](docs/SQLBraid_1.0.0_release_notes.md)
for the stable surface and deliberate nonfeatures. Historical preparation does
not authorize package, GitHub, Marketplace, or Pages publication.
