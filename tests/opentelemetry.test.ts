import assert from "node:assert/strict";
import {
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Histogram,
  type Meter,
  type MetricOptions,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { beforeEach, afterEach, test } from "vitest";
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";
import type {
  BulkReadyEvent,
  BulkResultEvent,
  Database,
  DriverRoutineResult,
  ExecutionEvent,
  QueryErrorEvent,
  QueryMappedEvent,
  QueryExecutor,
  QueryReadyEvent,
  QueryResultEvent,
  RenderedBulk,
  RenderedStatement,
  StatementBindingContext,
  StatementBindingAdapter,
} from "@sqlbraid/core";
import { createBulkBindingDescription, createStatementBindingDescription } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";

const secret = "conspicuous-bind-never-export";

interface RecordingSpan {
  readonly name: string;
  readonly kind: SpanKind | undefined;
  readonly attributes: Record<string, unknown>;
  readonly statuses: { readonly code: SpanStatusCode }[];
  readonly exceptionCalls: unknown[];
  startTime?: readonly [number, number];
  endTime?: readonly [number, number];
  endCount: number;
}

interface Recording {
  readonly spans: RecordingSpan[];
  readonly measurements: { readonly value: number; readonly attributes: Record<string, unknown> }[];
  histogramName?: string;
  histogramOptions?: MetricOptions;
  throwOnTracerProviderAccess: boolean;
  throwOnSpanAccess: boolean;
  throwOnSpanMutation: boolean;
  throwOnMetricAccess: boolean;
  throwOnMetricRecord: boolean;
}

let recording: Recording;

function spanFor(
  name: string,
  kind: SpanKind | undefined,
  attributes?: Record<string, unknown>,
  startTime?: readonly [number, number],
): Span {
  const state: RecordingSpan = {
    name,
    kind,
    attributes: {},
    statuses: [],
    exceptionCalls: [],
    startTime,
    endCount: 0,
  };
  Object.assign(state.attributes, attributes);
  recording.spans.push(state);
  const span = {
    spanContext: () => ({
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      traceFlags: 1,
      isRemote: false,
    }),
    setAttribute(key: string, value: unknown) {
      if (recording.throwOnSpanMutation) throw new Error("telemetry span mutation failed");
      state.attributes[key] = value;
      return span;
    },
    setAttributes(attributes: Record<string, unknown>) {
      if (recording.throwOnSpanMutation) throw new Error("telemetry span mutation failed");
      Object.assign(state.attributes, attributes);
      return span;
    },
    addEvent() { return span; },
    addLink() { return span; },
    addLinks() { return span; },
    setStatus(status: { readonly code: SpanStatusCode }) {
      if (recording.throwOnSpanMutation) throw new Error("telemetry span mutation failed");
      state.statuses.push(status);
      return span;
    },
    updateName() { return span; },
    end(endTime?: readonly [number, number]) {
      if (recording.throwOnSpanMutation) throw new Error("telemetry span mutation failed");
      state.endTime = endTime;
      state.endCount += 1;
    },
    isRecording: () => true,
    recordException(exception: unknown) {
      state.exceptionCalls.push(exception);
      return span;
    },
  } as unknown as Span;
  return span;
}

function installProviders(): void {
  const tracer: Tracer = {
    startSpan(
      name: string,
      options?: {
        readonly kind?: SpanKind;
        readonly attributes?: Record<string, unknown>;
        readonly startTime?: readonly [number, number];
      },
    ) {
      if (recording.throwOnSpanAccess) throw new Error("telemetry tracer unavailable");
      return spanFor(name, options?.kind, options?.attributes, options?.startTime);
    },
    startActiveSpan() {
      throw new Error("unused");
    },
  } as unknown as Tracer;
  const histogram: Histogram = {
    record(value: number, attributes?: Attributes) {
      if (recording.throwOnMetricRecord) throw new Error("telemetry metric failed");
      recording.measurements.push({ value, attributes: { ...(attributes ?? {}) } });
    },
  } as unknown as Histogram;
  const meter: Meter = {
    createHistogram(name: string, options?: MetricOptions) {
      if (recording.throwOnMetricAccess) throw new Error("telemetry meter unavailable");
      recording.histogramName = name;
      recording.histogramOptions = options;
      return histogram;
    },
  } as unknown as Meter;
  trace.setGlobalTracerProvider({
    getTracer: () => {
      if (recording.throwOnTracerProviderAccess) throw new Error("telemetry tracer provider unavailable");
      return tracer;
    },
  });
  metrics.setGlobalMeterProvider({ getMeter: () => meter });
}

function ready(
  operationId: string,
  overrides: Partial<QueryReadyEvent> = {},
): QueryReadyEvent {
  return {
    type: "query:ready",
    operationId,
    sql: "SELECT $1",
    values: [secret],
    execution: {
      adapterId: "pg",
      dialectId: "postgres",
      transport: "text-positional",
      reuse: { requested: "auto", effective: "simple", owner: "sqlbraid" },
    },
    literalizedSql: () => {
      throw new Error("literalized SQL must not be read");
    },
    declaredKind: "rows",
    fingerprint: "shape-fingerprint",
    transactionDepth: 0,
    transactionScoped: false,
    ...overrides,
  };
}

function result(operationId: string, actualKind: QueryResultEvent["actualKind"] = "rows"): QueryResultEvent {
  return {
    type: "query:result",
    operationId,
    durationMs: 2,
    actualKind,
    rowCount: actualKind === "rows" ? 1 : undefined,
    transactionDepth: 0,
    transactionScoped: false,
  };
}

function mapped(operationId: string): QueryMappedEvent {
  return {
    type: "query:mapped",
    operationId,
    durationMs: 0,
    rowCount: 1,
    queryMapped: false,
    executionMapped: false,
    transactionDepth: 0,
    transactionScoped: false,
  };
}

function failure(operationId: string, overrides: Partial<QueryErrorEvent> = {}): QueryErrorEvent {
  return {
    type: "query:error",
    operationId,
    error: { code: "BRAID_RESULT_KIND", message: secret },
    stage: "driver",
    executionStarted: true,
    executionCompleted: false,
    durationMs: 2,
    transactionDepth: 0,
    transactionScoped: false,
    ...overrides,
  };
}

function bulkReady(operationId: string): BulkReadyEvent {
  return {
    type: "bulk:ready",
    operationId,
    itemCount: 2,
    transactionDepth: 0,
    transactionScoped: false,
    sql: "UPDATE users SET active = $1",
    valuesAt: () => [secret],
    literalizedSql: () => {
      throw new Error("bulk literalized SQL must not be read");
    },
  };
}

function bulkResult(operationId: string): BulkResultEvent {
  return {
    type: "bulk:result",
    operationId,
    itemCount: 2,
    executionMode: "native-bulk",
    durationMs: 2,
    transactionDepth: 0,
    transactionScoped: false,
  };
}

beforeEach(() => {
  trace.disable();
  metrics.disable();
  recording = {
    spans: [],
    measurements: [],
    throwOnTracerProviderAccess: false,
    throwOnSpanAccess: false,
    throwOnSpanMutation: false,
    throwOnMetricAccess: false,
    throwOnMetricRecord: false,
  };
  installProviders();
});

afterEach(() => {
  trace.disable();
  metrics.disable();
});

test("maps query lifecycle to a client span and one stable duration measurement", () => {
  const observer = createOpenTelemetryObserver();
  observer.onEvent(ready("query-1", { preparedName: "users-by-id" }));
  observer.onEvent(result("query-1"));
  observer.onEvent(mapped("query-1"));

  assert.equal(recording.spans.length, 1);
  assert.equal(recording.spans[0].name, "postgresql");
  assert.equal(recording.spans[0].kind, SpanKind.CLIENT);
  assert.equal(recording.spans[0].endCount, 1);
  assert.equal(recording.spans[0].attributes["db.system.name"], "postgresql");
  assert.equal(recording.spans[0].attributes["sqlbraid.operation.id"], "query-1");
  assert.equal(recording.spans[0].attributes["sqlbraid.query.fingerprint"], "shape-fingerprint");
  assert.equal(recording.spans[0].attributes["sqlbraid.prepared.name"], "users-by-id");
  assert.equal(recording.spans[0].attributes["sqlbraid.result.kind"], "rows");
  assert.equal(recording.measurements.length, 1);
  assert.equal(recording.histogramName, "db.client.operation.duration");
  assert.equal(recording.histogramOptions?.unit, "s");
  assert.deepEqual(recording.histogramOptions?.advice?.explicitBucketBoundaries, [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]);
  assert.equal(recording.measurements[0].attributes["db.system.name"], "postgresql");
  assert.equal("sqlbraid.operation.id" in recording.measurements[0].attributes, false);
  assert.equal("sqlbraid.query.fingerprint" in recording.measurements[0].attributes, false);
  assert.ok(recording.measurements[0].value >= 0);
});

test("closes prepared stream operations exactly once", () => {
  const observer = createOpenTelemetryObserver();
  observer.onEvent(ready("prepared-stream", { preparedName: "users" }));
  observer.onEvent({
    ...ready("prepared-stream", { preparedName: "users" }),
    type: "stream:start",
    declaredKind: "rows",
  });
  observer.onEvent({
    type: "stream:end",
    operationId: "prepared-stream",
    status: "completed",
    durationMs: 2,
    rowCount: 1,
    transactionDepth: 0,
    transactionScoped: false,
  });
  observer.onEvent({
    type: "stream:end",
    operationId: "prepared-stream",
    status: "error",
    durationMs: 3,
    rowCount: 1,
    error: new Error("late stream event"),
    transactionDepth: 0,
    transactionScoped: false,
  });

  assert.equal(recording.spans.length, 1);
  assert.equal(recording.spans[0]?.endCount, 1);
  assert.equal(recording.measurements.length, 1);
});

test("does not double-finish a prepared stream after a terminal query error", () => {
  const observer = createOpenTelemetryObserver();
  observer.onEvent(ready("prepared-stream-error"));
  observer.onEvent({
    ...ready("prepared-stream-error"),
    type: "stream:start",
    declaredKind: "rows",
  });
  const error = new Error("stream failed");
  observer.onEvent({
    type: "query:error",
    operationId: "prepared-stream-error",
    error,
    stage: "stream",
    executionStarted: true,
    executionCompleted: false,
    durationMs: 2,
    transactionDepth: 0,
    transactionScoped: false,
  });
  observer.onEvent({
    type: "stream:end",
    operationId: "prepared-stream-error",
    status: "error",
    durationMs: 3,
    rowCount: 1,
    error,
    transactionDepth: 0,
    transactionScoped: false,
  });

  assert.equal(recording.spans.length, 1);
  assert.equal(recording.spans[0]?.endCount, 1);
  assert.deepEqual(recording.spans[0]?.statuses, [{ code: SpanStatusCode.ERROR }]);
  assert.equal(recording.measurements.length, 1);
});

test("maps every SQLBraid dialect to a low-cardinality database identity", () => {
  const observer = createOpenTelemetryObserver({
    database: {
      namespace: "billing",
      serverAddress: "db.internal",
      serverPort: 5432,
    },
  });
  const dialects = [
    ["postgres", "postgresql"],
    ["mysql", "mysql"],
    ["mariadb", "mariadb"],
    ["sqlite", "sqlite"],
    ["oracle", "oracle.db"],
    ["mssql", "microsoft.sql_server"],
    ["custom", "other_sql"],
  ] as const;

  for (const [index, [dialectId, systemName]] of dialects.entries()) {
    const operationId = `mapping-${index}`;
    const source = ready(operationId);
    observer.onEvent({
      ...source,
      execution: { ...source.execution, dialectId },
    });
    observer.onEvent(mapped(operationId));
    assert.equal(recording.spans[index]?.name, "billing");
    assert.equal(recording.spans[index]?.attributes["db.system.name"], systemName);
    assert.equal(recording.spans[index]?.attributes["db.namespace"], "billing");
    assert.equal(recording.spans[index]?.attributes["server.address"], "db.internal");
    assert.equal(recording.spans[index]?.attributes["server.port"], 5432);
    assert.deepEqual(recording.measurements[index]?.attributes, {
      "db.system.name": systemName,
      "db.namespace": "billing",
      "server.address": "db.internal",
      "server.port": 5432,
    });
  }
});

test("tracks real runtime rows, commands, prepared execution, and mapping failures", async () => {
  const observer = createOpenTelemetryObserver();
  const statementBinding = Object.freeze<StatementBindingAdapter>({
    id: "otel-runtime-test",
    describe(statement, context) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "otel-runtime-test",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "sqlbraid" },
      });
    },
  });
  const executor: QueryExecutor = {
    statementBinding,
    async query<Row>(rendered: RenderedStatement) {
      const text = rendered.segments.join("");
      if (text.startsWith("UPDATE")) return { kind: "command", rows: [], command: { affectedRows: 1 } };
      return { kind: "rows", rows: [{ value: 1 }] as unknown as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {},
    async call(): Promise<DriverRoutineResult> {
      return { output: {}, resultSets: [] };
    },
  };
  const db = createDatabase(executor, { observers: [observer] });

  await db.execute(sql.rows`SELECT 1`);
  await db.execute(sql.command`UPDATE users SET active = ${true}`);
  await db.prepare("prepared-users", () => sql.rows`SELECT 1`, { input: "none" }).execute();

  const mappingError = new Error("private mapping failure");
  const schema = {
    "~standard": {
      version: 1 as const,
      vendor: "otel-test",
      validate() {
        throw mappingError;
      },
    },
  };
  await assert.rejects(db.all(sql.rows(schema)`SELECT 1`), (error) => error === mappingError);
  await assert.rejects(db.execute(sql.rows`UPDATE users SET active = ${true}`), (error) => (
    error instanceof Error && "code" in error && error.code === "BRAID_RESULT_KIND"
  ));

  assert.equal(recording.spans.length, 5);
  assert.equal(recording.measurements.length, 5);
  assert.equal(recording.spans.filter(({ statuses }) => statuses.some(({ code }) => code === SpanStatusCode.ERROR)).length, 2);
  assert.equal(recording.spans.filter(({ endCount }) => endCount === 1).length, 5);
});

