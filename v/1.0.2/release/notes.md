# 1.0.0 release notes

> The SQLBraid 1.0.0 GA interfaces and their capability and evidence boundaries.

This is the SQLBraid 1.0.0 GA documentation. GA makes the public interfaces
stable. It does not make each capability available on each driver.

The [runtime and driver support matrix](/SQLBraid/v/1.0.2/reference/support.md) lists
the supported combinations of database, driver, profile, runtime and capability.

## What 1.0.0 includes

- SQL-first templates, safe value binds and the explicit result kinds `rows`,
  `command`, `call` and `unknown`;
- bounded `@braid` directives and explicit structural fragments;
- Standard Schema row mapping that is bound to the query or set for each execution;
- direct physical executors and explicit ownership of pools through providers and leases;
- lease pinning with `db.session(callback)`, reuse in nested sessions, and `db.tx`;
- fixed transaction isolation literals and `readOnly`, with separate errors for
  malformed, unsupported and nested options;
- trailing execution, row and stream options, and `AbortSignal` cancellation
  that depends on capabilities;
- prepared factories with input and without input, with logical shape locks that
  render once;
- native driver streams with cleanup before the lease release, or an explicit
  `BRAID_STREAM_UNSUPPORTED`;
- materialized routine `output`, ordered heterogeneous `resultSets`, an optional
  `returnValue`, and explicit boundaries for OUT, INOUT and cursors;
- homogeneous bulk for commands only, with validation before I/O and a report of
  the actual execution mode;
- execution observers that can only observe or fail, and lazy diagnostic
  literalization;
- optional DB client spans and stable duration metrics from
  `@sqlbraid/opentelemetry`. The application owns the SDK and the exporter;
- PostgreSQL, MySQL, MariaDB, SQLite, Oracle and SQL Server dialect roots with
  driver subpaths;
- one Bun SQL adapter family. The user must select the PostgreSQL, MySQL,
  MariaDB or SQLite dialect. There is no detection from the connection;
- the existing first-party driver adapters in Deno, where their public API
  works, without a Deno-specific dialect;
- metadata, codegen, CLI JSON inspection, standard LSP, Vite lowering and thin
  editor integration;
- exact database integers and decimals as canonical strings, and approximate
  IEEE values as numbers, with independent JSON, temporal and container profiles.

## Explicit unsupported behavior

`UnsupportedFeatureError(feature, code, message, options?)` carries stable
`BRAID_*` codes. Active cancellation without physical driver support uses
`BRAID_CANCEL_UNSUPPORTED`. Already-aborted signals keep their `reason`. Missing
stream, routine, output, hint, transaction or bulk support fails explicitly.
SQLBraid does not buffer, guess carriers, ignore hints or create hidden
transactions.

- MySQL/mysql2 supports emitted heterogeneous `CALL` result sets. OUT and INOUT
  descriptors stay unsupported, because their carrier cannot be identified
  reliably.
- SQLite `db.call()` / `routine.call` is unsupported. This does not restrict
  ordinary SQLite SQL functions or extensions.
- `callStream()` is reserved and not implemented. It is not a 1.0.0 API that you
  can call.

Read the [capability limitations](/SQLBraid/v/1.0.2/release/limitations.md). They include
this item: Bun 1.3.14 MySQL and MariaDB reject both explicit `readOnly` boolean
values. If you omit the option, the native session default stays. Bun.SQL
PostgreSQL is different.

The canonical capability keys are:

```text
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

## Deliberate nonfeatures

SQLBraid is not one of these things:

- an ORM;
- a complete SQL semantic compiler;
- a universal input codec;
- an interceptor that rewrites SQL or results;
- an automatic retry or routing layer;
- an audit store;
- a universal native prepared cache.

It does not infer the result models of arbitrary SELECT and JOIN statements. It
does not hydrate object graphs. DML `RETURNING`/`OUTPUT` is materialized, unless
the exact evidence of the selected adapter says otherwise. Metadata is
open-world positive evidence.

Support and release artifacts are validated before publication.
