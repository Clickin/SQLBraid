# OpenTelemetry integration

> Export SQLBraid database operation traces and duration metrics without coupling the runtime to an SDK.

`@sqlbraid/opentelemetry` is an optional first-party observer integration.
Install it with the OpenTelemetry API:

```sh
npm install @sqlbraid/opentelemetry @opentelemetry/api
```

Configure the OpenTelemetry SDK, provider, exporter, and reader in the
application. SQLBraid only uses the API peer:

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

The observer emits OpenTelemetry DB client spans for materialized row queries,
commands, routine calls, prepared executions, each constituent `db.batch()`
operation, and the single logical `db.bulk()` operation. A span starts at
`query:ready` or `bulk:ready` and ends at the matching mapped/result or error
event. Queries inside a transaction retain their ordinary query spans; 1.0.0
does not create transaction or savepoint spans.

The stable `db.client.operation.duration` histogram uses seconds and the
recommended explicit boundaries
`0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10`. Its attributes are stable
database identity fields only. Failed samples also include the bounded
`error.type`; bulk `db.operation.batch.size` is span-only. Operation IDs,
fingerprints, SQL text, and bind values are never metric attributes.

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
The span name uses configured `database.namespace`, then
`database.serverAddress`, then this system name. It does not parse SQL to
invent an operation name or target.

## Privacy and errors

Bind values and `literalizedSql()` are never read or exported. By default,
`db.query.text` is omitted. With `queryText: true`, only SQLBraid's derived
parameterized SQL view is exported; placeholders remain and values are still
absent. Static literals authored directly in SQL can still be sensitive, so
keep query text disabled unless its retention policy is acceptable.

Failed operations set span status to `ERROR` and include a narrow
`error.type`. The observer does not export exception messages or stacks and
does not fabricate a database response status code. Failures in provider
access, span methods, or metric recording are isolated inside the observer and
cannot change SQLBraid query, transaction, lease, or result behavior.

## Modes and driver instrumentation

Use the modes independently:

```ts
createOpenTelemetryObserver({ traces: true, metrics: false }); // traces only
createOpenTelemetryObserver({ traces: false, metrics: true }); // metrics only
createOpenTelemetryObserver({ traces: false, metrics: false }); // no-op
```

SQLBraid-level spans and driver auto-instrumentation can overlap. Choose one
trace source for a logical operation when duplicate spans are undesirable:

```text
SQLBraid logical tracing:
  traces: true, metrics: true
  driver DB auto-instrumentation disabled

Existing driver tracing:
  traces: false, metrics: true
  driver instrumentation remains enabled
```

SQLBraid does not claim a parent/child relationship with `pg`, `mysql2`, or
another driver without an actual integration test.

## Observer ordering and batches

Observers run sequentially in registration order. In the supported 1.0.0
configuration, register OpenTelemetry last:

```ts
const db = createPgPoolDatabase(pool, {
  observers: [auditObserver, slowQueryObserver, createOpenTelemetryObserver()],
});
```

An observer registered after OpenTelemetry can reject `query:mapped` or
`bulk:result` after telemetry has already ended a successful span; the later
error event cannot reopen it. OpenTelemetry-first ordering is unsupported.
Each `db.batch()` terminal event closes only its own operation. The observer
does not infer sibling failures from `batchId`. For a bulk operation, configure
`database.systemName` when the transport cannot supply a dialect identity;
otherwise its final fallback is `other_sql`, never an identity inferred from a
previous query.

## Slow-query investigation

Use the OTel histogram to detect latency and a plain SQLBraid observer to log
the physical execution duration. `query:result.durationMs` is the driver
execution interval; it is intentionally different from the logical span and
histogram boundary:

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
example runs a fast query and deterministic PostgreSQL `pg_sleep(...)`, then
checks both the warning and SDK-owned trace/metric exporters.

## Explicit 1.0.0 limits

This integration does not emit stream spans, transaction/savepoint spans, pool
metrics, or OTel Logs. Streams include consumer iteration and cleanup, so their
correct span boundary needs a separate design. Pool-level metrics and Logs
remain outside 1.0.0.