test("closes runtime prepared-stream telemetry exactly once on every terminal path", async () => {
  const observer = createOpenTelemetryObserver();
  const binding = Object.freeze<StatementBindingAdapter>({
    id: "otel-prepared-stream",
    describe(statement, context) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "otel-prepared-stream",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "sqlbraid" },
      });
    },
  });
  const baseExecutor = (): QueryExecutor => ({
    statementBinding: binding,
    async query<Row>() { return { kind: "rows", rows: [] as readonly Row[] }; },
    async *stream<Row>() { yield 1 as Row; },
    async call(): Promise<DriverRoutineResult> { return { output: {}, resultSets: [] }; },
  });
  const paths = ["unused", "normal", "early-break", "abort-before", "abort-after", "mapper", "driver", "cleanup"] as const;
  for (const path of paths) {
    const spanStart = recording.spans.length;
    const measurementStart = recording.measurements.length;
    let db!: Database;
    let start!: (options?: { readonly signal?: AbortSignal }) => AsyncIterable<unknown>;
    let acquired = 0;
    let abortController: AbortController | undefined;
    let abortReason: Error | undefined;

    if (path === "unused" || path === "normal" || path === "early-break" || path === "mapper" || path === "driver") {
      db = createDatabase({
        ...baseExecutor(),
        ...(path === "driver" ? {
          async *stream<Row>() { throw new Error("prepared stream driver failure"); },
        } : {}),
      }, { observers: [observer] });
      if (path === "mapper") {
        const schema = {
          "~standard": {
            version: 1 as const,
            vendor: "otel-prepared-stream",
            validate() { return { issues: [{ message: "prepared stream mapping failed" }] }; },
          },
        };
        const prepared = db.prepare("otel-mapper-stream", () => sql.rows(schema)`SELECT 1`, { input: "none" });
        start = (options) => prepared.stream(options);
      } else {
        const prepared = db.prepare(`otel-${path}-stream`, () => sql.rows`SELECT 1`, { input: "none" });
        start = (options) => prepared.stream(options);
      }
    } else if (path === "abort-before") {
      const environment = {
        database: { product: "otel-prepared-stream" },
        driver: { id: "otel-prepared-stream" },
        capabilities: {
          "statement.cancel": { status: "guaranteed" as const },
          "statement.stream": { status: "guaranteed" as const },
        },
      };
      db = createPooledDatabase({
        statementBinding: binding,
        environment,
        async acquire() {
          acquired += 1;
          return { ...baseExecutor(), release() {} };
        },
      }, { observers: [observer] });
      abortController = new AbortController();
      abortReason = new Error("prepared stream aborted before start");
      abortController.abort(abortReason);
      const prepared = db.prepare("otel-abort-before-stream", () => sql.rows`SELECT 1`, { input: "none" });
      start = (options) => prepared.stream(options);
    } else if (path === "abort-after") {
      db = createDatabase({
        ...baseExecutor(),
        environment: {
          database: { product: "otel-prepared-stream" },
          driver: { id: "otel-prepared-stream" },
          capabilities: {
            "statement.cancel": { status: "guaranteed" as const },
            "statement.stream": { status: "guaranteed" as const },
          },
        },
        async *stream<Row>() {
          yield 1 as Row;
          yield 2 as Row;
        },
      }, { observers: [observer] });
      abortController = new AbortController();
      abortReason = new Error("prepared stream aborted after row");
      const prepared = db.prepare("otel-abort-after-stream", () => sql.rows`SELECT 1`, { input: "none" });
      start = (options) => prepared.stream(options);
    } else {
      const cleanupError = new Error("prepared stream cleanup failure");
      db = createPooledDatabase({
        statementBinding: binding,
        async acquire() {
          return {
            ...baseExecutor(),
            async *stream<Row>() { yield 1 as Row; },
            release() { throw cleanupError; },
          };
        },
      }, { observers: [observer] });
      const prepared = db.prepare("otel-cleanup-stream", () => sql.rows`SELECT 1`, { input: "none" });
      start = (options) => prepared.stream(options);
    }

    if (path === "unused") {
      start();
      await Promise.resolve();
      assert.equal(recording.spans.length, spanStart);
      assert.equal(recording.measurements.length, measurementStart);
      continue;
    }

    const stream = start(abortController === undefined ? undefined : { signal: abortController.signal });
    const consume = async (): Promise<void> => {
      for await (const row of stream) {
        if (path === "early-break") break;
        if (path === "abort-after") abortController!.abort(abortReason);
        void row;
      }
    };
    if (path === "normal" || path === "early-break") await consume();
    else await assert.rejects(consume);
    if (path === "abort-before") assert.equal(acquired, 0);
    assert.equal(recording.spans.length, spanStart + 1, path);
    assert.equal(recording.spans[spanStart]?.endCount, 1, path);
    assert.equal(recording.measurements.length, measurementStart + 1, path);
  }
});

