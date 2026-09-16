import assert from "node:assert/strict";
import { context, metrics, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, test } from "vitest";
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";
import type {
  BulkReadyEvent,
  BulkResultEvent,
  QueryMappedEvent,
  QueryReadyEvent,
  QueryResultEvent,
} from "@sqlbraid/core";

const contextManager = new AsyncHooksContextManager();
let provider: BasicTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;

function ready(operationId: string): QueryReadyEvent {
  return {
    type: "query:ready",
    operationId,
    sql: "SELECT 1",
    values: [],
    execution: {
      adapterId: "sdk-test",
      dialectId: "sqlite",
      transport: "text-positional",
      reuse: { requested: "auto", effective: "simple", owner: "sqlbraid" },
    },
    literalizedSql: () => "SELECT 1",
    declaredKind: "rows",
    transactionDepth: 0,
    transactionScoped: false,
  };
}

function result(operationId: string): QueryResultEvent {
  return {
    type: "query:result",
    operationId,
    durationMs: 1,
    actualKind: "rows",
    rowCount: 1,
    transactionDepth: 0,
    transactionScoped: false,
  };
}

function mapped(operationId: string): QueryMappedEvent {
  return {
    type: "query:mapped",
    operationId,
    durationMs: 1,
    rowCount: 1,
    queryMapped: false,
    executionMapped: false,
    transactionDepth: 0,
    transactionScoped: false,
  };
}

function bulkReady(operationId: string, itemCount: number): BulkReadyEvent {
  return {
    type: "bulk:ready",
    operationId,
    itemCount,
    sql: "UPDATE items SET value = ?",
    valuesAt: () => [],
    literalizedSql: () => "UPDATE items SET value = ?",
    transactionDepth: 0,
    transactionScoped: false,
  };
}

function bulkResult(operationId: string, itemCount: number): BulkResultEvent {
  return {
    type: "bulk:result",
    operationId,
    itemCount,
    executionMode: "prepared-loop",
    durationMs: 1,
    transactionDepth: 0,
    transactionScoped: false,
  };
}

function epochMilliseconds(time: readonly [number, number]): number {
  return time[0] * 1_000 + time[1] / 1_000_000;
}

afterEach(async () => {
  contextManager.disable();
  trace.disable();
  metrics.disable();
  if (provider !== undefined) await provider.shutdown();
  provider = undefined;
  if (meterProvider !== undefined) await meterProvider.shutdown();
  meterProvider = undefined;
});

test("exports a completed SQLBraid span through the modern SDK and async context manager", async () => {
  trace.disable();
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(contextManager.enable());
  const observer = createOpenTelemetryObserver({ metrics: false });

  await context.with(ROOT_CONTEXT, async () => {
    observer.onEvent(ready("sdk-operation"));
    await Promise.resolve();
    observer.onEvent(result("sdk-operation"));
    await Promise.resolve();
    observer.onEvent(mapped("sdk-operation"));
  });
  await provider.forceFlush();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.name, "sqlite");
  assert.equal(spans[0]?.kind, 2);
  assert.equal(spans[0]?.attributes["sqlbraid.operation.id"], "sdk-operation");
  assert.ok(spans[0]?.startTime);
  assert.ok(spans[0]?.endTime);
});

test("timestamps SDK spans near the captured wall clock", async () => {
  trace.disable();
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  const observer = createOpenTelemetryObserver({ metrics: false });

  const lowerBound = Date.now() - 100;
  observer.onEvent(ready("sdk-absolute-time"));
  const upperBound = Date.now() + 100;
  observer.onEvent(mapped("sdk-absolute-time"));
  await provider.forceFlush();

  const span = exporter.getFinishedSpans()[0];
  assert.ok(span);
  assert.ok(epochMilliseconds(span.startTime) >= lowerBound);
  assert.ok(epochMilliseconds(span.startTime) <= upperBound);
  assert.ok(epochMilliseconds(span.endTime) >= epochMilliseconds(span.startTime));
});

