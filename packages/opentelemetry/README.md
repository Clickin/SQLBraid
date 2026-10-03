# @sqlbraid/opentelemetry

OpenTelemetry tracing and metrics for SQLBraid execution.

```sh
npm install @sqlbraid/opentelemetry @opentelemetry/api
```

This package adds DB client spans and the `db.client.operation.duration` metric to your execution observers.

```ts
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";
import { createPgDatabase } from "@sqlbraid/postgres/pg";

const db = createPgDatabase(client, {
  observers: [createOpenTelemetryObserver({ queryText: true })],
});
```

### Key Details

- **Privacy**: The observer never exports bind values or literalized SQL.
- **Setup**: Your application must configure an OpenTelemetry SDK and an exporter.
- **Integration**: Register this observer last in the list. This keeps the span lifecycle correct.

See the [OpenTelemetry integration guide](https://clickin.github.io/SQLBraid/runtime/opentelemetry/) and [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