test("tracks real runtime routine calls, cardinality errors, and every batch item", async () => {
  const observer = createOpenTelemetryObserver();
  const executor: QueryExecutor = {
    statementBinding: Object.freeze({
      id: "otel-runtime-c3",
      describe(statement: RenderedStatement, context: StatementBindingContext) {
        return createStatementBindingDescription(statement, context, {
          adapterId: "otel-runtime-c3",
          transport: "text-positional",
          placeholder: (index) => `$${index}`,
          reuse: { effective: "simple", owner: "sqlbraid" },
        });
      },
    }),
    async query<Row>(rendered: RenderedStatement) {
      const text = rendered.segments.join("");
      const rows = text.includes("MANY") ? [{ value: 1 }, { value: 2 }] : [{ value: 1 }];
      return { kind: "rows", rows: rows as unknown as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {},
    async call(): Promise<DriverRoutineResult> {
      return { output: { refreshed: true }, resultSets: [] };
    },
  };
  const db = createDatabase(executor, { observers: [observer] });

  const routine = await db.call(sql.call`CALL refresh_users()`);
  assert.deepEqual(routine.output, { refreshed: true });
  await assert.rejects(() => db.one(sql.rows`SELECT MANY`), (error: unknown) => (
    error instanceof Error && error.name === "DatabaseCardinalityError"
  ));
  const batch = await db.batch([sql.rows`SELECT 1`, sql.rows`SELECT 2`] as const);
  assert.equal(batch.length, 2);

  assert.equal(recording.spans.length, 4);
  assert.equal(recording.measurements.length, 4);
  assert.equal(recording.spans.filter(({ endCount }) => endCount === 1).length, 4);
  assert.equal(recording.spans[0]?.attributes["sqlbraid.result.kind"], "call");
  const cardinalitySpan = recording.spans.find(({ statuses }) => statuses.some(({ code }) => code === SpanStatusCode.ERROR));
  assert.ok(cardinalitySpan);
  assert.equal(cardinalitySpan?.attributes["error.type"], "Error");
});

test("closes the OpenTelemetry span for malformed routine results", async () => {
  const observer = createOpenTelemetryObserver();
  const statementBinding = Object.freeze<StatementBindingAdapter>({
    id: "otel-malformed-routine",
    describe(statement, context) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "otel-malformed-routine",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "sqlbraid" },
      });
    },
  });
  const db = createDatabase({
    statementBinding,
    async query<Row>() { return { kind: "rows", rows: [] as readonly Row[] }; },
    async *stream<Row>(): AsyncGenerator<Row> {},
    async call() { return { output: {}, resultSets: [null] } as never; },
  }, { observers: [observer] });

  await assert.rejects(
    () => db.call(sql.call`CALL malformed_otel()`),
    (error: unknown) => error instanceof TypeError
      && error.message === "Executor returned a malformed routine execution result.",
  );
  assert.equal(recording.spans.length, 1);
  assert.equal(recording.spans[0]?.endCount, 1);
  assert.equal(recording.spans[0]?.statuses.some(({ code }) => code === SpanStatusCode.ERROR), true);
});

