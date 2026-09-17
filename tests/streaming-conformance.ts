import { UnsupportedFeatureError, type Database, type RowQuery } from "@sqlbraid/core";
import { assert } from "./certification/assert.js";

export interface StreamingConformanceFixture<Row> {
  readonly db: Pick<Database, "stream">;
  readonly query: RowQuery<Row>;
  readonly expected: readonly Row[];
  readonly mappingQuery?: RowQuery<unknown>;
  readonly cleanupFailureQuery?: RowQuery<Row>;
  readonly initFailureQuery?: RowQuery<Row>;
  readonly firstNextFailureQuery?: RowQuery<Row>;
  readonly midStreamFailureQuery?: RowQuery<Row>;
  readonly largeResultQuery?: RowQuery<Row>;
  readonly cleanupFailure?: unknown;
  readonly released?: () => number;
  readonly iteratorReturns?: () => number;
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

function containsError(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  if (error instanceof AggregateError && error.errors.some((nested) => containsError(nested, expected))) return true;
  if (error instanceof Error && "cause" in error && containsError(error.cause, expected)) return true;
  if (error && typeof error === "object") {
    const candidate = error as { readonly error?: unknown; readonly reason?: unknown; readonly message?: unknown; readonly issues?: readonly { readonly message?: unknown }[] };
    if (expected instanceof Error && candidate.message === expected.message) return true;
    if (candidate.error !== undefined && containsError(candidate.error, expected)) return true;
    if (candidate.reason !== undefined && containsError(candidate.reason, expected)) return true;
    if (expected instanceof Error && candidate.issues?.some((issue) => issue.message === expected.message)) return true;
  }
  return false;
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
        const actual: unknown[] = [];
        for await (const row of fixture.db.stream(fixture.query)) actual.push(row);
        assert.deepEqual(actual, fixture.expected);
        if (fixture.iteratorReturns) assert.equal(fixture.iteratorReturns(), 1);
        if (fixture.released) assert.equal(fixture.released(), 1);
        return;
      }
      case "STR002": {
        for await (const row of fixture.db.stream(fixture.query)) { void row; break; }
        if (fixture.iteratorReturns) assert.equal(fixture.iteratorReturns(), 1);
        if (fixture.released) assert.equal(fixture.released(), 1);
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
        const error = new Error("cert-mapper-failure");
        await assert.rejects(async () => {
          for await (const row of fixture.db.stream(mapping, { schema: { "~standard": { version: 1, vendor: "certification", validate() { throw error; } } } })) void row;
        }, (caught: unknown) => containsError(caught, error));
        return;
      }
      case "STR005": {
        const controller = new AbortController();
        const abortError = options.abortError ?? new Error("cert-abort-before");
        controller.abort(abortError);
        await assert.rejects(async () => {
          for await (const row of fixture.db.stream(fixture.query, { signal: controller.signal })) void row;
        }, (caught: unknown) => containsError(caught, abortError));
        if (fixture.iteratorReturns) assert.equal(fixture.iteratorReturns(), 0);
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
          : containsError(caught, abortError));
        return;
      }
      case "STR007": {
        const init = requireField(fixture.initFailureQuery, "initFailureQuery");
        await assert.rejects(async () => { for await (const row of fixture.db.stream(init)) void row; });
        const first = requireField(fixture.firstNextFailureQuery, "firstNextFailureQuery");
        await assert.rejects(async () => { for await (const row of fixture.db.stream(first)) void row; });
        const mid = requireField(fixture.midStreamFailureQuery, "midStreamFailureQuery");
        await assert.rejects(async () => { for await (const row of fixture.db.stream(mid)) void row; });
        return;
      }
      case "STR008": {
        const query = requireField(fixture.cleanupFailureQuery, "cleanupFailureQuery");
        if (query === undefined) return;
        await assert.rejects(async () => { for await (const row of fixture.db.stream(query)) void row; }, (caught: unknown) => fixture.cleanupFailure === undefined || containsError(caught, fixture.cleanupFailure));
        if (fixture.iteratorReturns) assert.equal(fixture.iteratorReturns(), 1);
        if (fixture.released) assert.equal(fixture.released(), 1);
        return;
      }
      case "STR009": {
        const query = fixture.largeResultQuery ?? fixture.query;
        const actual: unknown[] = [];
        for await (const row of fixture.db.stream(query)) actual.push(row);
        assert.ok(actual.length >= fixture.expected.length);
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
  const ids = ["STR001", "STR003", "STR004", "STR005", "STR006", "STR002", "STR008"] as const;
  for (const id of ids) {
    await runStreamingConformanceCase(id, create as () => StreamingConformanceFixture<unknown> | Promise<StreamingConformanceFixture<unknown>>, { ...options, strict: false });
  }
}
