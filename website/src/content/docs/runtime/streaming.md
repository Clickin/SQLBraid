---
title: Streaming
description: Iterate rows without buffering while SQLBraid owns the physical lease.
---

Use `db.stream` for a row query:

```ts
for await (const row of db.stream(sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY id
`)) {
  await consume(row);
}
```

Rows are mapped one at a time. A pooled root stream retains its lease until iteration completes, breaks, aborts, or fails. A direct stream cannot re-enter its own physical resource; SQLBraid throws `BRAID_STREAM_SCOPE` rather than deadlocking.

Pass an `AbortSignal` when a consumer can cancel:

```ts
const controller = new AbortController();
const stream = db.stream(query, { signal: controller.signal });
controller.abort();
```

Close or exhaust streams before a transaction callback returns. Transaction streams prohibit overlapping work on their pinned connection and an abandoned iterator causes rollback. Adapters without a streaming protocol throw `BRAID_STREAM_UNSUPPORTED`; the SQLite adapter uses native statement iteration.
