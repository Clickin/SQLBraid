#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Evidence is derived from successful test results, never from test-title existence.
const [resultsPath, outputPath, stampsDirectory] = process.argv.slice(2);
assert.ok(resultsPath && outputPath, "Usage: node scripts/support-evidence.mjs <test-results.json> <evidence.json> [stamps-directory]");
const results = JSON.parse(await readFile(resultsPath, "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (process.env.GITHUB_SHA) assert.equal(commit, process.env.GITHUB_SHA, "Evidence must describe the checked-out CI SHA.");
const registry = JSON.parse(await readFile("support/test-registry.json", "utf8"));
const passed = new Map();
const observations = [];
if (results.format === "sqlbraid-runtime-tests") {
  assert.equal(results.version, 1);
  assert.equal(results.commit, commit, "Native runtime evidence must describe this revision.");
  if (process.env.GITHUB_RUN_ID) assert.equal(results.run, process.env.GITHUB_RUN_ID);
  assert.ok(Array.isArray(results.testIds) && results.testIds.length > 0);
  assert.ok(Array.isArray(results.observations) && results.observations.length > 0);
  for (const id of results.testIds) {
    assert.ok(registry[id], `Unregistered native runtime test: ${id}`);
    assert.ok(results.observations.some((entry) => entry.testIds?.includes(id)
      && entry.runtime.id === results.runtime.id && entry.runtime.version === results.runtime.version),
    `Missing matching native runtime observation: ${id}`);
    passed.set(id, registry[id].title);
  }
  observations.push(...results.observations);
} else {
  assert.equal(results.success, true, "Failed test runs cannot certify support.");
  for (const file of results.testResults) {
    for (const test of file.assertionResults) {
      if (test.status !== "passed") continue;
      for (const [id, entry] of Object.entries(registry)) {
        if (resolve(entry.file) === resolve(file.name) && (test.title === entry.title || test.fullName === entry.title)) passed.set(id, test.fullName);
      }
    }
  }
}
if (stampsDirectory) {
  for (const name of (await readdir(stampsDirectory)).sort()) {
    if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue;
    const text = await readFile(resolve(stampsDirectory, name), "utf8");
    if (name.endsWith(".jsonl")) observations.push(...text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    else observations.push(JSON.parse(text));
  }
}
const targets = [];
for (const name of (await readdir("support/targets")).sort()) {
  if (!name.endsWith(".json")) continue;
  const target = JSON.parse(await readFile(`support/targets/${name}`, "utf8"));
  const claimed = [...new Set(Object.values(target.capabilities).flatMap(claim => claim.testIds))];
  const tests = claimed.filter(id => passed.has(id));
  if (!tests.length) continue;
  // PG18 shares fixture titles, not execution identity: retain only the selected target.
  if (target.database.product === "postgres" && target.driver.id === "pg" && target.runtime.id === "node"
    && name !== `${process.env.SQLBRAID_POSTGRES_TARGET ?? "postgres"}.json`) continue;
  const observed = observations.filter(entry => entry.targetId === name.slice(0, -5) || entry.targetId === target.id);
  const exactTupleObserved = observed.some(entry =>
    entry.database.product === target.database.product
    && entry.database.version === target.database.version
    && entry.database.edition === target.database.edition
    && entry.driver.id === target.driver.id
    && entry.driver.version === target.driver.version
    && entry.driver.profile === target.driver.profile
    && entry.runtime.id === target.runtime.id
    && entry.runtime.version === target.runtime.version
    && entry.typePolicy?.id === target.typePolicy.id
    && entry.typePolicy?.hash === target.typePolicy.hash);
  targets.push({
    id: target.id,
    database: target.database,
    driver: { id: target.driver.id, version: target.driver.version },
    profile: target.driver.profile,
    requiredOptions: target.driver.requiredOptions,
    typePolicy: target.typePolicy,
    declaredRuntime: target.runtime,
    tests,
    missingTests: claimed.filter(id => !passed.has(id)),
    observations: observed,
    exactTupleObserved,
  });
}
assert.ok(targets.length, "No real registered capability tests passed.");
const evidence = {
  format: "sqlbraid-support-evidence", version: 1, commit,
  run: process.env.GITHUB_RUN_ID ?? null,
  runtime: results.format === "sqlbraid-runtime-tests"
    ? results.runtime
    : { id: "node", version: process.versions.node, execArgv: process.execArgv, platform: process.platform, architecture: process.arch },
  targets, observations,
};
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Recorded ${targets.length} target test sets at ${commit}; certification additionally requires matching observed tuples and complete gates.`);
