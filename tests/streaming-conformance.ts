import { UnsupportedFeatureError, type Database, type RowQuery, type StandardSchemaV1 } from "@sqlbraid/core";
import { assert } from "./certification/assert.js";

export interface StreamingConformanceFixture<Row> {
  readonly db: Pick<Database, "stream">;
  readonly query: RowQuery<Row>;
  readonly expected: readonly Row[];
  readonly mappingQuery?: RowQuery<unknown>;
  readonly mappingFailure?: unknown;
  readonly executionSchemaFailure?: unknown;
  readonly cleanupFailureQuery?: RowQuery<Row>;
  readonly initFailureQuery?: RowQuery<Row>;
  readonly initFailure?: unknown;
  readonly firstNextFailureQuery?: RowQuery<Row>;
  readonly firstNextFailure?: unknown;
  readonly midStreamFailureQuery?: RowQuery<Row>;
  readonly midStreamFailure?: unknown;
  readonly largeResultQuery?: RowQuery<Row>;
  readonly largeResultCount?: number;
  readonly cleanupFailure?: unknown;
  readonly released?: () => number;
  readonly iteratorReturns?: () => number;
  readonly reuseAfterBreak?: () => Promise<void>;
  readonly close?: () => void | Promise<void>;
}

async function withFixture<Row>(
  create: () => StreamingConformanceFixture<Row> | Promise<StreamingConformanceFixture<Row>>,
  operation: (fixture: StreamingConformanceFixture<Row>) => Promise<void>,
): Promise<void> {
  const fixture = await create();
  try {
    await operation(fixture);
  } finally {
    await fixture.close?.();
  }
}

