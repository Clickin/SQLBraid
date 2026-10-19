import assert from "node:assert/strict";
import { Bench } from "tinybench";

export function shuffled(values, seed) {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const next = state % (index + 1);
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}

export function p95(sortedSamples) {
  return sortedSamples[Math.ceil(sortedSamples.length * 0.95) - 1];
}

export async function measure(cases, { time, warmup, seed }) {
  assert.equal(new Set(cases.map((entry) => entry.name)).size, cases.length, "Duplicate benchmark name");
  for (const entry of cases) {
    try {
      await entry.before?.();
      await entry.verify?.();
    } catch (error) {
      throw new Error(`Verification failed: ${entry.name}`, { cause: error });
    } finally {
      await entry.after?.();
    }
  }
  const results = [];
  for (const entry of shuffled(cases, seed)) {
    const warnings = [];
    try {
      await entry.before?.();
      const pilotStart = performance.now();
      if (entry.async) {
        for (let index = 0; index < 16; index += 1) await entry.run();
      } else {
        for (let index = 0; index < 16; index += 1) entry.run();
      }
      const pilotMean = (performance.now() - pilotStart) / 16;
      // Bound sample storage, not operation work. Tinybench still warms each case.
      const iterations = Math.max(16, Math.min(8192, Math.ceil(time / Math.max(pilotMean, 0.000001))));
      const bench = new Bench({
        time: 0,
        warmupTime: warmup,
        iterations,
        warmupIterations: 8,
        retainSamples: true,
        throws: true,
        concurrency: null,
        subtractTimerOverhead: false,
      });
      bench.addEventListener("warning", (event) => warnings.push(event.reason));
      bench.add(entry.name, entry.run, { async: entry.async ?? false });
      await bench.run();
      const task = bench.tasks[0];
      assert.equal(task.result.state, "completed", entry.name);
      const { latency, totalTime } = task.result;
      results.push({
        name: entry.name,
        group: entry.group,
        implementation: entry.implementation,
        category: entry.category,
        metadata: entry.metadata,
        latencyMs: { ...latency, p95: p95(latency.samples) },
        totalTimeMs: totalTime,
        sampling: { pilotMeanMs: pilotMean, iterations, targetTimeMs: time, maximumSamples: 8192 },
        // Reciprocal of mean service time, not the biased mean of reciprocal samples.
        invocationsPerSecond: 1000 / latency.mean,
        timerResolutionMs: task.estimatedResolution,
        warnings,
      });
      process.stderr.write(
        `${entry.name}: ${(latency.p50 * 1000).toFixed(2)} us p50; ${latency.samplesCount} samples\n`,
      );
    } finally {
      await entry.after?.();
    }
  }
  return results;
}

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
export function summarize(rounds) {
  const groups = new Map();
  for (const round of rounds) {
    for (const entry of round.results) {
      const group = groups.get(entry.name) ?? [];
      group.push(entry);
      groups.set(entry.name, group);
    }
  }
  return [...groups.values()].map((entries) => {
    const means = entries.map((entry) => entry.latencyMs.mean);
    const average = means.reduce((sum, value) => sum + value, 0) / means.length;
    return {
      name: entries[0].name,
      group: entries[0].group,
      implementation: entries[0].implementation,
      category: entries[0].category,
      metadata: entries[0].metadata,
      rounds: entries.length,
      samples: entries.reduce((sum, entry) => sum + entry.latencyMs.samplesCount, 0),
      medianMeanMs: median(means),
      medianP50Ms: median(entries.map((entry) => entry.latencyMs.p50)),
      medianP95Ms: median(entries.map((entry) => entry.latencyMs.p95)),
      minMeanMs: Math.min(...means),
      maxMeanMs: Math.max(...means),
      roundMeanSdMs:
        means.length < 2
          ? null
          : Math.sqrt(means.reduce((sum, value) => sum + (value - average) ** 2, 0) / (means.length - 1)),
      invocationsPerSecond: 1000 / median(means),
      roundMeansMs: means,
      warnings: [...new Set(entries.flatMap((entry) => entry.warnings))],
    };
  });
}
