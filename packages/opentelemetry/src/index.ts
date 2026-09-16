import {
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Histogram,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type {
  ExecutionEvent,
  ExecutionObserver,
  QueryReadyEvent,
} from "@sqlbraid/core";

const INSTRUMENTATION_NAME = "@sqlbraid/opentelemetry";
const METRIC_NAME = "db.client.operation.duration";
const DURATION_BUCKETS = Object.freeze([0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]);
const DIALECT_SYSTEMS: Readonly<Record<string, string>> = Object.freeze({
  postgres: "postgresql",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlite: "sqlite",
  oracle: "oracle.db",
  mssql: "microsoft.sql_server",
});

export interface OpenTelemetryObserverOptions {
  readonly traces?: boolean;
  readonly metrics?: boolean;
  readonly queryText?: boolean;
  readonly database?: {
    readonly namespace?: string;
    readonly serverAddress?: string;
    readonly serverPort?: number;
    readonly systemName?: string;
  };
}

interface DatabaseOptions {
  readonly namespace?: string;
  readonly serverAddress?: string;
  readonly serverPort?: number;
  readonly systemName?: string;
}

interface OperationState {
  readonly startedAt: number;
  readonly span?: Span;
  readonly metricAttributes: Attributes;
  readonly batchId?: string;
}

function monotonicNow(): number {
  try {
    return globalThis.performance?.now() ?? Date.now();
  } catch {
    return Date.now();
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeDatabaseOptions(value: OpenTelemetryObserverOptions["database"]): DatabaseOptions {
  if (value === undefined || value === null || typeof value !== "object") return {};
  const serverPort = typeof value.serverPort === "number"
    && Number.isInteger(value.serverPort)
    && value.serverPort >= 0
    && value.serverPort <= 65_535
    ? value.serverPort
    : undefined;
  return Object.freeze({
    ...(nonEmptyString(value.namespace) === undefined ? {} : { namespace: value.namespace }),
    ...(nonEmptyString(value.serverAddress) === undefined ? {} : { serverAddress: value.serverAddress }),
    ...(serverPort === undefined ? {} : { serverPort }),
    ...(nonEmptyString(value.systemName) === undefined ? {} : { systemName: value.systemName }),
  });
}

function databaseSystem(database: DatabaseOptions, dialectId?: string): string {
  return database.systemName ?? (dialectId === undefined ? undefined : DIALECT_SYSTEMS[dialectId]) ?? "other_sql";
}

function databaseAttributes(database: DatabaseOptions, systemName: string): Attributes {
  return {
    "db.system.name": systemName,
    ...(database.namespace === undefined ? {} : { "db.namespace": database.namespace }),
    ...(database.serverAddress === undefined ? {} : { "server.address": database.serverAddress }),
    ...(database.serverPort === undefined ? {} : { "server.port": database.serverPort }),
  };
}

function queryText(event: QueryReadyEvent | { readonly sql?: string }): string | undefined {
  try {
    return typeof event.sql === "string" ? event.sql : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorType(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null) {
      const code = (error as { readonly code?: unknown }).code;
      if (typeof code === "string" && /^(?:BRAID_[A-Z0-9_]+|ERR_[A-Z0-9_]+|E[A-Z0-9_]+|[0-9A-Z]{5})$/u.test(code)) {
        return code;
      }
      const name = (error as { readonly name?: unknown }).name;
      if (typeof name === "string" && /^(?:Error|Exception|[A-Za-z][A-Za-z0-9]*(?:Error|Exception))$/u.test(name)) {
        return name;
      }
    }
    if (error instanceof Error && /^(?:Error|Exception|[A-Za-z][A-Za-z0-9]*(?:Error|Exception))$/u.test(error.name)) {
      return error.name;
    }
    return typeof error;
  } catch {
    return "unknown_error";
  }
}

function durationSeconds(startedAt: number, endedAt: number): number {
  const durationMs = endedAt - startedAt;
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1_000 : 0;
}

function errorAttributes(error: unknown): Attributes {
  return { "error.type": safeErrorType(error) };
}

function noopObserver(): ExecutionObserver {
  return Object.freeze({ onEvent() {} });
}

export function createOpenTelemetryObserver(
  options: OpenTelemetryObserverOptions = {},
): ExecutionObserver {
  const tracesEnabled = options.traces !== false;
  const metricsEnabled = options.metrics !== false;
  if (!tracesEnabled && !metricsEnabled) return noopObserver();

  const database = normalizeDatabaseOptions(options.database);
  const queryTextEnabled = options.queryText === true;
  const operations = new Map<string, OperationState>();
  const batches = new Map<string, Set<string>>();
  let tracer: Tracer | undefined;
  let histogram: Histogram | undefined;

  function getTracer(): Tracer | undefined {
    if (!tracesEnabled) return undefined;
    if (tracer !== undefined) return tracer;
    try {
      tracer = trace.getTracer(INSTRUMENTATION_NAME);
      return tracer;
    } catch {
      return undefined;
    }
  }

  function getHistogram(): Histogram | undefined {
    if (!metricsEnabled) return undefined;
    if (histogram !== undefined) return histogram;
    try {
      histogram = metrics.getMeter(INSTRUMENTATION_NAME).createHistogram(METRIC_NAME, {
        description: "Duration of a SQLBraid logical database operation.",
        unit: "s",
        advice: { explicitBucketBoundaries: [...DURATION_BUCKETS] },
      });
      return histogram;
    } catch {
      return undefined;
    }
  }

  function removeBatch(operationId: string, batchId: string | undefined): void {
    if (batchId === undefined) return;
    const batch = batches.get(batchId);
    if (batch === undefined) return;
    batch.delete(operationId);
    if (batch.size === 0) batches.delete(batchId);
  }

  function finishOperation(
    operationId: string,
    outcome: "success" | "error",
    error: unknown = undefined,
    endedAt = monotonicNow(),
  ): void {
    const state = operations.get(operationId);
    if (state === undefined) return;
    operations.delete(operationId);
    removeBatch(operationId, state.batchId);
    const seconds = durationSeconds(state.startedAt, endedAt);

    if (state.span !== undefined) {
      if (outcome === "error") {
        try { state.span.setStatus({ code: SpanStatusCode.ERROR }); } catch {}
        try { state.span.setAttributes(errorAttributes(error)); } catch {}
      }
      try { state.span.end(); } catch {}
    }
    const currentHistogram = getHistogram();
    if (currentHistogram !== undefined) {
      try { currentHistogram.record(seconds, state.metricAttributes); } catch {}
    }
  }

  function startOperation(
    operationId: string,
    systemName: string,
    spanAttributes: Attributes,
    metricAttributes: Attributes,
    batchId?: string,
  ): void {
    if (operations.has(operationId)) {
      finishOperation(operationId, "error", { code: "ERR_OPERATION_REPLACED" });
    }
    const startedAt = monotonicNow();
    let span: Span | undefined;
    const currentTracer = getTracer();
    if (currentTracer !== undefined) {
      try {
        span = currentTracer.startSpan(systemName, {
          kind: SpanKind.CLIENT,
          attributes: spanAttributes,
        });
      } catch {}
    }
    operations.set(operationId, Object.freeze({
      startedAt,
      ...(span === undefined ? {} : { span }),
      metricAttributes,
      ...(batchId === undefined ? {} : { batchId }),
    }));
    if (batchId !== undefined) {
      let batch = batches.get(batchId);
      if (batch === undefined) {
        batch = new Set();
        batches.set(batchId, batch);
      }
      batch.add(operationId);
    }
  }

  function observe(event: ExecutionEvent): void {
    try {
      switch (event.type) {
        case "query:ready": {
          const systemName = databaseSystem(database, event.execution.dialectId);
          const base = databaseAttributes(database, systemName);
          const text = queryTextEnabled ? queryText(event) : undefined;
          startOperation(
            event.operationId,
            systemName,
            {
              ...base,
              "sqlbraid.operation.id": event.operationId,
              ...(event.fingerprint === undefined ? {} : { "sqlbraid.query.fingerprint": event.fingerprint }),
              ...(event.preparedName === undefined ? {} : { "sqlbraid.prepared.name": event.preparedName }),
              ...(event.batchId === undefined ? {} : { "sqlbraid.batch.id": event.batchId }),
              ...(text === undefined ? {} : { "db.query.text": text }),
            },
            base,
            event.batchId,
          );
          return;
        }
        case "query:result": {
          const state = operations.get(event.operationId);
          if (state?.span !== undefined) {
            try { state.span.setAttribute("sqlbraid.result.kind", event.actualKind); } catch {}
          }
          return;
        }
        case "query:mapped":
          finishOperation(event.operationId, "success");
          return;
        case "bulk:ready": {
          const systemName = databaseSystem(database);
          const base = databaseAttributes(database, systemName);
          const text = queryTextEnabled ? queryText(event) : undefined;
          const metricAttributes = Number.isInteger(event.itemCount) && event.itemCount >= 0
            ? { ...base, "db.operation.batch.size": event.itemCount }
            : base;
          startOperation(
            event.operationId,
            systemName,
            {
              ...base,
              "sqlbraid.operation.id": event.operationId,
              ...(text === undefined ? {} : { "db.query.text": text }),
              ...(Number.isInteger(event.itemCount) && event.itemCount >= 0
                ? { "db.operation.batch.size": event.itemCount }
                : {}),
            },
            metricAttributes,
          );
          return;
        }
        case "bulk:result":
          finishOperation(event.operationId, "success");
          return;
        case "query:error": {
          const pending = event.batchId === undefined
            ? []
            : [...(batches.get(event.batchId) ?? [])];
          finishOperation(event.operationId, "error", event.error);
          if (event.batchId !== undefined) {
            for (const operationId of pending) {
              if (operationId !== event.operationId) finishOperation(operationId, "error", event.error);
            }
          }
          return;
        }
        default:
          return;
      }
    } catch {
      // Telemetry must not change SQLBraid's query, transaction, or lease outcome.
    }
  }

  return Object.freeze({ onEvent: observe });
}
