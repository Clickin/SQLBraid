---
title: OpenTelemetry integration
description: Export traces and duration metrics of SQLBraid database operations. The runtime does not depend on an SDK.
---

`@sqlbraid/opentelemetry` is an optional first-party observer integration.
Install it with the OpenTelemetry API:

```sh
npm install @sqlbraid/opentelemetry @opentelemetry/api
```

Configure the OpenTelemetry SDK, provider, exporter and reader in the
application. SQLBraid uses only the API peer:

```ts
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";
import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";

const telemetry = createOpenTelemetryObserver({
  // traces and metrics default to true
  queryText: false,
  database: {
    namespace: "billing",
    serverAddress: "db.internal",
    serverPort: 5432,
  },
});

const db = createPgPoolDatabase(pool, { observers: [telemetry] });
```

## Signals and lifecycle

The observer emits OpenTelemetry DB client spans for these operations:

- materialized row queries;
- commands;
- routine calls;
- prepared executions;
- each operation inside `db.batch()`;
- the single logical `db.bulk()` operation.

A span starts at `query:ready` or `bulk:ready`. It ends at the matching mapped,
result or error event. Queries inside a transaction keep their ordinary query
spans. 1.0.0 does not create transaction or savepoint spans.

The stable `db.client.operation.duration` histogram uses seconds and the
recommended explicit boundaries
`0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10`.

- Its attributes are only stable database identity fields.
- Failed samples also include the bounded `error.type`.
- The bulk `db.operation.batch.size` is only on spans.
- Operation IDs, fingerprints, SQL text and bind values are never metric
  attributes.

SQLBraid dialects map to `db.system.name` as follows:

| SQLBraid dialect | `db.system.name`       |
| ---------------- | ---------------------- |
| `postgres`       | `postgresql`           |
| `mysql`          | `mysql`                |
| `mariadb`        | `mariadb`              |
| `sqlite`         | `sqlite`               |
| `oracle`         | `oracle.db`            |
| `mssql`          | `microsoft.sql_server` |

An unknown dialect uses `other_sql`, unless `database.systemName` is supplied.
The span name uses the configured `database.namespace` first, then
`database.serverAddress`, then this system name. The observer does not parse SQL
to invent an operation name or a target.

## Privacy and errors

Bind values and `literalizedSql()` are never read or exported. By default,
`db.query.text` is omitted. With `queryText: true`, only the derived
parameterized SQL view of SQLBraid is exported. The placeholders stay, and the
values are still absent. Static literals that you write directly in SQL can
still be sensitive. Thus, keep query text disabled unless its retention policy
is acceptable.

Failed operations set the span status to `ERROR` and include a narrow
`error.type`. The observer does not export exception messages or stacks. It does
not invent a database response status code. Failures in provider access, span
methods or metric recording are isolated inside the observer. They cannot change
the query, transaction, lease or result behavior of SQLBraid.

## Modes and driver instrumentation

You can use the modes independently:

```ts
createOpenTelemetryObserver({ traces: true, metrics: false }); // traces only
createOpenTelemetryObserver({ traces: false, metrics: true }); // metrics only
createOpenTelemetryObserver({ traces: false, metrics: false }); // no-op
```

Spans at the SQLBraid level and driver auto-instrumentation can overlap. If you
do not want duplicate spans, select one trace source for each logical operation:

```text
SQLBraid logical tracing:
  traces: true, metrics: true
  driver DB auto-instrumentation disabled

Existing driver tracing:
  traces: false, metrics: true
  driver instrumentation remains enabled
```

SQLBraid does not claim a parent/child relationship with `pg`, `mysql2` or a
different driver without an actual integration test.

## Observer ordering and batches

Observers run one after the other, in registration order. In the supported 1.0.0
configuration, register OpenTelemetry last:

```ts
const db = createPgPoolDatabase(pool, {
  observers: [auditObserver, slowQueryObserver, createOpenTelemetryObserver()],
});
```

An observer that is registered after OpenTelemetry can reject `query:mapped` or
`bulk:result` after telemetry has already ended a successful span. The later
error event cannot open the span again. Registering OpenTelemetry first is
unsupported.

Each terminal event of `db.batch()` closes only its own operation. The observer
does not infer sibling failures from `batchId`. For a bulk operation, configure
`database.systemName` when the transport cannot supply a dialect identity. If
not, its last fallback is `other_sql`. It never uses an identity from a
previous query.

## Slow-query investigation

Use the OTel histogram to find latency. Use a plain SQLBraid observer to log the
physical execution duration. `query:result.durationMs` is the interval of the
driver execution. It is different from the boundary of the logical span and the
histogram on purpose:

```ts
const slowQueries: ExecutionObserver = {
  onEvent(event) {
    if (event.type !== "query:result" || event.durationMs < 50) return;
    console.warn("slow database operation", {
      operationId: event.operationId,
      durationMs: event.durationMs,
    });
  },
};

const db = createPgPoolDatabase(pool, {
  observers: [slowQueries, createOpenTelemetryObserver()],
});
```

The packed
[`examples/opentelemetry-slow-query`](https://github.com/Clickin/SQLBraid/tree/main/examples/opentelemetry-slow-query)
example runs a fast query and a deterministic PostgreSQL `pg_sleep(...)`. Then
it checks the warning and the trace and metric exporters that the SDK owns.

## Explicit 1.0.0 limits

This integration does not emit stream spans, transaction or savepoint spans,
pool metrics or OTel Logs. Streams include consumer iteration and cleanup. Thus,
the correct span boundary for a stream needs a separate design. Pool-level
metrics and Logs stay outside 1.0.0.