test("keeps duration bounded when monotonic clock availability changes", async () => {
  trace.disable();
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  const observer = createOpenTelemetryObserver({ metrics: false });
  const performanceObject = globalThis.performance;
  const originalNow = performanceObject.now;
  let reads = 0;
  Object.defineProperty(performanceObject, "now", {
    configurable: true,
    value: () => {
      reads += 1;
      return reads === 1 ? originalNow.call(performanceObject) : Number.NaN;
    },
  });

  try {
    observer.onEvent(ready("sdk-clock-transition"));
    await new Promise((resolve) => setTimeout(resolve, 3));
    observer.onEvent(mapped("sdk-clock-transition"));
    await provider.forceFlush();
  } finally {
    Object.defineProperty(performanceObject, "now", { configurable: true, value: originalNow });
  }

  const span = exporter.getFinishedSpans()[0];
  assert.ok(span);
  const duration = span.duration[0] + span.duration[1] / 1_000_000_000;
  assert.ok(duration >= 0);
  assert.ok(duration < 1);
});

test("exports one histogram sample with the same duration as the SDK span", async () => {
  trace.disable();
  metrics.disable();
  const spanExporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  trace.setGlobalTracerProvider(provider);
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
  meterProvider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(meterProvider);
  const observer = createOpenTelemetryObserver();

  observer.onEvent(ready("sdk-duration"));
  await new Promise((resolve) => setTimeout(resolve, 3));
  observer.onEvent(mapped("sdk-duration"));
  await provider.forceFlush();
  await meterProvider.forceFlush();

  const span = spanExporter.getFinishedSpans()[0];
  const resourceMetrics = metricExporter.getMetrics();
  const metric = resourceMetrics[0]?.scopeMetrics[0]?.metrics.find(
    (candidate) => candidate.descriptor.name === "db.client.operation.duration",
  );
  const dataPoint = metric?.dataPointType === 0 ? metric.dataPoints[0] : undefined;
  assert.ok(span);
  assert.ok(dataPoint);
  assert.equal(dataPoint.value.count, 1);
  assert.ok((dataPoint.value.sum ?? 0) >= 0);
  const spanSeconds = span.duration[0] + span.duration[1] / 1_000_000_000;
  assert.ok(Math.abs((dataPoint.value.sum ?? 0) - spanSeconds) < 0.001);
});

test("keeps varying bulk sizes in one bounded metric series", async () => {
  metrics.disable();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
  meterProvider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(meterProvider);
  const observer = createOpenTelemetryObserver({ traces: false });

  observer.onEvent(bulkReady("bulk-one", 1));
  observer.onEvent(bulkResult("bulk-one", 1));
  observer.onEvent(bulkReady("bulk-two", 200));
  observer.onEvent(bulkResult("bulk-two", 200));
  await meterProvider.forceFlush();

  const metric = metricExporter.getMetrics()[0]?.scopeMetrics[0]?.metrics.find(
    (candidate) => candidate.descriptor.name === "db.client.operation.duration",
  );
  const dataPoint = metric?.dataPointType === 0 ? metric.dataPoints[0] : undefined;
  assert.ok(dataPoint);
  assert.equal(dataPoint.value.count, 2);
  assert.equal(metric?.dataPoints.length, 1);
  assert.equal("db.operation.batch.size" in dataPoint.attributes, false);
});

test("keeps interleaved request contexts attached to their own SQLBraid spans", async () => {
  trace.disable();
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(contextManager.enable());
  const tracer = provider.getTracer("request-parent-test");
  const parentA = tracer.startSpan("request-a");
  const parentB = tracer.startSpan("request-b");
  const contextA = trace.setSpan(ROOT_CONTEXT, parentA);
  const contextB = trace.setSpan(ROOT_CONTEXT, parentB);
  const observer = createOpenTelemetryObserver({ metrics: false });

  await Promise.all([
    context.with(contextA, async () => {
      observer.onEvent(ready("request-a"));
      await new Promise((resolve) => setTimeout(resolve, 2));
      observer.onEvent(mapped("request-a"));
    }),
    context.with(contextB, async () => {
      observer.onEvent(ready("request-b"));
      await new Promise((resolve) => setTimeout(resolve, 1));
      observer.onEvent(mapped("request-b"));
    }),
  ]);
  parentA.end();
  parentB.end();
  await provider.forceFlush();

  const children = exporter.getFinishedSpans().filter((span) => span.name === "sqlite");
  assert.equal(children.length, 2);
  const childA = children.find((span) => span.attributes["sqlbraid.operation.id"] === "request-a");
  const childB = children.find((span) => span.attributes["sqlbraid.operation.id"] === "request-b");
  assert.equal(childA?.parentSpanContext?.spanId, parentA.spanContext().spanId);
  assert.equal(childB?.parentSpanContext?.spanId, parentB.spanContext().spanId);
});
