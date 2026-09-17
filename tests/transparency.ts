import assert from "node:assert/strict";
import type { ExecutionEvent, QueryReadyEvent, RenderedStatement } from "@sqlbraid/core";

export interface TransparencyCase<T> {
  readonly capabilityId: string;
  readonly query: RenderedStatement;
  readonly expectedSegments: readonly string[];
  readonly expectedParameterizedSql: string;
  readonly events: readonly ExecutionEvent[];
  readonly execute: () => Promise<T>;
  readonly expectedResult: T | ((actual: T) => void);
}

function latestReady(events: readonly ExecutionEvent[]): QueryReadyEvent {
  const ready = events.findLast((event): event is QueryReadyEvent => event.type === "query:ready");
  assert.ok(
    ready,
    `${events.length ? "query:ready event was not emitted" : "transparency case has no observed events"}`,
  );
  return ready;
}

/**
 * Proves logical SQL segments, driver materialization, and the real DB result.
 * This helper intentionally receives expected evidence; it does not parse SQL.
 */
export async function runTransparencyCase<T>(options: TransparencyCase<T>): Promise<T> {
  assert.match(options.capabilityId, /^[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u);
  assert.deepEqual(options.query.segments, options.expectedSegments);
  const result = await options.execute();
  const ready = latestReady(options.events);
  assert.equal(ready.sql, options.expectedParameterizedSql);
  if (typeof options.expectedResult === "function") {
    (options.expectedResult as (actual: T) => void)(result);
  } else {
    assert.deepEqual(result, options.expectedResult);
  }
  return result;
}
