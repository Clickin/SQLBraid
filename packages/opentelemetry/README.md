# @sqlbraid/opentelemetry

OpenTelemetry tracing and database duration metrics for SQLBraid execution
observers.

```sh
npm install @sqlbraid/opentelemetry @opentelemetry/api
```

The package emits DB client spans and the stable
`db.client.operation.duration` histogram. Traces and metrics are enabled by
default; query text is opt-in and remains parameterized. Bind values,
literalized SQL, and exception messages are never exported by this observer.

```ts
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";
import { createPgDatabase } from "@sqlbraid/postgres/pg";

const db = createPgDatabase(client, {
  observers: [createOpenTelemetryObserver({ queryText: true })],
});
```

Configure the OpenTelemetry SDK, provider, and exporter in the application.
`@opentelemetry/api` is a peer dependency; this package does not install an
SDK, exporter, logger, driver instrumentation, or database driver.

In the restricted release configuration, register this observer last:

```ts
observers: [auditObserver, slowQueryObserver, createOpenTelemetryObserver()],
```

The runtime invokes observers in registration order. If an observer registered
after OpenTelemetry rejects `query:mapped` or `bulk:result`, the later
`query:error` cannot reopen a span that already ended successfully;
OpenTelemetry-first ordering is therefore unsupported. Batch terminal events
close only their own operation; sibling inference is not performed. The
duration histogram carries only bounded database identity attributes (failed
samples also carry `error.type`), while `db.operation.batch.size` is a span-only
bulk attribute. Set `database.systemName` when a bulk's transport cannot supply
dialect identity; otherwise the observer uses `other_sql` rather than guessing
from another operation. Span names use configured namespace, then server
address, then the system name.

See the [OpenTelemetry integration guide](https://clickin.github.io/SQLBraid/runtime/opentelemetry/)
and [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
