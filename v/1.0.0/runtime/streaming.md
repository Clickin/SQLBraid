# Streaming

> Iterate rows without buffering while SQLBraid owns the physical lease and driver cleanup.

Use `db.stream` for an ordinary row-producing query:

```ts
for await (const row of db.stream(sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY id
`)) {
  await consume(row);
}
```

`db.stream()` is a real driver streaming path; it does not call `db.all()` and
yield a buffered array. `db.all()` intentionally materializes a readonly array
and uses O(row-count) application memory. Set-returning functions and
table-valued extensions are ordinary `sql.rows` queries.

## Ownership and cleanup

A pooled root stream retains its physical lease until the driver resource is
terminal. Cleanup is ordered: stop delivery, close/drain/cancel the driver
cursor/request/iterator, release or discard the lease, then emit the terminal
stream event. This applies to exhaustion, consumer errors, mapper errors,
`AbortSignal`, and `for await` early `break`.

A direct stream cannot re-enter its own physical resource; SQLBraid rejects with
`BRAID_STREAM_SCOPE` instead of deadlocking. Transaction streams stay on their
pinned connection and prohibit overlapping work. Do not return a transaction
callback while its stream is live.

```ts
const controller = new AbortController();
const stream = db.stream(query, { signal: controller.signal });
controller.abort();
```

An already-aborted signal rejects with its `reason`. An active signal requires a
physical cancellation capability. Without one, the adapter rejects before I/O
with `UnsupportedFeatureError`, feature `statement.cancel`, and
`BRAID_CANCEL_UNSUPPORTED`; stopping iteration alone is not cancellation.

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

These are driver capabilities, not dialect properties. A custom executor must
implement `QueryExecutor.stream` or fail deterministically with
`BRAID_STREAM_UNSUPPORTED`. Routine cursor streaming is not part of the
materialized routine contract; use `db.call()` for normalized, closed,
heterogeneous result sets.

DML `RETURNING`/`OUTPUT` remains materialized. Do not infer that authored
returning syntax is streamable across drivers. See the [support
matrix](/SQLBraid/v/1.0.0/reference/support.md) for verified driver capabilities.
