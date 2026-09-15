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
          execution: event.execution,
          sql: event.sql,
          sqlWithLiterals: event.literalizedSql({ values: "redacted" }).text,
          binds: event.values.map(() => "[REDACTED]"),
        });
      }
    },
  }],
});
```

Events include `query:ready`, `query:result`, `query:mapped`, `query:error`, `bulk:ready`, `bulk:result`, `stream:start`, `stream:end`, and `transaction`. `query:ready` is emitted after rendering and pure binding description but before lease acquisition. It carries an immutable effective execution plan:

```ts
const {
  adapterId,
  dialectId,
  transport, // native-value-template | text-positional | text-named | typed-request
  reuse: { requested, effective, owner, capacity },
} = event.execution;
```

Events also retain derived readonly values, hints, interpolation map, declared/actual result kinds, operation IDs, duration (`durationMs`), row/command metadata, mapping completion, stream status, and transaction/savepoint phases. For calls, `query:result` reports `actualKind: "call"`, `resultSetCount`, total `rowCount`, `outputKeys`, and `hasReturnValue`; it does not log output values, cursor portal names, ResultSet objects, or protocol carrier rows by default. `event.sql` is a derived parameterized view and may be absent for a native-value-template transport.

Observers run sequentially in registration order. They can inspect events or throw to reject an operation; they cannot mutate SQL, binds, or results and do not implement retry, routing, or rewriting. A failure before DB execution prevents execution. A failure after execution cannot undo a root side effect; if it propagates inside `db.tx`, normal rollback applies. If an error observer also fails, an `AggregateError` preserves both failures.

Event containers are structurally readonly. SQLBraid does not deep-copy arbitrary
application or driver values such as `Uint8Array`; observers must not mutate a
referenced value. This is an API boundary, not a security sandbox or a promise
of deep immutability.

SQLBraid does not log bind values by default. Applications own redaction and retention policy.

For a stream, `stream:end` is emitted only after the adapter has closed,
drained, or cancelled its driver resource and the runtime has released or
discarded the physical lease. An observer may observe cleanup failures, but it
cannot make an unsafe lease reusable.

`event.literalizedSql(options?)` is lazy and cached. It reconstructs diagnostic
text directly from logical segments and parameters; it never replaces
placeholders in materialized SQL and must never be used as execution input. The
default is redacted. Options support inline/redacted values, a maximum value
length, binary summary/full output, and a custom redactor. The result reports
`complete`, `redactedParameters`, and `truncatedParameters`. Unsupported custom
objects receive a safe marker instead of accidental `toString()` execution.

Binding or typed-request construction failures are reported at stage
`"materialize"` with no driver I/O. Driver, server, and network failures remain
stage `"driver"`. Observers remain observe/fail-only and cannot rewrite the
statement, binds, results, retry policy, or routing.
