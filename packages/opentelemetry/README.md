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

See the [OpenTelemetry integration guide](https://clickin.github.io/SQLBraid/runtime/opentelemetry/)
and [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
