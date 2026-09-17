#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const expectedSuites = [
  "tests/runtime-batch-lifecycle.test.ts",
  "tests/runtime-transaction-boundary.test.ts",
  "tests/opentelemetry.test.ts",
  "tests/opentelemetry-sdk.test.ts",
  "tests/db/postgres/pv15.test.ts",
  "tests/db/postgres/capabilities.test.ts",
  "tests/db/mysql/pv15.test.ts",
  "tests/db/mysql/capabilities.test.ts",
  "tests/db/mariadb/pv16.test.ts",
  "tests/db/mariadb/capabilities.test.ts",
  "tests/db/oracle/pv15-routines.test.ts",
  "tests/db/oracle/w01.test.ts",
  "tests/db/oracle/capabilities.test.ts",
  "tests/db/mssql/pv15-routines.test.ts",
  "tests/db/mssql/w01.test.ts",
  "tests/db/sqlite/w01.test.ts",
  "tests/db/sqlite/better-sqlite3.test.ts",
];
function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function sourceSha() {
  const value = option("--source-sha") ?? process.env.SQLBRAID_CERT_SOURCE_SHA;
  if (!/^[0-9a-f]{40}$/iu.test(value ?? "")) throw new Error("Global evidence requires an exact source SHA.");
  return value;
}
function validateEvidence(evidence, sha) {
  if (evidence.schemaVersion !== 1 || evidence.sourceSha !== sha || evidence.status !== "pass")
    throw new Error("Global evidence has an invalid schema, source SHA, or status.");
  const candidate = JSON.parse(process.env.SQLBRAID_CERT_CANDIDATE_JSON ?? "null");
  if (!candidate || candidate.sourceSha !== sha || !/^[0-9a-f]{64}$/u.test(candidate.preparedBuildSha256 ?? ""))
    throw new Error("Global evidence requires the exact prepared candidate identity.");
  assert.deepEqual(evidence.candidate, candidate, "Global evidence candidate identity mismatch.");
  if (
    evidence.prepared?.sourceSha !== sha ||
    evidence.prepared.archiveSha256 !== candidate.preparedBuildSha256 ||
    !/^[0-9a-f]{64}$/u.test(evidence.prepared.distSha256 ?? "")
  )
    throw new Error("Global evidence requires verified prepared archive and dist digests.");
  if (
    !Array.isArray(evidence.checks) ||
    evidence.checks.length !== expectedSuites.length ||
    evidence.checks.some((check, index) => check !== expectedSuites[index])
  )
    throw new Error("Global evidence does not name the required concrete suites.");
  const suites = Array.isArray(evidence.testSuites)
    ? evidence.testSuites.slice().sort((left, right) => left.name.localeCompare(right.name))
    : [];
  const names = expectedSuites.slice().sort();
  if (
    suites.length !== names.length ||
    suites.some((suite, index) => suite.name !== names[index] || suite.status !== "passed")
  )
    throw new Error("Global evidence does not prove every required suite ran and passed.");
}
const sha = sourceSha();
const reportPath = option("--report");
const evidencePath = option("--evidence");
if (reportPath !== undefined) {
  if (!process.env.SQLBRAID_CERT_PREPARED_DIR)
    throw new Error("Global certification must resolve packages from the prepared build.");
  const preparedPath = option("--prepared-evidence");
  if (!preparedPath) throw new Error("Global evidence derivation requires --prepared-evidence.");
  const report = JSON.parse(await readFile(resolve(reportPath), "utf8"));
  if (!report.success || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0)
    throw new Error("Shared certification suites did not produce a passing report.");
  const evidence = {
    schemaVersion: 1,
    sourceSha: sha,
    candidate: JSON.parse(process.env.SQLBRAID_CERT_CANDIDATE_JSON ?? "null"),
    prepared: JSON.parse(await readFile(resolve(preparedPath), "utf8")),
    status: "pass",
    checks: expectedSuites,
    testSuites: report.testResults.map((suite) => ({
      name: suite.name.replace(`${resolve(process.cwd())}/`, ""),
      status: suite.status,
    })),
  };
  validateEvidence(evidence, sha);
  const outputPath = evidencePath ?? option("--output");
  if (!outputPath) throw new Error("Global evidence derivation requires --output.");
  await writeFile(resolve(outputPath), `${JSON.stringify(evidence)}\n`);
  console.log(JSON.stringify(evidence));
} else if (evidencePath !== undefined) {
  const evidence = JSON.parse(await readFile(resolve(evidencePath), "utf8"));
  validateEvidence(evidence, sha);
  console.log(JSON.stringify(evidence));
} else {
  throw new Error("Global evidence requires --report or --evidence.");
}
