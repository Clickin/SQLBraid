# Troubleshooting

> Correct the most common mistakes in setup and at runtime boundaries.

## `BRAID_RESULT_KIND`

The SQL text executed, but the declared tag did not match the actual row or command result from the adapter.

- For statements that produce rows, use `sql.rows`.
- For writes, use `sql.command`.
- If the result depends on the driver on purpose, use `db.execute` with an unknown query.
- If a wrong declaration must roll back a write, use a transaction.

## `BRAID_TX_SCOPE` or `BRAID_TX_CLOSED`

Inside `db.tx`, use the `tx` callback handle for each operation. Do not call the outer `db` from its own callback. Do not keep `tx` after the callback returns. Nested transactions require the innermost savepoint handle.

## Pool operations use the wrong connection

Do not pass a pool to a direct adapter factory. Use `createPgPoolDatabase`, `createMysql2PoolDatabase` or `createMariaDbPoolDatabase`. If many statements must share one physical connection, use `db.tx`.

## `sql.list([])` fails

An empty list has no universal SQL meaning. Guard the predicate with `@braid if`, or select a deliberate false predicate for the application.

## Codegen says stale

Inspectors produce metadata snapshots. Generated models are derived from them. After you change the metadata or the config, run `sqlbraid codegen`. Keep `sqlbraid codegen --check` in CI. Do not edit generated output manually.

## LSP has no completion

Completion gives metadata evidence only for static SQL. It does not infer inside TypeScript interpolation expressions. Missing metadata does not prove that a database object is invalid. Make sure that the project config can be found and that the metadata snapshot is valid.

## SQLite routine call or stream fails

The SQLite adapter reports `BRAID_CALL_UNSUPPORTED` for routine calls. Streaming requires the iteration protocol of the native statement. Without it, the adapter reports `BRAID_STREAM_UNSUPPORTED`.
