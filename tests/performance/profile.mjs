import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "micro" },
    filter: { type: "string" },
    iterations: { type: "string", default: "30000" },
    out: { type: "string", default: "docs/performance/results/profiles" },
    mode: { type: "string", default: "cpu" },
  },
});
assert.ok(["micro", "postgres"].includes(values.suite));
assert.ok(["cpu", "allocation"].includes(values.mode));
assert.ok(values.filter, "Use --filter to select one representative case");
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
const { createSuite } = await import(`./${values.suite}.mjs`);
const suite = await createSuite({ connectionString: process.env.SQLBRAID_PERF_URL, profile: "full" });
const session = new Session();
session.connect();
try {
  const cases = suite.cases.filter((entry) => new RegExp(values.filter).test(entry.name));
  assert.equal(cases.length, 1, "Profile exactly one case, not suite setup or benchmark statistics");
  const entry = cases[0];
  await entry.before?.();
  try {
    await entry.verify?.();
    for (let index = 0; index < Math.min(iterations, 2000); index += 1) await entry.run();
    if (values.mode === "cpu") {
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: 100 });
      await session.post("Profiler.start");
    } else {
      await session.post("HeapProfiler.enable");
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const start = performance.now();
    // This diagnostic loop includes an await per invocation, even for synchronous cases.
    for (let index = 0; index < iterations; index += 1) await entry.run();
    const elapsedMs = performance.now() - start;
    const { profile } = await session.post(values.mode === "cpu" ? "Profiler.stop" : "HeapProfiler.stopSampling");
    const out = resolve(values.out);
    await mkdir(out, { recursive: true });
    const name = entry.name.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
    const path = resolve(out, `${name}.${values.mode === "cpu" ? "cpuprofile" : "heapprofile"}`);
    const storedPath = values.mode === "cpu" ? path : `${path}.gz`;
    await writeFile(storedPath, values.mode === "cpu" ? JSON.stringify(profile) : gzipSync(JSON.stringify(profile)));
    const self = new Map();
    if (values.mode === "cpu") {
      const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
      for (let index = 0; index < (profile.samples?.length ?? 0); index += 1) {
        const frame = nodes.get(profile.samples[index]).callFrame;
        const key = `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.lineNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas?.[index] ?? 100));
      }
    } else {
      const visit = (node) => {
        const frame = node.callFrame;
        const key = `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.lineNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + node.selfSize);
        for (const child of node.children) visit(child);
      };
      visit(profile.head);
    }
    const total = [...self.values()].reduce((sum, value) => sum + value, 0);
    const summary = {
      case: entry.name,
      mode: values.mode,
      node: process.version,
      iterations,
      elapsedMs,
      profile: storedPath,
      unit: values.mode === "cpu" ? "sampled microseconds" : "estimated allocated bytes, including collected objects",
      total,
      perInvocation: total / iterations,
      limits:
        "Profiler-enabled diagnostic run, not normal timing. Sampling is an estimate; frames include loop and profiler overhead. Allocation is not retained heap.",
      self: [...self]
        .toSorted((a, b) => b[1] - a[1])
        .map(([frame, value]) => ({ frame, value, percent: (100 * value) / total })),
    };
    await writeFile(`${path}.json`, JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify({ ...summary, self: summary.self.slice(0, 20) }, null, 2));
  } finally {
    await entry.after?.();
  }
} finally {
  session.disconnect();
  await suite.close?.();
}
