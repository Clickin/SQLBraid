import {
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Histogram,
  type HrTime,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { ExecutionEvent, ExecutionObserver, QueryReadyEvent } from "@sqlbraid/core";
import { PUBLIC_ERROR_DEFINITIONS } from "@sqlbraid/core";

const INSTRUMENTATION_NAME = "@sqlbraid/opentelemetry";
const METRIC_NAME = "db.client.operation.duration";
const DURATION_BUCKETS = Object.freeze([0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]);
const PUBLIC_ERROR_CODES = new Set(PUBLIC_ERROR_DEFINITIONS.map(({ code }) => code));
const STABLE_INTERNAL_ERROR_CODES = new Set(["ERR_OPERATION_REPLACED"]);
const STABLE_ERROR_NAMES = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "DOMException",
]);
const DIALECT_SYSTEMS: Readonly<Record<string, string>> = Object.freeze({
  postgres: "postgresql",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlite: "sqlite",
  oracle: "oracle.db",
  mssql: "microsoft.sql_server",
});

/**
 * Readonly OpenTelemetry observer policy.
 * Traces/metrics default on; query text is opt-in and bind values/literalized SQL are never exported.
 */
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
  readonly startedAt: ClockReading;
  readonly span?: Span;
  readonly metricAttributes: Attributes;
}

interface ClockReading {
  readonly monotonicMs: number;
  readonly wallMs: number;
  readonly source: "performance" | "wall";
}

function clockNow(): ClockReading {
  const wallMs = Date.now();
  try {
    const monotonicMs = globalThis.performance?.now();
    if (typeof monotonicMs === "number" && Number.isFinite(monotonicMs)) {
      return { monotonicMs, wallMs, source: "performance" };
    }
  } catch {}
  return { monotonicMs: wallMs, wallMs, source: "wall" };
}

