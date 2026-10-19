import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { p95, summarize } from "./harness.mjs";

assert.ok(process.argv.length > 2, "Pass one or more result directories");
for (const directory of process.argv.slice(2)) {
  const files = await readdir(directory);
  for (const suite of ["micro", "postgres"]) {
    const rounds = [];
    const inputs = files
      .filter((name) => new RegExp(`^${suite}-[0-9]+\\.json\\.gz$`).test(name))
      .toSorted((a, b) => Number(a.split("-")[1].split(".")[0]) - Number(b.split("-")[1].split(".")[0]));
    for (const file of inputs) {
      const round = JSON.parse(gunzipSync(await readFile(join(directory, file))));
      for (const entry of round.results) {
        const samples = entry.latencyMs.samples;
        assert.equal(samples.length, entry.latencyMs.samplesCount, entry.name);
        assert.ok(
          samples.every((value, index) => Number.isFinite(value) && (index === 0 || value >= samples[index - 1])),
          entry.name,
        );
        entry.latencyMs.p95 = p95(samples);
        delete entry.latencyMs.samples;
      }
      rounds.push(round);
    }
    if (rounds.length === 0) continue;
    const first = rounds[0];
    const summary = {
      format: "sqlbraid-performance-summary-v1",
      environment: first.environment,
      suiteMetadata: first.suiteMetadata,
      methodology: {
        ...first.methodology,
        rounds: rounds.length,
        p95: "Nearest-rank P95 of all sorted invocation samples; summary is median across rounds",
        dispersion: "Sample SD of independent round means; median per-round mean/P50/P95, not pooled quantiles",
      },
      results: summarize(rounds),
    };
    await writeFile(join(directory, `${suite}-summary.json`), JSON.stringify(summary, null, 2) + "\n");
    console.log(
      `${directory}/${suite}: ${summary.results.length} cases, ${rounds.length} rounds; raw samples unchanged`,
    );
  }
}
