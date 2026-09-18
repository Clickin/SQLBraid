---
title: 1.0.0 release notes
description: The SQLBraid 1.0.0 GA contract and its capability and evidence boundaries.
---

This is SQLBraid 1.0.0 GA documentation. GA stabilizes the public contracts, not
every capability on every driver.

The [runtime and driver support matrix](/SQLBraid/reference/support/) lists
the supported database, driver, profile, runtime, and capability combinations.

## Included contract

- SQL-first templates, safe value binds, explicit `rows`, `command`, `call`,
  and `unknown` result kinds;
- bounded `@braid` directives and explicit structural fragments;
- Standard Schema query-bound and per-execution row mapping;
- direct physical executors and explicit provider/lease pool ownership;
- `db.session(callback)` lease pinning, nested session reuse, and `db.tx`;
- fixed transaction isolation literals plus `readOnly`, with malformed,
  unsupported, and nested option errors distinguished;
- trailing execution/row/stream options and capability-driven `AbortSignal`
  cancellation;
- zero-input and input prepared factories with one-render logical shape locks;
- native driver streams with cleanup before lease release, or explicit
  `BRAID_STREAM_UNSUPPORTED`;
- materialized routine `output`, ordered heterogeneous `resultSets`, optional
  `returnValue`, and explicit OUT/INOUT/cursor boundaries;
- homogeneous command-only bulk with pre-I/O validation and actual execution
  mode reporting;
- observe/fail-only execution observers and lazy diagnostic literalization;
- optional `@sqlbraid/opentelemetry` DB client spans and stable duration metrics,
  with SDK/exporter ownership kept in the application;
- PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL Server dialect roots with
  driver subpaths;
- Bun SQL's one adapter family with required user-selected PostgreSQL, MySQL,
  MariaDB, or SQLite dialect; no connection-based auto-detection;
- existing first-party driver adapters usable from Deno where their public API
  works, without a Deno-specific dialect;
- metadata, codegen, CLI JSON inspection, standard LSP, Vite lowering, and
  thin editor integration;
- exact database integers/decimals as canonical strings and approximate IEEE
  values as numbers, with independent JSON/temporal/container profiles.

## Explicit unsupported behavior

`UnsupportedFeatureError(feature, code, message, options?)` carries stable
`BRAID_*` codes. Active cancellation without physical driver support uses
`BRAID_CANCEL_UNSUPPORTED`; already-aborted signals preserve their `reason`.
Missing stream, routine, output, hint, transaction, or bulk support fails
explicitly instead of buffering, guessing carriers, ignoring hints, or creating
hidden transactions.

MySQL/mysql2 supports emitted heterogeneous `CALL` result sets, but OUT/INOUT
descriptors remain unsupported because their carrier cannot be identified
reliably. SQLite `db.call()` / `routine.call` is unsupported; this does not
restrict ordinary SQLite SQL functions or extensions. `callStream()` is
reserved and unimplemented, not a callable 1.0.0 API. See the
[capability limitations](/SQLBraid/release/limitations/), including Bun 1.3.14
MySQL/MariaDB rejecting both explicit `readOnly` boolean values while omission
preserves the native session default; Bun.SQL PostgreSQL differs.

Canonical capability keys are:

```text
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

## Deliberate nonfeatures

SQLBraid is not an ORM, complete SQL semantic compiler, universal input codec,
SQL/result rewriting interceptor, automatic retry/router, audit store, or
universal native prepared cache. It does not infer arbitrary SELECT/JOIN result
models or hydrate object graphs. DML `RETURNING`/`OUTPUT` is materialized unless
the selected adapter's exact evidence says otherwise. Metadata is open-world
positive evidence.

Support and release artifacts are validated before publication.
