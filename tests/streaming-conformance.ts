import assert from "node:assert/strict";
import { UnsupportedFeatureError } from "@sqlbraid/core";
import type { Database, RowQuery } from "@sqlbraid/core";

export interface StreamingConformanceFixture<Row> {
  readonly db: Pick<Database, "stream">;
  readonly query: RowQuery<Row>;
  readonly expected: readonly Row[];
  readonly mappingQuery?: RowQuery<unknown>;
  readonly cleanupFailureQuery?: RowQuery<Row>;
  readonly cleanupFailure?: unknown;
  readonly released?: () => number;
  readonly iteratorReturns?: () => number;
  readonly close?: () => void | Promise<void>;
}

export interface StreamingConformanceOptions {
  readonly abortError?: unknown;
  readonly cancellation?: "supported" | "unsupported";
}

function containsError(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  if (error instanceof AggregateError && error.errors.some((nested) => containsError(nested, expected))) return true;
  if (error instanceof Error && "cause" in error && containsError(error.cause, expected)) return true;
  return false;
}

async function runScenario<Row>(
  create: () => StreamingConformanceFixture<Row> | Promise<StreamingConformanceFixture<Row>>,
  scenario: (fixture: StreamingConformanceFixture<Row>) => Promise<void>,
  expectedRuns?: number,
): Promise<void> {
  const fixture = await create();
  try {
    await scenario(fixture);
    if (expectedRuns !== undefined && fixture.iteratorReturns !== undefined) assert.equal(fixture.iteratorReturns(), expectedRuns);
    if (expectedRuns !== undefined && fixture.released !== undefined) assert.equal(fixture.released(), expectedRuns);
  } finally {
    await fixture.close?.();
  }
}

/**
 * Runs the lifecycle contract shared by every QueryExecutor streaming adapter.
 * Each scenario receives a fresh fixture, so an abort that destroys a physical
 * connection cannot affect the following lifecycle checks.
 */
export async function runStreamingConformance<Row>(
  create: () => StreamingConformanceFixture<Row> | Promise<StreamingConformanceFixture<Row>>,
  options: StreamingConformanceOptions = {},
): Promise<void> {
  await runScenario(create, async ({ db, query, expected }) => {
    const actual: Row[] = [];
    for await (const row of db.stream(query)) actual.push(row);
    assert.deepEqual(actual, expected);
  }, 1);

  await runScenario(create, async ({ db, query }) => {
    const consumerError = new Error("consumer failed");
    await assert.rejects(async () => {
      for await (const row of db.stream(query)) {
        void row;
        throw consumerError;
      }
    }, (error: unknown) => error === consumerError);
  }, 1);

  await runScenario(create, async ({ db, mappingQuery }) => {
    if (mappingQuery !== undefined) {
      await assert.rejects(async () => {
        for await (const row of db.stream(mappingQuery)) void row;
      });
    }
  });

  await runScenario(create, async ({ db, query }) => {
    const failure = new Error("execution schema failed");
    await assert.rejects(async () => {
      for await (const row of db.stream(query, {
        schema: { "~standard": { version: 1, vendor: "conformance", validate() { throw failure; } } },
      })) void row;
    }, (error: unknown) => containsError(error, failure));
  }, 1);

  await runScenario(create, async ({ db, query }) => {
    const controller = new AbortController();
    const abortError = options.abortError ?? new Error("stream aborted");
    controller.abort(abortError);
    await assert.rejects(async () => {
      for await (const row of db.stream(query, { signal: controller.signal })) void row;
    }, (error: unknown) => containsError(error, abortError));
  }, 0);

  await runScenario(create, async ({ db, query }) => {
    const controller = new AbortController();
    const abortError = options.abortError ?? new Error("stream aborted after first row");
    await assert.rejects(async () => {
      for await (const row of db.stream(query, { signal: controller.signal })) {
        void row;
        controller.abort(abortError);
      }
    }, (error: unknown) => options.cancellation === "unsupported"
      ? error instanceof UnsupportedFeatureError && error.feature === "statement.cancel"
      : containsError(error, abortError));
  }, options.cancellation === "unsupported" ? 0 : 1);

  await runScenario(create, async ({ db, query }) => {
    for await (const row of db.stream(query)) {
      void row;
      break;
    }
  }, 1);

  const cleanupFixture = await create();
  try {
    if (cleanupFixture.cleanupFailureQuery !== undefined) {
      await assert.rejects(async () => {
        for await (const row of cleanupFixture.db.stream(cleanupFixture.cleanupFailureQuery!)) void row;
      }, (error: unknown) => cleanupFixture.cleanupFailure === undefined || containsError(error, cleanupFixture.cleanupFailure));
      if (cleanupFixture.iteratorReturns !== undefined) assert.equal(cleanupFixture.iteratorReturns(), 1);
      if (cleanupFixture.released !== undefined) assert.equal(cleanupFixture.released(), 1);
    }
  } finally {
    await cleanupFixture.close?.();
  }
}