test("requires OTel last so late mapped and bulk observers turn spans into failures", async () => {
  const lateMapped = new Error("late mapped observer failed");
  const lateBulk = new Error("late bulk observer failed");
  const binding: StatementBindingAdapter = Object.freeze({
    id: "otel-ordering-test",
    describe(statement: RenderedStatement, context: StatementBindingContext) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "otel-ordering-test",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "sqlbraid" },
      });
    },
    describeBulk(bulk: RenderedBulk, context: StatementBindingContext) {
      return createBulkBindingDescription(bulk, context, {
        adapterId: "otel-ordering-test",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "sqlbraid" },
      });
    },
  });
  const executor: QueryExecutor = {
    statementBinding: binding,
    async query<Row>() { return { kind: "rows" as const, rows: [{ value: 1 }] as unknown as readonly Row[] }; },
    async bulk(): Promise<{ inputCount: number; affectedRows: number; executionMode: "native-bulk" }> {
      return { inputCount: 1, affectedRows: 1, executionMode: "native-bulk" };
    },
    async *stream<Row>(): AsyncGenerator<Row> {},
    async call(): Promise<DriverRoutineResult> { return { output: {}, resultSets: [] }; },
  };
  const lateObserver = {
    async onEvent(event: ExecutionEvent) {
      if (event.type === "query:mapped") throw lateMapped;
      if (event.type === "bulk:result") throw lateBulk;
    },
  };
  const observer = createOpenTelemetryObserver();
  const db = createDatabase(executor, { observers: [lateObserver, observer] });

  await assert.rejects(() => db.execute(sql.rows`SELECT 1`), (error) => error === lateMapped);
  assert.equal(recording.spans[0]?.endCount, 1);
  assert.deepEqual(recording.spans[0]?.statuses, [{ code: SpanStatusCode.ERROR }]);
  await assert.rejects(() => db.bulk([1], (value) => sql.command`UPDATE users SET value = ${value}`), (error) => error === lateBulk);
  assert.equal(recording.spans[1]?.endCount, 1);
  assert.deepEqual(recording.spans[1]?.statuses, [{ code: SpanStatusCode.ERROR }]);
});

