import assert from "node:assert/strict";
import { test } from "node:test";
import { p95, summarize } from "./harness.mjs";

const row = (mean, samplesCount) => ({
  name: "case",
  group: "group",
  implementation: "fixture",
  category: "micro",
  warnings: [],
  latencyMs: { mean, p50: mean, p95: mean * 2, samplesCount },
});
test("P95 uses the nearest rank, not Tinybench's P99 field", () => {
  assert.equal(p95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
  assert.equal(p95([4]), 4);
  assert.equal(p95(Array.from({ length: 100 }, (_, index) => index)), 94);
});

test("round summaries preserve dispersion and do not pool unequal sample counts", () => {
  const [result] = summarize([{ results: [row(1, 1000)] }, { results: [row(3, 10)] }]);
  assert.equal(result.medianMeanMs, 2);
  assert.equal(result.medianP50Ms, 2);
  assert.equal(result.medianP95Ms, 4);
  assert.equal(result.samples, 1010);
  assert.equal(result.invocationsPerSecond, 500);
  assert.equal(result.roundMeanSdMs, Math.SQRT2);
  assert.deepEqual(result.roundMeansMs, [1, 3]);
});
