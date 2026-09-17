# SQLBraid 1.0.0 — release notes

Write SQL. Keep TypeScript. Skip the query-builder translation layer.

SQLBraid 1.0.0 establishes stable SQL-first public contracts, not universal
driver capabilities. These GA notes are release preparation; they do not claim
publication or authorize npm, GitHub, VS Code Marketplace, or Pages actions.
Consult the [versioned support records](../support/targets/) for each exact tuple's
certified implementation revision and workflow evidence. Changed revisions,
including documentation-only and evidence-only commits, require fresh
exact-final Runtime, Documentation, and Release gates.

## Included surface

- SQL-first tagged templates, safe value binds, explicit `rows`, `command`,
  `call`, and `unknown` result kinds;
- bounded `@braid` directives and explicit structural fragments;
- Standard Schema query-bound and per-execution row mapping;
- direct physical executors and explicit provider/lease pool adapters;
- `session(callback)` lease pinning, nested session reuse, and `tx` transaction
  pinning/savepoints;
- `TransactionOptions` (`isolation` and `readOnly`) with capability-driven
  rejection and no silent nested option changes;
- trailing `ExecutionOptions`/`RowValidationOptions`/`StreamOptions` with
  capability-driven `AbortSignal` handling;
- prepared zero-input and input factories, one-render logical shape locking,
  kind-specific prepared operations, and no universal native prepared cache;
- native driver streaming where the adapter provides it, with cleanup before
  lease release; unsupported streaming is explicit rather than buffered;
- heterogeneous routine `output`, ordered `resultSets`, and optional
  `returnValue`, plus explicit OUT/INOUT/cursor boundaries;
- homogeneous command-only bulk with complete pre-I/O shape validation and
  driver-reported execution mode;
- observe/fail-only execution observers with lazy redacted diagnostics;
- PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL Server dialect roots,
  with driver subpaths and capability-specific behavior;
- one Bun SQL adapter family with user-selected `postgres`, `mysql`, `mariadb`,
  or `sqlite` dialect; no connection-based dialect auto-detection;
- first-party Deno use of existing driver adapters where their public APIs work,
  without inventing a Deno dialect;
- database-fact metadata, deterministic code generation, CLI JSON inspection,
  standard stdio LSP, Vite lowering, and a thin editor client;
- canonical exact numeric output (exact integer/decimal → `string`, approximate
  IEEE binary → `number`) and explicit JSON/temporal/container evidence boundaries.

## Correctness retained for GA

- PostgreSQL and Bun PostgreSQL reject with `BRAID_TX_NOT_COMMITTED` when a
  server reports that `COMMIT` rolled back; a successful callback alone is not
  transaction success.
- Oracle keeps auto-commit outside managed transactions. Tedious propagates
  savepoint rollback failures instead of returning uncertain connections as
  healthy, and failed pooled adapter initialization releases its lease.
- node:sqlite preserves exact command ROWIDs. Local and protocol-unknown
  libSQL clients omit unreliable optional `command.insertId`; exact
  `RETURNING` rows, affected-row counts, transactions, and bulk remain supported.
- Stream completion reaches every observer even if an earlier observer
  fails, preserving original execution/cleanup errors and observer failures.

## Documentation and browser playground

- Scoped package READMEs provide a short introduction, installation command,
  and official documentation link; `sqlbraid` retains detailed usage examples.
- Main-branch and version-tag pushes build and deploy documentation through the
  Pages workflow. Manual dispatch can validate without deployment unless
  `deploy=true` is selected. Missing tag archives are built from their tagged
  sources, and the version selector preserves the current locale/page when that
  page exists.
- The browser playground accepts editable SQL against a seeded, disposable
  SQLite WASM database. It exposes the table schema, actual query results and
  errors, and database reset. Results are capped at 1,000 displayed rows;
  a ten-second worker timeout resets the database without blocking the page.

## Unsupported behavior is visible

Adapters use `UnsupportedFeatureError(feature, code, message, options?)` with a
`BRAID_*` code. Typical codes include `BRAID_STREAM_UNSUPPORTED`,
`BRAID_CALL_UNSUPPORTED`, `BRAID_CANCEL_UNSUPPORTED`,
`BRAID_TX_OPTION_UNSUPPORTED`, and `BRAID_BIND_HINT_UNSUPPORTED`. A missing
capability never becomes a buffered fake, hidden transaction, guessed routine
carrier, or silently ignored hint. The complete capability identifiers are:

```text
sql.native-transparency           sql.generated-structure
result.rows                       result.command
result.multiple-sets              result.standard-schema
numeric.exact-integer             numeric.exact-decimal
numeric.approximate-float         numeric.approximate-special
numeric.bind-exact                numeric.aggregate
numeric.command-metadata          numeric.special-values
numeric.scale-greater-than-precision
numeric.negative-scale
data.json-parsed                  data.json-lossless-text
data.sql-variant                  data.oracle-object
data.oracle-collection            data.vector
data.binary                       data.uuid
data.temporal-native              data.temporal-lossless
data.timezone
metadata.command-safe
dml.insert-returning              dml.update-returning
dml.delete-returning              dml.merge-returning
dml.upsert-returning
session.pinned
statement.prepare                statement.cancel
statement.stream                 statement.bulk
execution.bulk-fidelity
transaction                      transaction.savepoint
transaction.read-only
transaction.isolation.read-uncommitted
transaction.isolation.read-committed
transaction.isolation.repeatable-read
transaction.isolation.serializable
routine.call                     routine.out
routine.inout                    routine.result-sets
routine.out-cursor               routine.return-value
metadata.identity                metadata.generated
metadata.routines                metadata.types
```

### Routine and runtime limits

- mysql2 supports emitted `CALL` result sets, but OUT/INOUT descriptor
  carriers remain unsupported; SQLBraid does not guess a final carrier set or
  rewrite calls through session variables.
- SQLite adapters do not support `db.call` / `routine.call`. This is an API
  capability limit, not a ban on authored SQLite SQL or SQL functions.
- PostgreSQL refcursors require an existing `db.tx`. Direct SQL Server cursor
  OUT is unsupported. `callStream` is reserved and unimplemented; it is not
  an available method.
- Bun 1.3.14 MySQL/MariaDB reject both explicit `readOnly: true` and
  `readOnly: false` before I/O with `BRAID_TX_OPTION_UNSUPPORTED`
  (`transaction.read-only`). Omitting the option preserves the native session
  default, not a forced read-write mode. Bun PostgreSQL access modes differ
  and are not restricted by this MySQL/MariaDB limit.
- Bun 1.3.14 active cancellation, streaming, and routine carriers remain
  unsupported. MySQL/MariaDB empty rows and zero-count commands can be
  ambiguous after execution; the adapter rejects with
  `BRAID_RESULT_KIND_AMBIGUOUS`, which cannot undo side effects.
- libSQL does not support pinned ordinary sessions or streaming, and does not
  buffer to emulate a stream. D1's managed SQLite version remains unreported.
  Neither limitation is promoted to support by the GA label.

## Deliberate nonfeatures

There is no ORM graph hydration, query-builder-first language, complete SQL
semantic engine, universal application input codec, SQL/bind/result rewriting,
automatic retry/routing, universal prepared cache, or built-in audit store.
DML `RETURNING`/`OUTPUT` remains authored SQL and materialized unless the
selected adapter's evidence says otherwise. Metadata absence is not invalid SQL.

## GA evidence and release discipline

Support labels belong to exact executable evidence for a database, driver,
profile, runtime, and capability tuple. Historical workflow success does not
promote the current tree or neighboring versions. Semantic integration and
native-driver fault evidence complement, not replace, that exact-tuple matrix.
Before release, run the runtime, docs/translation, package/export, and immutable
release gates on one exact final revision. User acceptance and explicit release
authorization remain separate requirements; no new certification is claimed
by these notes.

The immutable npm release manifest records package tarball filenames, SHA-256,
and SHA-512 integrity. Its pack-check stamp and prior-run recovery attest and
restore npm candidates only, not a VSIX. `release-evidence.json` is the compact
durable summary for the GitHub Release: it retains the source commit, npm
candidate hashes, support-evidence identities, staged package IDs, requested
tags, and fresh/reconciled workflow identity after Actions artifacts expire.
The independently dispatched VS Code Release workflow validates its own VSIX
identity, bundled CLI/language-server versions, and exact extension artifact;
Open VSX and the manual Marketplace handoff use those validated bytes.

Stable 1.0.0 staging, if separately authorized later, uses temporary
`release-1.0.0`, not `next` or `latest`. Staging is not public publication:
human dependency-ordered approval is required after OIDC staging, followed by
exact integrity, provenance, and tag verification before manual `latest`
promotion. A stable GitHub Release is not marked prerelease; its approval-pending
draft does not authorize publication. This preparation performs no staging,
approval, tag movement, or publication. The
[release-readiness policy](SQLBraid_release_readiness.md) governs these separate
maintainer actions and immutable candidate recovery.