test("keeps bind values and literalized SQL out of telemetry", () => {
  const disabledText = createOpenTelemetryObserver();
  disabledText.onEvent(ready("query-disabled"));
  disabledText.onEvent(mapped("query-disabled"));
  assert.equal(JSON.stringify(recording).includes(secret), false);

  trace.disable();
  metrics.disable();
  recording = {
    spans: [],
    measurements: [],
    throwOnTracerProviderAccess: false,
    throwOnSpanAccess: false,
    throwOnSpanMutation: false,
    throwOnMetricAccess: false,
    throwOnMetricRecord: false,
  };
  installProviders();
  const enabledText = createOpenTelemetryObserver({ queryText: true });
  enabledText.onEvent(ready("query-enabled"));
  enabledText.onEvent(mapped("query-enabled"));

  assert.equal(recording.spans[0].attributes["db.query.text"], "SELECT $1");
  assert.equal(JSON.stringify(recording.spans).includes(secret), false);
  assert.equal(JSON.stringify(recording.measurements).includes(secret), false);
});

test("supports traces-only, metrics-only, and disabled modes", () => {
  const tracesOnly = createOpenTelemetryObserver({ metrics: false });
  tracesOnly.onEvent(ready("traces-only"));
  tracesOnly.onEvent(mapped("traces-only"));
  assert.equal(recording.spans.length, 1);
  assert.equal(recording.measurements.length, 0);

  trace.disable();
  metrics.disable();
  recording = {
    spans: [],
    measurements: [],
    throwOnTracerProviderAccess: false,
    throwOnSpanAccess: false,
    throwOnSpanMutation: false,
    throwOnMetricAccess: false,
    throwOnMetricRecord: false,
  };
  installProviders();
  const metricsOnly = createOpenTelemetryObserver({ traces: false });
  metricsOnly.onEvent(ready("metrics-only"));
  metricsOnly.onEvent(mapped("metrics-only"));
  assert.equal(recording.spans.length, 0);
  assert.equal(recording.measurements.length, 1);

  const disabled = createOpenTelemetryObserver({ traces: false, metrics: false });
  disabled.onEvent(ready("disabled"));
  disabled.onEvent(mapped("disabled"));
  assert.equal(recording.spans.length, 0);
  assert.equal(recording.measurements.length, 1);
});

