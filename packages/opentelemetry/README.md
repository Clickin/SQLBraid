# @sqlbraid/opentelemetry

OpenTelemetry tracing and metrics for SQLBraid execution.

```sh
npm install @sqlbraid/opentelemetry @opentelemetry/api
```

Adds DB client spans and the `db.client.operation.duration` metric to your execution observers.

```ts
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";
import { createPgDatabase } from "@sqlbraid/postgres/pg";

const db = createPgDatabase(client, {
  observers: [createOpenTelemetryObserver({ queryText: true })],
});
```

### Key Details
- **Privacy**: Bind values and literalized SQL are never exported.
- **Setup**: Requires a configured OpenTelemetry SDK and exporter in your application.
- **Integration**: Register this observer last in your list to ensure correct span lifecycle.

See the [OpenTelemetry integration guide](https://clickin.github.io/SQLBraid/runtime/opentelemetry/) and [SQLBraid documentation](https://clickin.github.io/SQLBraid/).

