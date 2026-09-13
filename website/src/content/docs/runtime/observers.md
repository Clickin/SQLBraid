---
title: Execution observers
description: Observe SQLBraid lifecycle events without coupling the runtime to a logger.
---

Configure observers on direct or pooled factories:

```ts
const db = createPgPoolDatabase(pool, {
  observers: [{
    onEvent(event) {
      if (event.type === "query:ready") {
        logger.debug({
          sql: event.sql,
          binds: event.values.map(() => "[REDACTED]"),
        });
      }
    },
  }],
});
```

Events include `query:ready`, `query:result`, `query:mapped`, `query:error`, `stream:start`, `stream:end`, and `transaction`. They carry declared/actual result kinds, operation IDs, SQL, readonly bind metadata, duration (`durationMs`), row/command metadata, mapping completion, stream status, and transaction/savepoint phases.

Observers run sequentially in registration order. They can inspect events or throw to reject an operation; they cannot mutate SQL, binds, or results and do not implement retry, routing, or rewriting. A failure before DB execution prevents execution. A failure after execution cannot undo a root side effect; if it propagates inside `db.tx`, normal rollback applies. If an error observer also fails, an `AggregateError` preserves both failures.

SQLBraid does not log bind values by default. Applications own redaction and retention policy.