test("records failed status without exception messages or fabricated response codes", () => {
  const observer = createOpenTelemetryObserver();
  observer.onEvent(ready("failed"));
  observer.onEvent(failure("failed"));

  assert.equal(recording.spans.length, 1);
  assert.equal(recording.spans[0].endCount, 1);
  assert.deepEqual(recording.spans[0].statuses, [{ code: SpanStatusCode.ERROR }]);
  assert.equal(recording.spans[0].attributes["error.type"], "BRAID_RESULT_KIND");
  assert.equal("db.response.status_code" in recording.spans[0].attributes, false);
  assert.deepEqual(recording.spans[0].exceptionCalls, []);
  assert.equal(JSON.stringify(recording.spans).includes(secret), false);
  assert.equal(recording.measurements.length, 1);
  assert.equal(recording.measurements[0]?.attributes["error.type"], "BRAID_RESULT_KIND");
});

test("bounds error classification and keeps error attributes off successful metrics", () => {
  const observer = createOpenTelemetryObserver();
  observer.onEvent(ready("unknown"));
  const custom = Object.assign(new Error(secret), { code: "BRAID_SECRET_INTERNAL" });
  observer.onEvent(failure("unknown", { error: custom }));
  assert.equal(recording.spans[0]?.attributes["error.type"], "Error");
  assert.equal(recording.measurements[0]?.attributes["error.type"], "Error");

  observer.onEvent(ready("plain"));
  observer.onEvent(failure("plain", { error: { code: "99999", message: secret } }));
  assert.equal(recording.spans[1]?.attributes["error.type"], "object");
  assert.equal(recording.measurements[1]?.attributes["error.type"], "object");

  observer.onEvent(ready("hostile"));
  let codeReads = 0;
  const hostile = {};
  Object.defineProperty(hostile, "code", {
    get() {
      codeReads += 1;
      throw new Error(secret);
    },
  });
  observer.onEvent(failure("hostile", { error: hostile }));
  assert.equal(recording.spans[2]?.attributes["error.type"], "unknown_error");
  assert.equal(recording.measurements[2]?.attributes["error.type"], "unknown_error");
  assert.equal(codeReads, 1);

  observer.onEvent(ready("batch-aborted"));
  const batchAborted = Object.assign(new Error("aborted"), { code: "BRAID_BATCH_ABORTED" });
  observer.onEvent(failure("batch-aborted", { error: batchAborted }));
  assert.equal(recording.spans[3]?.attributes["error.type"], "BRAID_BATCH_ABORTED");
  assert.equal(recording.measurements[3]?.attributes["error.type"], "BRAID_BATCH_ABORTED");

  observer.onEvent(ready("success"));
  observer.onEvent(mapped("success"));
  assert.equal("error.type" in (recording.measurements[4]?.attributes ?? {}), false);
});