function spanTimestamp(milliseconds: number): HrTime {
  if (!Number.isFinite(milliseconds)) return [0, 0];
  const seconds = Math.floor(milliseconds / 1_000);
  const nanos = Math.max(0, Math.min(999_999_999, Math.floor((milliseconds - seconds * 1_000) * 1_000_000)));
  return [seconds, nanos];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeDatabaseOptions(value: OpenTelemetryObserverOptions["database"]): DatabaseOptions {
  if (value === undefined || value === null || typeof value !== "object") return {};
  const serverPort =
    typeof value.serverPort === "number" &&
    Number.isInteger(value.serverPort) &&
    value.serverPort >= 0 &&
    value.serverPort <= 65_535
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

function spanName(database: DatabaseOptions, systemName: string): string {
  return database.namespace ?? database.serverAddress ?? systemName;
}

function databaseAttributes(database: DatabaseOptions, systemName: string): Attributes {
  return {
    "db.system.name": systemName,
    ...(database.namespace === undefined ? {} : { "db.namespace": database.namespace }),
    ...(database.serverAddress === undefined ? {} : { "server.address": database.serverAddress }),
    ...(database.serverPort === undefined ? {} : { "server.port": database.serverPort }),
  };
}

function metricAttributes(attributes: Attributes): Attributes {
  const result: Attributes = {};
  for (const key of ["db.system.name", "db.namespace", "server.address", "server.port"] as const) {
    const value = attributes[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
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
      if (typeof code === "string" && (PUBLIC_ERROR_CODES.has(code) || STABLE_INTERNAL_ERROR_CODES.has(code))) {
        return code;
      }
    }
    if (error instanceof Error) {
      const name = error.name;
      if (STABLE_ERROR_NAMES.has(name)) return name;
      return "Error";
    }
    return typeof error;
  } catch {
    return "unknown_error";
  }
}

function durationSeconds(startedAt: ClockReading, endedAt: ClockReading): number {
  const durationMs =
    startedAt.source === "performance" && endedAt.source === "performance"
      ? endedAt.monotonicMs - startedAt.monotonicMs
      : endedAt.wallMs - startedAt.wallMs;
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1_000 : 0;
}

function errorAttributes(errorType: string): Attributes {
  return { "error.type": errorType };
}

function noopObserver(): ExecutionObserver {
  return Object.freeze({ onEvent() {} });
}

/**
 * Create an observer backed only by `@opentelemetry/api`.
 * SDK/provider/exporter failures are isolated so telemetry cannot rewrite or block SQLBraid execution.
 */
export function createOpenTelemetryObserver(options: OpenTelemetryObserverOptions = {}): ExecutionObserver {
  const tracesEnabled = options.traces !== false;
  const metricsEnabled = options.metrics !== false;
  if (!tracesEnabled && !metricsEnabled) return noopObserver();

  const database = normalizeDatabaseOptions(options.database);
  const queryTextEnabled = options.queryText === true;
  const operations = new Map<string, OperationState>();
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

  function finishOperation(
    operationId: string,
    outcome: "success" | "error",
    error: unknown = undefined,
    endedAt = clockNow(),
  ): void {
    const state = operations.get(operationId);
    if (state === undefined) return;
    operations.delete(operationId);
    const seconds = durationSeconds(state.startedAt, endedAt);
    const errorType = outcome === "error" ? safeErrorType(error) : undefined;

    if (state.span !== undefined) {
      if (outcome === "error") {
        try {
          state.span.setStatus({ code: SpanStatusCode.ERROR });
        } catch {}
        try {
          state.span.setAttributes(errorAttributes(errorType!));
        } catch {}
      }
      try {
        const durationMs = seconds * 1_000;
        state.span.end(spanTimestamp(state.startedAt.wallMs + durationMs));
      } catch {}
    }
    const currentHistogram = getHistogram();
    if (currentHistogram !== undefined) {
      try {
        currentHistogram.record(
          seconds,
          outcome === "error" ? { ...state.metricAttributes, ...errorAttributes(errorType!) } : state.metricAttributes,
        );
      } catch {}
    }
  }

  function startOperation(
    operationId: string,
    systemName: string,
    spanAttributes: Attributes,
    operationMetricAttributes: Attributes,
  ): void {
    if (operations.has(operationId)) {
      finishOperation(operationId, "error", { code: "ERR_OPERATION_REPLACED" });
    }
    const startedAt = clockNow();
    let span: Span | undefined;
    const currentTracer = getTracer();
    if (currentTracer !== undefined) {
      try {
        span = currentTracer.startSpan(systemName, {
          kind: SpanKind.CLIENT,
          attributes: spanAttributes,
          startTime: spanTimestamp(startedAt.wallMs),
        });
      } catch {}
    }
    operations.set(
      operationId,
      Object.freeze({
        startedAt,
        ...(span === undefined ? {} : { span }),
        metricAttributes: operationMetricAttributes,
      }),
    );
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
            spanName(database, systemName),
            {
              ...base,
              "sqlbraid.operation.id": event.operationId,
              ...(event.fingerprint === undefined ? {} : { "sqlbraid.query.fingerprint": event.fingerprint }),
              ...(event.preparedName === undefined ? {} : { "sqlbraid.prepared.name": event.preparedName }),
              ...(event.batchId === undefined ? {} : { "sqlbraid.batch.id": event.batchId }),
              ...(text === undefined ? {} : { "db.query.text": text }),
            },
            metricAttributes(base),
          );
          return;
        }
        case "query:result": {
          const state = operations.get(event.operationId);
          if (state?.span !== undefined) {
            try {
              state.span.setAttribute("sqlbraid.result.kind", event.actualKind);
            } catch {}
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
          startOperation(
            event.operationId,
            spanName(database, systemName),
            {
              ...base,
              "sqlbraid.operation.id": event.operationId,
              ...(text === undefined ? {} : { "db.query.text": text }),
              ...(Number.isInteger(event.itemCount) && event.itemCount >= 0
                ? { "db.operation.batch.size": event.itemCount }
                : {}),
            },
            metricAttributes(base),
          );
          return;
        }
        case "bulk:result":
          finishOperation(event.operationId, "success");
          return;
        case "stream:start": {
          const existing = operations.get(event.operationId);
          if (existing !== undefined) {
            if (existing.span !== undefined) {
              try {
                existing.span.setAttribute("sqlbraid.result.kind", event.declaredKind);
              } catch {}
            }
            return;
          }
          return;
        }
        case "stream:end":
          finishOperation(event.operationId, event.status === "completed" ? "success" : "error", event.error);
          return;
        case "query:error": {
          finishOperation(event.operationId, "error", event.error);
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
