---
title: Streaming
description: Iterate rows without a buffer. SQLBraid owns the physical lease and the driver cleanup.
---

Use `db.stream` for an ordinary query that produces rows:

```ts
for await (const row of db.stream(sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY id
`)) {
  await consume(row);
}
```

`db.stream()` is a real streaming path of the driver. It does not call
`db.all()` and yield a buffered array. `db.all()` materializes a readonly array
on purpose. It uses application memory in proportion to the row count.
Set-returning functions and table-valued extensions are ordinary `sql.rows`
queries.

## Ownership and cleanup

A pooled root stream keeps its physical lease until the driver resource is
terminal. Cleanup occurs in this sequence:

1. Stop the delivery of rows.
2. Close, drain or cancel the driver cursor, request or iterator.
3. Release or discard the lease.
4. Emit the terminal stream event.

This applies to exhaustion, consumer errors, mapper errors, `AbortSignal` and an
early `break` in `for await`.

A direct stream cannot re-enter its own physical resource. SQLBraid rejects with
`BRAID_STREAM_SCOPE`. It does not deadlock. Transaction streams stay on their
pinned connection and prohibit overlapping work. Do not return from a
transaction callback while its stream is live.

```ts
const controller = new AbortController();
const stream = db.stream(query, { signal: controller.signal });
controller.abort();
```

If the signal is already aborted, the operation rejects with its `reason`. An
active signal requires a physical cancellation capability. Without one, the
adapter rejects before I/O with `UnsupportedFeatureError`, the feature
`statement.cancel` and `BRAID_CANCEL_UNSUPPORTED`. To stop the iteration alone is
not cancellation.

## First-party primitives

| Adapter                     | Primitive                            | Boundary                                                                                                                                           |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`           | `pg-cursor` read batches             | Optional peer; missing capability yields `BRAID_STREAM_UNSUPPORTED`. Abort uses physical client cancellation and discards the lease when required. |
| MySQL / `mysql2`            | raw prepared `Execute.stream()`      | Preserve prepared/binary execution; drain or discard before lease release.                                                                         |
| MariaDB / Connector/Node.js | native stream iterator               | Independent MariaDB driver evidence; not inherited from `mysql2`.                                                                                  |
| SQLite / `node:sqlite`      | `StatementSync.iterate()`            | Native iterator termination is the cleanup boundary.                                                                                               |
| SQLite / `better-sqlite3`   | `Statement#iterate()`                | Synchronous and event-loop blocking; iterator return is the cleanup boundary.                                                                      |
| SQLite / libSQL             | none in the supported client surface | `BRAID_STREAM_UNSUPPORTED`; do not buffer a complete ResultSet.                                                                                    |
| SQLite / WASM               | OO1 step/reset/finalize              | Direct browser/Worker resource; one owner at a time.                                                                                               |
| Cloudflare D1               | none                                 | `BRAID_STREAM_UNSUPPORTED`; do not paginate to simulate streaming.                                                                                 |
| Oracle Thin                 | `ResultSet`                          | Close every ResultSet; close failure discards the lease.                                                                                           |
| SQL Server / Tedious        | request row events + bounded queue   | Request completion precedes lease release.                                                                                                         |
| Bun.SQL                     | none                                 | `BRAID_STREAM_UNSUPPORTED`; do not buffer a complete result.                                                                                       |

These are driver capabilities. They are not properties of the dialect. A custom
executor must implement `QueryExecutor.stream` or fail deterministically with
`BRAID_STREAM_UNSUPPORTED`. Routine cursor streaming is not part of the
materialized routine rules. For normalized, closed, heterogeneous result sets,
use `db.call()`.

DML `RETURNING`/`OUTPUT` stays materialized. Do not infer that returning syntax
in your SQL can stream on all drivers. For verified driver capabilities, read
the [support matrix](/SQLBraid/reference/support/).