test("uses one explicit timestamp pair for span and metric duration", async () => {
  const observer = createOpenTelemetryObserver();
  observer.onEvent(ready("timed"));
  await new Promise((resolve) => setTimeout(resolve, 3));
  observer.onEvent(mapped("timed"));
  const span = recording.spans[0];
  assert.ok(span?.startTime);
  assert.ok(span?.endTime);
  assert.ok(
    (span?.endTime?.[0] ?? 0) > (span?.startTime?.[0] ?? 0)
      || (span?.endTime?.[0] === span?.startTime?.[0] && (span?.endTime?.[1] ?? 0) >= (span?.startTime?.[1] ?? 0)),
  );
  assert.ok((recording.measurements[0]?.value ?? 0) >= 0);
});

test("closes only the batch operation named by each terminal event", () => {
  const observer = createOpenTelemetryObserver({ queryText: true });
  observer.onEvent(ready("batch-a", { batchId: "batch-1" }));
  observer.onEvent(ready("batch-b", { batchId: "batch-1" }));
  observer.onEvent(ready("other"));
  observer.onEvent(mapped("other"));
  observer.onEvent(failure("batch-a", { batchId: "batch-1" }));
  assert.equal(recording.spans.find(({ attributes }) => attributes["sqlbraid.operation.id"] === "batch-b")?.endCount, 0);
  observer.onEvent(failure("batch-b", { batchId: "batch-1" }));
  observer.onEvent(mapped("batch-a"));
  observer.onEvent(bulkReady("bulk-1"));
  observer.onEvent(bulkResult("bulk-1"));

  assert.equal(recording.spans.length, 4);
  assert.equal(recording.spans.filter(({ endCount }) => endCount === 1).length, 4);
  assert.equal(recording.measurements.length, 4);
  const bulkSpan = recording.spans.find(({ attributes }) => attributes["sqlbraid.operation.id"] === "bulk-1");
  assert.equal(bulkSpan?.attributes["db.operation.batch.size"], 2);
  const bulkMeasurement = recording.measurements.at(-1);
  assert.ok(bulkMeasurement);
  assert.equal("db.operation.batch.size" in (bulkMeasurement?.attributes ?? {}), false);
  assert.equal("sqlbraid.operation.id" in (bulkMeasurement?.attributes ?? {}), false);
  assert.equal(JSON.stringify(recording).includes(secret), false);
});

