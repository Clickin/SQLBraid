#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function usage() {
  throw new Error("Usage: node scripts/merge-vitest-results.mjs --output <report.json> --input-root <artifact-root> --expected <name,...> --observations-output <dir>");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read JSON ${path}: ${error.message}`, { cause: error });
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedFileName(name) {
  return resolve(String(name));
}

function mergeReports(reports) {
  assert.ok(reports.length > 0, "At least one Vitest report is required.");
  const files = new Map();
  for (const { path, report } of reports) {
    assert.equal(report.success, true, `Vitest shard failed: ${path}`);
    assert.ok(Array.isArray(report.testResults), `Vitest shard has no testResults array: ${path}`);
    for (const result of report.testResults) {
      assert.ok(result && typeof result === "object" && typeof result.name === "string", `Malformed Vitest result in ${path}`);
      const key = normalizedFileName(result.name);
      const previous = files.get(key);
      if (previous && !sameJson(previous, result)) {
        throw new Error(`Conflicting duplicate Vitest result for ${result.name}.`);
      }
      if (!previous) files.set(key, result);
    }
  }
  return { success: true, testResults: [...files.values()] };
}

async function collectArtifactReports(root, expected) {
  const reports = [];
  const observations = [];
  for (const name of expected) {
    const artifact = resolve(root, `ci-evidence-${name}`);
    assert.ok(await isDirectory(artifact), `Missing required evidence artifact: ${name}`);
    const status = await readJson(join(artifact, "status.json"));
    assert.equal(status.success, true, `Evidence shard failed outside Vitest: ${name}`);
    const reportPath = join(artifact, "results.json");
    const observationsPath = join(artifact, "observations");
    assert.ok(await isDirectory(observationsPath), `Missing observations directory for shard: ${name}`);
    reports.push({ path: reportPath, report: await readJson(reportPath) });
    observations.push({ name, path: observationsPath });
  }
  return { reports, observations };
}

async function mergeObservationDirectories(inputs, output) {
  await mkdir(output, { recursive: true });
  for (const { name, path } of inputs) {
    const files = (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile()
      && (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of files) {
      const source = join(path, entry.name);
      const text = await readFile(source, "utf8");
      if (entry.name.endsWith(".jsonl")) {
        for (const line of text.trim().split("\n").filter(Boolean)) JSON.parse(line);
      } else {
        JSON.parse(text);
      }
      await cp(source, join(output, `${name}-${entry.name}`));
    }
  }
}

async function mergeVitestResults({ artifactRoot, expected, output, observationsOutput }) {
  const names = [...new Set(expected)].filter(Boolean);
  assert.ok(names.length > 0, "At least one expected evidence shard is required.");
  const { reports, observations } = await collectArtifactReports(artifactRoot, names);
  const merged = mergeReports(reports);
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, `${JSON.stringify(merged, null, 2)}\n`);
  await mergeObservationDirectories(observations, observationsOutput);
  return { reportCount: reports.length, testFileCount: merged.testResults.length, observationDirectory: observationsOutput };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith("--")) usage();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    values[option.slice(2)] = value;
    index += 1;
  }
  if (!values.output || !values["input-root"] || !values.expected || !values["observations-output"]) usage();
  return values;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const result = await mergeVitestResults({
    artifactRoot: args["input-root"],
    expected: args.expected.split(","),
    output: args.output,
    observationsOutput: args["observations-output"],
  });
  console.info(`Merged ${result.reportCount} Vitest shards and ${result.testFileCount} test files.`);
}

export { mergeObservationDirectories, mergeReports, mergeVitestResults };
