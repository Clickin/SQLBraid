import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { summarize } from "./harness.mjs";

const { values } = parseArgs({
  options: {
    baseline: { type: "string", default: "tests/performance/.builds/baseline/runtime" },
    package: { type: "string", default: "runtime" },
    suite: { type: "string", default: "micro" },
    filter: { type: "string", default: "" },
    rounds: { type: "string", default: "7" },
    time: { type: "string", default: "150" },
    warmup: { type: "string", default: "100" },
    out: { type: "string", default: "docs/performance/results/paired" },
  },
});
const count = Number(values.rounds);
assert.ok(Number.isSafeInteger(count) && count >= 2);
assert.ok(["core", "runtime", "postgres"].includes(values.package));
const overrideKey = `SQLBRAID_PERF_${values.package.toUpperCase()}`;
const rounds = { baseline: [], candidate: [] };
for (let round = 0; round < count; round += 1) {
  for (const variant of round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
    const out = join(values.out, variant);
    const env = { ...process.env };
    if (variant === "baseline") env[overrideKey] = resolve(values.baseline);
    else delete env[overrideKey];
    const child = spawnSync(
      process.execPath,
      [
        "tests/performance/run.mjs",
        "--suite",
        values.suite,
        "--filter",
        values.filter,
        "--time",
        values.time,
        "--warmup",
        values.warmup,
        "--round",
        String(round),
        "--out",
        out,
      ],
      { stdio: "inherit", env },
    );
    assert.equal(child.status, 0, `${variant} round ${round}`);
    const measured = JSON.parse(gunzipSync(await readFile(join(out, `${values.suite}-${round}.json.gz`))));
    for (const entry of measured.results) delete entry.latencyMs.samples;
    rounds[variant].push(measured);
  }
}
for (const variant of ["baseline", "candidate"]) {
  await writeFile(
    join(values.out, variant, `${values.suite}-summary.json`),
    JSON.stringify(
      {
        environment: rounds[variant][0].environment,
        suiteMetadata: rounds[variant][0].suiteMetadata,
        results: summarize(rounds[variant]),
      },
      null,
      2,
    ) + "\n",
  );
}
const results = summarize(rounds.baseline).map((baseline) => {
  const pairs = rounds.baseline.map((before, index) => {
    const left = before.results.find((entry) => entry.name === baseline.name).latencyMs.mean;
    const right = rounds.candidate[index].results.find((entry) => entry.name === baseline.name).latencyMs.mean;
    return { baselineMs: left, candidateMs: right, ratio: right / left, savedMs: left - right };
  });
  const ratios = pairs.map((pair) => pair.ratio).toSorted((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  return {
    name: baseline.name,
    pairs,
    medianCandidateBaselineRatio: ratios.length % 2 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2,
    minRatio: ratios[0],
    maxRatio: ratios.at(-1),
    improvedRounds: pairs.filter((pair) => pair.ratio < 1).length,
  };
});
await mkdir(values.out, { recursive: true });
await writeFile(
  join(values.out, `${values.suite}-comparison.json`),
  JSON.stringify(
    {
      methodology:
        "Fresh process per variant/round; AB/BA alternation; same seeded workload order within each pair. Ratios of per-round means; no claim of independently additive stage costs.",
      rounds: count,
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Wrote ${results.length} paired comparisons to ${values.out}`);