test("uses explicit bulk identity and never infers it from another query", () => {
  const configured = createOpenTelemetryObserver({ database: { systemName: "billing-db" } });
  configured.onEvent(ready("query", { execution: { ...ready("query").execution, dialectId: "postgres" } }));
  configured.onEvent(mapped("query"));
  configured.onEvent(bulkReady("configured-bulk"));
  configured.onEvent(bulkResult("configured-bulk"));
  assert.equal(recording.spans.at(-1)?.name, "billing-db");

  trace.disable();
  metrics.disable();
  recording.spans.length = 0;
  recording.measurements.length = 0;
  installProviders();
  const generic = createOpenTelemetryObserver();
  generic.onEvent(ready("query-2", { execution: { ...ready("query-2").execution, dialectId: "postgres" } }));
  generic.onEvent(mapped("query-2"));
  generic.onEvent(bulkReady("generic-bulk"));
  generic.onEvent(bulkResult("generic-bulk"));
  assert.equal(recording.spans.at(-1)?.name, "other_sql");
});

test("handles calls and unsupported stream or transaction events without inventing spans", () => {
  const observer = createOpenTelemetryObserver();
  observer.onEvent(ready("call-1", { declaredKind: "call" }));
  observer.onEvent(result("call-1", "call"));
  observer.onEvent(mapped("call-1"));
  observer.onEvent({
    type: "stream:start",
    operationId: "stream-1",
    execution: ready("unused").execution,
    literalizedSql: () => {
      throw new Error("must not read");
    },
    declaredKind: "rows",
    transactionDepth: 0,
    transactionScoped: false,
    values: [secret],
  } as ExecutionEvent);
  observer.onEvent({
    type: "transaction",
    transactionId: "tx-1",
    phase: "begin",
    status: "completed",
    depth: 1,
  });

  assert.equal(recording.spans.length, 1);
  assert.equal(recording.spans[0].attributes["sqlbraid.result.kind"], "call");
  assert.equal(recording.measurements.length, 1);
});

test("isolates provider and instrument failures from observer delivery", async () => {
  const statementBinding = Object.freeze<StatementBindingAdapter>({
    id: "otel-failure-test",
    describe(statement, context) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "otel-failure-test",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "sqlbraid" },
      });
    },
  });
  recording.throwOnSpanAccess = true;
  recording.throwOnTracerProviderAccess = true;
  recording.throwOnMetricAccess = true;
  const observer = createOpenTelemetryObserver();
  assert.doesNotThrow(() => {
    observer.onEvent(ready("provider-failure"));
    observer.onEvent(mapped("provider-failure"));
  });
  await assert.doesNotReject(async () => {
    const result = await createDatabase({
      statementBinding,
      async query<Row>() {
        return { kind: "rows", rows: [{ value: 1 }] as unknown as readonly Row[] };
      },
      async *stream<Row>(): AsyncGenerator<Row> {},
      async call(): Promise<DriverRoutineResult> {
        return { output: {}, resultSets: [] };
      },
    }, { observers: [observer] }).execute(sql.rows`SELECT 1`);
    assert.deepEqual(result, { kind: "rows", rows: [{ value: 1 }] });
  });

  trace.disable();
  metrics.disable();
  recording = {
    spans: [],
    measurements: [],
    throwOnTracerProviderAccess: false,
    throwOnSpanAccess: false,
    throwOnSpanMutation: true,
    throwOnMetricAccess: false,
    throwOnMetricRecord: true,
  };
  installProviders();
  const mutationFailure = createOpenTelemetryObserver();
  assert.doesNotThrow(() => {
    mutationFailure.onEvent(ready("mutation-failure"));
    mutationFailure.onEvent(failure("mutation-failure"));
  });
  assert.equal(recording.measurements.length, 0);
});
