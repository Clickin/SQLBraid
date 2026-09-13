---
title: Streaming
description: Iterate rows without buffering while SQLBraid owns the physical lease and driver cleanup.
---

Use `db.stream` for an ordinary row-producing query:

```ts
for await (const row of db.stream(sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY id
`)) {
  await consume(row);
}
```

`db.stream()` is a real driver streaming path; it does not call `db.all()` and yield a buffered array. `db.all()` intentionally materializes a readonly array and uses O(row-count) application memory. Set-returning functions and table-valued extensions are ordinary `sql.rows` queries and use the same choice.

## Ownership and cleanup

A pooled root stream retains its physical lease until the driver resource is terminal. Cleanup is ordered:

1. stop delivering rows to the consumer;
2. close, drain, or cancel the driver cursor/request/iterator;
3. only then release the lease, or discard it when the protocol is unsafe to reuse;
4. emit the terminal stream event.

This applies to exhaustion, consumer errors, mapper errors, `AbortSignal`, and `for await` early `break`. A direct stream cannot re-enter its own physical resource; SQLBraid throws `BRAID_STREAM_SCOPE` instead of deadlocking. Transaction streams stay on their pinned connection, prohibit overlapping work, and an abandoned iterator causes rollback.

Pass an `AbortSignal` when a consumer can cancel:

```ts
const controller = new AbortController();
const stream = db.stream(query, { signal: controller.signal });
controller.abort();
```

Do not return a transaction callback while its stream is live.

## First-party primitives

| Adapter | Primitive | Boundary |
| --- | --- | --- |
| PostgreSQL / `pg` | `pg-cursor` read batches | Optional peer; missing capability yields `BRAID_STREAM_UNSUPPORTED`. Normal completion closes the cursor; abort awaits physical `Client.end()` and discards the lease, including pending reads. A direct client must be replaced after abort. |
| MySQL / `mysql2` | raw prepared `Execute.stream()` | SQLBraid uses the raw connection behind `mysql2/promise`, preserves prepared/binary execution, and drains or discards before lease release. It does not downgrade to text `query()`. |
| SQLite / `node:sqlite` | `StatementSync.iterate()` | The native iterator must terminate before the database resource is reusable; no fake server cursor close is invented. |
| Oracle / `node-oracledb` Thin | `ResultSet` | The ResultSet is closed on exhaustion, break, abort, mapper failure, and close failure poisons/discards the lease. |
| SQL Server / Tedious | Request row events plus bounded pause/resume queue | The request must complete before lease release; cancellation may discard the physical connection. |

These are driver capabilities, not dialect properties. A custom executor must implement the required `QueryExecutor.stream` contract or fail deterministically with `BRAID_STREAM_UNSUPPORTED`; runtime optional-property probing is not a capability model.

Routine cursor streaming is not part of the materialized routine contract. Use `db.call()` for normalized, closed, heterogeneous result sets and this API for ordinary row streams.

See [transactions](/SQLBraid/runtime/transactions/), [observers](/SQLBraid/runtime/observers/), and [routine calls](/SQLBraid/concepts/routines/).
