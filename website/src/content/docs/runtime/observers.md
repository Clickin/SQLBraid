---
title: Execution observers
description: Observe SQLBraid lifecycle events. The runtime does not depend on a logger.
---

Configure observers on direct or pooled factories:

```ts
const db = createPgPoolDatabase(pool, {
  observers: [
    {
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
    },
  ],
});
```

The events are `query:ready`, `query:result`, `query:mapped`, `query:error`, `bulk:ready`, `bulk:result`, `stream:start`, `stream:end` and `transaction`. `query:ready` is emitted after rendering and the pure binding description, but before lease acquisition. It carries an immutable effective execution plan:

```ts
const planObserver: ExecutionObserver = {
  onEvent(event) {
    if (event.type !== "query:ready") return;
    const {
      adapterId,
      dialectId,
      transport, // native-value-template | text-positional | text-named | typed-request
      reuse: { requested, effective, owner, capacity },
    } = event.execution;
  },
};
```

Events also keep these items: derived readonly values, hints, the interpolation map, the declared and actual result kinds, operation IDs, the duration (`durationMs`), row and command metadata, mapping completion, stream status and transaction and savepoint phases.

For calls, `query:result` reports `actualKind: "call"`, `resultSetCount`, the total `rowCount`, `outputKeys` and `hasReturnValue`. By default, it does not log output values, cursor portal names, ResultSet objects or protocol carrier rows. `event.sql` is a derived parameterized view. It can be absent for a native-value-template transport.

Observers run one after the other, in registration order. They can inspect events, or they can throw to reject an operation.

- Do not change SQL, binds or results in an observer. That breaks the observer rules.
- The API does not give retry, routing or rewriting.
- A failure before DB execution prevents the execution.
- A failure after execution cannot undo a root side effect. If it propagates inside `db.tx`, the normal rollback applies.
- If an error observer also fails, an `AggregateError` keeps both failures.

Event containers are structurally readonly. SQLBraid does not deep-copy
arbitrary application or driver values such as `Uint8Array`. Observers must not
change a referenced value. This is an API boundary. It is not a security sandbox
and not a promise of deep immutability.

SQLBraid does not log bind values by default. Applications own the redaction and retention policy.

For `db.batch()`, each item that emitted `query:ready` gets exactly one terminal
`query:mapped` or `query:error`. This includes items that were abandoned after a
preflight, acquisition, driver, release or observer failure.

- Abandoned siblings use `BRAID_BATCH_ABORTED` in the existing error payload.
  They report if their own physical execution started and completed.
- They are not sent to the driver or the mapper.
- If an error observer throws, the delivery of terminal errors continues.
- For these synthetic sibling errors, `stage` identifies the logical phase where
  the sibling was abandoned. It is not the native or observer failure stage of
  the operation that stopped the batch.

For a stream, `stream:end` is emitted only after two things: the adapter has
closed, drained or cancelled its driver resource, and the runtime has released
or discarded the physical lease. An observer can see cleanup failures. It cannot
make an unsafe lease reusable.

Each registered observer gets `stream:end` once, in registration order. This is
also true when an earlier observer throws.

- After the fanout, a single observer failure is thrown again without change.
- Many failures are aggregated in order.
- If the stream or the cleanup already failed, that original error stays the
  cause and the first aggregate entry. The observer failures follow it.
- Notification before I/O stays fail-fast.

`event.literalizedSql(options?)` is lazy and cached. It reconstructs diagnostic
text directly from the logical segments and parameters. It never replaces
placeholders in materialized SQL. Never use it as execution input.

- The default is redacted.
- The options support inline or redacted values, a maximum value length, binary
  summary or full output, and a custom redactor.
- The result reports `complete`, `redactedParameters` and `truncatedParameters`.
- Unsupported custom objects get a safe marker. This prevents an accidental
  `toString()` execution.

For MySQL and MariaDB, inline strings use non-executable `[string <JSON>]`
diagnostic markers. They do not use SQL literals, because the interpretation of
backslashes depends on the SQL mode of the session. This includes the Bun.SQL
adapters. It does not change bound execution. Diagnostic output is never
executable SQL.

Failures in binding or typed-request construction have the stage
`"materialize"`, with no driver I/O. Driver, server and network failures keep the
stage `"driver"`. Observers can only observe or fail. They cannot rewrite the
statement, binds, results, retry policy or routing.

## OpenTelemetry

Install the optional
[`@sqlbraid/opentelemetry`](https://www.npmjs.com/package/@sqlbraid/opentelemetry)
package to turn these lifecycle events into DB client spans and the stable
`db.client.operation.duration` histogram. The application owns the
OpenTelemetry SDK, the provider, the exporter and the retention policy:

```ts
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";

const db = createPgPoolDatabase(pool, {
  observers: [createOpenTelemetryObserver()],
});
```

For query-text privacy, traces-only and metrics-only modes, slow-query
investigation and coexistence with driver instrumentation, read the
[OpenTelemetry integration guide](/SQLBraid/runtime/opentelemetry/).
