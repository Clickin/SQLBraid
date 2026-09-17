import assert from "node:assert/strict";
import { metrics, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Pool } from "pg";
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";
import type { ExecutionObserver } from "@sqlbraid/core";
import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";

const connectionString = process.env.SQLBRAID_POSTGRES_URL;
if (!connectionString) throw new Error("SQLBRAID_POSTGRES_URL is required for the OpenTelemetry example.");

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
if (!trace.setGlobalTracerProvider(tracerProvider)) {
  throw new Error("The OpenTelemetry tracer provider was already registered.");
}

const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter });
const meterProvider = new MeterProvider({ readers: [metricReader] });
metrics.setGlobalMeterProvider(meterProvider);

const warnings: unknown[][] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => warnings.push(args);
const slowQueries: ExecutionObserver = {
  onEvent(event) {
    if (event.type !== "query:result" || event.durationMs < 100) return;
    console.warn("slow database operation", {
      operationId: event.operationId,
      durationMs: event.durationMs,
    });
  },
};

const pool = new Pool({ connectionString });
try {
  const db = createPgPoolDatabase(pool, {
    observers: [slowQueries, createOpenTelemetryObserver()],
  });
  assert.deepEqual(await db.all(sql.rows<{ readonly value: string }>`SELECT 1 AS value`), [{ value: "1" }]);
  assert.equal(warnings.length, 0, "fast query must not trigger the slow-query warning");

  await db.all(sql.rows`SELECT pg_sleep(0.2)`);
  assert.equal(warnings.length, 1, "pg_sleep query must trigger the slow-query warning");

  await meterProvider.forceFlush();
  const spans = spanExporter.getFinishedSpans();
  assert.ok(spans.length >= 2, "SDK exporter must receive SQLBraid spans");
  assert.ok(spans.every((span) => span.attributes["db.system.name"] === "postgresql"));

  const durationMetrics = metricExporter
    .getMetrics()
    .flatMap(({ scopeMetrics }) => scopeMetrics)
    .flatMap(({ metrics: scopeMetrics }) => scopeMetrics)
    .filter((metric) => metric.descriptor.name === "db.client.operation.duration");
  assert.ok(durationMetrics.length > 0, "SDK exporter must receive the duration metric");
  assert.ok(
    durationMetrics.some((metric) =>
      metric.dataPoints.some(
        ({ value }) =>
          typeof value === "object" &&
          value !== null &&
          "count" in value &&
          typeof value.count === "number" &&
          value.count >= 2,
      ),
    ),
  );
  console.info(`PASS OpenTelemetry slow-query spans=${spans.length} duration-metrics=${durationMetrics.length}`);
} finally {
  console.warn = originalWarn;
  await pool.end();
  await Promise.all([meterProvider.shutdown(), tracerProvider.shutdown()]);
}
