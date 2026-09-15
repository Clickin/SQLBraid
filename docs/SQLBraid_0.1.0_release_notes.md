# SQLBraid 0.1.0 — release notes

Write SQL. Keep TypeScript. Skip the query-builder translation layer.

These notes describe the pre-release surface; they do not authorize npm,
GitHub, VS Code Marketplace, or Pages publication. Consult the
[versioned support records](../support/targets/) for each exact tuple's
certified implementation revision and workflow evidence. Changed revisions
require fresh exact-final Runtime, Documentation, and Release gates.

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

## Documentation and browser playground

- Scoped package READMEs provide a short introduction, installation command,
  and official documentation link; `sqlbraid` retains detailed usage examples.
- Main-branch and version-tag pushes validate documentation without deploying.
  Explicitly authorized manual runs can deploy `/latest/` and immutable
  `/v/<version>/` documentation. Missing tag archives are built from their
  tagged sources, and the version selector preserves the current locale/page
  when that page exists.
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
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

## Deliberate nonfeatures

There is no ORM graph hydration, query-builder-first language, complete SQL
semantic engine, universal application input codec, SQL/bind/result rewriting,
automatic retry/routing, universal prepared cache, or built-in audit store.
DML `RETURNING`/`OUTPUT` remains authored SQL and materialized unless the
selected adapter's evidence says otherwise. Metadata absence is not invalid SQL.

## Evidence and release discipline

Support labels belong to exact executable evidence for a database, driver,
profile, runtime, and capability tuple. Historical workflow success does not
promote the current tree or neighboring versions. Before release, run the
runtime, docs/translation, package/export, and immutable release gates on one
exact final revision. User acceptance and explicit release authorization remain
separate requirements.

The immutable release manifest records every package tarball and the VSIX
filename, SHA-256, SHA-512 integrity, extension publisher/name/version, and
bundled CLI and language-server versions. `release-evidence.json` is the
compact durable summary for the GitHub Release: it retains the source commit,
candidate hashes, support-evidence identities, staged package IDs, requested
tags, and fresh/reconciled workflow identity after Actions artifacts expire.
An RC GitHub Release is marked prerelease and uses these notes as its body;
stable publication remains a separate maintainer action.