function errorCode(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || !("code" in value)) return undefined;
  const code = (value as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function containsExpectedError(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  const expectedErrorCode = errorCode(expected);
  if (expectedErrorCode !== undefined && errorCode(error) === expectedErrorCode) return true;
  if (error instanceof AggregateError && error.errors.some((nested) => containsExpectedError(nested, expected))) return true;
  if (error instanceof Error && "cause" in error && containsExpectedError(error.cause, expected)) return true;
  return false;
}

function throwingSchema(failure: unknown): StandardSchemaV1<unknown, unknown> {
  return { "~standard": { version: 1, vendor: "stream-conformance", validate() { throw failure; } } };
}

export interface StreamingConformanceOptions {
  readonly abortError?: unknown;
  readonly cancellation?: "supported" | "unsupported";
}

/**
 * One strict, named stream contract. Certification calls this with strict
 * fixtures; the compatibility wrapper below only runs scenarios a legacy
 * fixture explicitly provides.
 */
export async function runStreamingConformanceCase(
  id: string,
  create: () => StreamingConformanceFixture<unknown> | Promise<StreamingConformanceFixture<unknown>>,
  options: StreamingConformanceOptions & { readonly strict?: boolean } = {},
): Promise<void> {
  const strict = options.strict !== false;
  const requireField = <T>(value: T | undefined, name: string): T => {
    if (value === undefined && strict) throw new Error(`${id} requires ${name} fixture evidence.`);
    return value as T;
  };
  await withFixture(create, async (fixture) => {
    switch (id) {
      case "STR001": {
        const iteratorReturns = requireField(fixture.iteratorReturns, "iteratorReturns");
        const released = requireField(fixture.released, "released");
        const actual: unknown[] = [];
        for await (const row of fixture.db.stream(fixture.query)) actual.push(row);
        assert.deepEqual(actual, fixture.expected);
        assert.equal(iteratorReturns(), 1);
        assert.equal(released(), 1);
        return;
      }
      case "STR002": {
        const iteratorReturns = requireField(fixture.iteratorReturns, "iteratorReturns");
        const released = requireField(fixture.released, "released");
        for await (const row of fixture.db.stream(fixture.query)) { void row; break; }
        assert.equal(iteratorReturns(), 1);
        assert.equal(released(), 1);
        return;
      }
      case "STR003": {
        const error = new Error("cert-consumer-failure");
        await assert.rejects(async () => {
          for await (const row of fixture.db.stream(fixture.query)) { void row; throw error; }
        }, (caught: unknown) => caught === error);
        return;
      }
      case "STR004": {
        const mapping = requireField(fixture.mappingQuery, "mappingQuery");
        if (mapping === undefined) return;
        if (!strict) {
          await assert.rejects(async () => { for await (const row of fixture.db.stream(mapping)) void row; });
          return;
        }
        if (mapping.resultSchema === undefined) throw new Error("STR004 requires mappingQuery.resultSchema fixture evidence.");
        const mappingFailure = requireField(fixture.mappingFailure, "mappingFailure");
        await assert.rejects(async () => {
          for await (const row of fixture.db.stream(mapping)) void row;
        }, (caught: unknown) => containsExpectedError(caught, mappingFailure));
        const executionSchemaFailure = requireField(fixture.executionSchemaFailure, "executionSchemaFailure");
        await assert.rejects(async () => {
          for await (const row of fixture.db.stream(fixture.query, { schema: throwingSchema(executionSchemaFailure) })) void row;
        }, (caught: unknown) => containsExpectedError(caught, executionSchemaFailure));
        return;
      }
      case "STR004_SCHEMA": {
        if (strict) throw new Error("STR004_SCHEMA is only a legacy compatibility case.");
        await assert.rejects(async () => {
          for await (const row of fixture.db.stream(fixture.query, {
            schema: throwingSchema(new Error("execution schema failed")),
          })) void row;
        });
        return;
      }
      case "STR005": {
        const iteratorReturns = requireField(fixture.iteratorReturns, "iteratorReturns");
        const controller = new AbortController();
        const abortError = options.abortError ?? new Error("cert-abort-before");
        controller.abort(abortError);
        await assert.rejects(async () => {
          for await (const row of fixture.db.stream(fixture.query, { signal: controller.signal })) void row;
        }, (caught: unknown) => containsExpectedError(caught, abortError));
        assert.equal(iteratorReturns(), 0);
        return;
      }
      case "STR006": {
        const controller = new AbortController();
        const abortError = options.abortError ?? new Error("cert-abort-during");
        await assert.rejects(async () => {
          for await (const row of fixture.db.stream(fixture.query, { signal: controller.signal })) {
            void row;
            controller.abort(abortError);
          }
        }, (caught: unknown) => options.cancellation === "unsupported"
          ? caught instanceof UnsupportedFeatureError && caught.feature === "statement.cancel"
          : containsExpectedError(caught, abortError));
        return;
      }
      case "STR007": {
        const init = requireField(fixture.initFailureQuery, "initFailureQuery");
        const initFailure = requireField(fixture.initFailure, "initFailure");
        if (init === undefined) return;
        await assert.rejects(async () => { for await (const row of fixture.db.stream(init)) void row; }, (caught: unknown) => containsExpectedError(caught, initFailure));
        const first = requireField(fixture.firstNextFailureQuery, "firstNextFailureQuery");
        const firstFailure = requireField(fixture.firstNextFailure, "firstNextFailure");
        if (first === undefined) return;
        await assert.rejects(async () => { for await (const row of fixture.db.stream(first)) void row; }, (caught: unknown) => containsExpectedError(caught, firstFailure));
        const mid = requireField(fixture.midStreamFailureQuery, "midStreamFailureQuery");
        const midFailure = requireField(fixture.midStreamFailure, "midStreamFailure");
        if (mid === undefined) return;
        await assert.rejects(async () => { for await (const row of fixture.db.stream(mid)) void row; }, (caught: unknown) => containsExpectedError(caught, midFailure));
        return;
      }
      case "STR008": {
        const iteratorReturns = requireField(fixture.iteratorReturns, "iteratorReturns");
        const released = requireField(fixture.released, "released");
        const query = requireField(fixture.cleanupFailureQuery, "cleanupFailureQuery");
        const cleanupFailure = requireField(fixture.cleanupFailure, "cleanupFailure");
        if (query === undefined) return;
        await assert.rejects(async () => { for await (const row of fixture.db.stream(query)) void row; }, (caught: unknown) => containsExpectedError(caught, cleanupFailure));
        assert.equal(iteratorReturns(), 1);
        assert.equal(released(), 1);
        return;
      }
      case "STR009": {
        const iteratorReturns = requireField(fixture.iteratorReturns, "iteratorReturns");
        const released = requireField(fixture.released, "released");
        const query = requireField(fixture.largeResultQuery, "largeResultQuery");
        const expectedCount = requireField(fixture.largeResultCount, "largeResultCount");
        if (query === undefined || expectedCount === undefined) return;
        assert.ok(expectedCount > fixture.expected.length);
        let actualCount = 0;
        for await (const row of fixture.db.stream(query)) { void row; actualCount += 1; }
        assert.equal(actualCount, expectedCount);
        assert.equal(iteratorReturns(), 1);
        assert.equal(released(), 1);
        return;
      }
      case "STR011": {
        const iteratorReturns = requireField(fixture.iteratorReturns, "iteratorReturns");
        const released = requireField(fixture.released, "released");
        const reuseAfterBreak = requireField(fixture.reuseAfterBreak, "reuseAfterBreak");
        for await (const row of fixture.db.stream(fixture.query)) { void row; break; }
        assert.equal(iteratorReturns(), 1);
        assert.equal(released(), 1);
        await reuseAfterBreak();
        return;
      }
      default:
        throw new Error(`Unknown streaming conformance case ${id}.`);
    }
  });
}

export async function runStreamingConformance<Row>(
  create: () => StreamingConformanceFixture<Row> | Promise<StreamingConformanceFixture<Row>>,
  options: StreamingConformanceOptions = {},
): Promise<void> {
  const ids = ["STR001", "STR003", "STR004", "STR004_SCHEMA", "STR005", "STR006", "STR002", "STR008"] as const;
  for (const id of ids) {
    await runStreamingConformanceCase(id, create as () => StreamingConformanceFixture<unknown> | Promise<StreamingConformanceFixture<unknown>>, { ...options, strict: false });
  }
}
