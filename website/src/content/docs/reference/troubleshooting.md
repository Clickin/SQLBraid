---
title: Troubleshooting
description: Resolve the most common setup and runtime boundary mistakes.
---

## `BRAID_RESULT_KIND`

The SQL text executed, but the declared tag did not match the adapter's actual row/command result. Use `sql.rows` for row-producing statements, `sql.command` for writes, or `db.execute` with an unknown query when the result is intentionally driver-dependent. Use a transaction if a wrong declaration must roll back a write.

## `BRAID_TX_SCOPE` or `BRAID_TX_CLOSED`

Use the `tx` callback handle for every operation inside `db.tx`. Do not call the outer `db` from its own callback, and do not retain `tx` after the callback returns. Nested transactions require the innermost savepoint handle.

## Pool operations use the wrong connection

Do not pass a pool to a direct adapter factory. Use `createPgPoolDatabase` or `createMysql2PoolDatabase`; use `db.tx` when multiple statements must share one physical connection.

## `sql.list([])` fails

An empty list has no universal SQL meaning. Guard the predicate with `@braid if`, or choose a deliberate false predicate for the application.

## Codegen says stale

Inspectors produce metadata snapshots; generated models are derived. Run `sqlbraid codegen` after changing metadata/config, then keep `sqlbraid codegen --check` in CI. Never edit generated output by hand.

## LSP has no completion

Completion is metadata evidence for static SQL only. It does not infer inside TypeScript interpolation expressions, and missing metadata is not proof that a database object is invalid. Check that the project config is discoverable and that the metadata snapshot validates.

## SQLite routine call or stream fails

The SQLite adapter reports `BRAID_CALL_UNSUPPORTED`. Streaming requires the native statement's iteration protocol; otherwise it reports `BRAID_STREAM_UNSUPPORTED`.
