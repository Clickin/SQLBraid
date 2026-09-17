import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

test("global evidence rejects another candidate or changed prepared bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlbraid-global-evidence-"));
  const sourceSha = "a".repeat(40);
  const candidate = { sourceSha, preparedBuildSha256: "b".repeat(64), releaseManifestSha256: "c".repeat(64) };
  const prepared = { sourceSha, archiveSha256: candidate.preparedBuildSha256, distSha256: "d".repeat(64) };
  const suites = [
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
  const evidencePath = join(directory, "global.json");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/verify-global-evidence.mjs", "--source-sha", sourceSha, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        SQLBRAID_CERT_CANDIDATE_JSON: JSON.stringify(candidate),
        SQLBRAID_CERT_PREPARED_DIR: directory,
      },
    });
  try {
    writeFileSync(join(directory, "prepared.json"), JSON.stringify(prepared));
    writeFileSync(
      join(directory, "vitest.json"),
      JSON.stringify({
        success: true,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: suites.map((name) => ({ name: resolve(name), status: "passed" })),
      }),
    );
    const derived = run(
      "--report",
      join(directory, "vitest.json"),
      "--prepared-evidence",
      join(directory, "prepared.json"),
      "--output",
      evidencePath,
    );
    assert.equal(derived.status, 0, derived.stderr);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    writeFileSync(
      evidencePath,
      JSON.stringify({ ...evidence, candidate: { ...candidate, releaseManifestSha256: "e".repeat(64) } }),
    );
    const otherCandidate = run("--evidence", evidencePath);
    assert.notEqual(otherCandidate.status, 0);
    assert.match(otherCandidate.stderr, /candidate identity mismatch/u);
    writeFileSync(
      evidencePath,
      JSON.stringify({ ...evidence, prepared: { ...prepared, archiveSha256: "f".repeat(64) } }),
    );
    const changedArchive = run("--evidence", evidencePath);
    assert.notEqual(changedArchive.status, 0);
    assert.match(changedArchive.stderr, /verified prepared archive and dist digests/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
