#!/usr/bin/env bun
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { SQL } from "bun";
import { certifyTarget } from "../tests/certification/execute.ts";
import { REQUIRED_CASE_IDS } from "../tests/certification/types.ts";
import { expectedCapabilities, expectedGuardedCases, expectedTransactionOptions } from "../tests/certification/targets/bun-sql.ts";
import { validateCertificationArtifact } from "../tests/certification/runner.ts";

const dialects = ["postgres", "mysql", "mariadb", "sqlite"];
const envNames = {
  postgres: ["SQLBRAID_BUN_SQL_POSTGRES_URL", "SQLBRAID_POSTGRES_URL"],
  mysql: ["SQLBRAID_BUN_SQL_MYSQL_URL", "SQLBRAID_MYSQL_URL"],
  mariadb: ["SQLBRAID_BUN_SQL_MARIADB_URL", "SQLBRAID_MARIADB_URL", "MARIADB_URL"],
  sqlite: ["SQLBRAID_BUN_SQL_SQLITE_URL", "SQLBRAID_SQLITE_URL"],
};

function configuredUrl(dialect) {
  for (const name of envNames[dialect]) {
    if (process.env[name]) return process.env[name];
  }
  return dialect === "sqlite" ? ":memory:" : undefined;
}

function createClient(dialect, url) {
  if (dialect === "sqlite") return new SQL({ adapter: "sqlite", filename: url ?? ":memory:", safeIntegers: true });
  assert.ok(url, `Missing Bun.SQL ${dialect} URL; set ${envNames[dialect][0]}.`);
  return new SQL(url, { bigint: true });
}

async function createTarget(dialect, sourceSha) {
  const module = await import(`../tests/certification/targets/bun-sql-${dialect}.ts`);
  const url = configuredUrl(dialect);
  const createClientForTarget = () => createClient(dialect, url);
  const factory = module[`createBunSql${dialect[0].toUpperCase()}${dialect.slice(1)}Target`];
  assert.equal(typeof factory, "function", `Missing Bun certification target factory for ${dialect}.`);
  return factory(sourceSha, createClientForTarget);
}

function errorRecord(error) {
  if (error === null || typeof error !== "object") return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    feature: error.feature,
    rejectionFeature: error.rejectionFeature,
  };
}

const args = process.argv.slice(2);
const sourceShaIndex = args.indexOf("--source-sha");
const sourceSha = sourceShaIndex >= 0 ? args[sourceShaIndex + 1] : process.env.SQLBRAID_CERT_SOURCE_SHA;
const artifactIndex = args.indexOf("--artifact");
const artifactPath = artifactIndex >= 0 ? args[artifactIndex + 1] : process.env.SQLBRAID_CERT_ARTIFACT;
const stress = args.includes("--stress") || process.env.SQLBRAID_CERT_STRESS === "1";
const selected = args.filter((value, index) =>
  !value.startsWith("--")
  && (sourceShaIndex < 0 || index !== sourceShaIndex + 1)
  && (artifactIndex < 0 || index !== artifactIndex + 1),
);
assert.match(sourceSha ?? "", /^[0-9a-f]{40}$/iu, "Pass a full 40-character source SHA with --source-sha or SQLBRAID_CERT_SOURCE_SHA.");
const selectedDialects = selected.length === 0 ? dialects : selected;
for (const dialect of selectedDialects) assert.ok(dialects.includes(dialect), `Unknown Bun.SQL dialect: ${dialect}`);

const results = [];
let failed = false;
for (const dialect of selectedDialects) {
  try {
    const artifact = await certifyTarget(await createTarget(dialect, sourceSha), { stress });
    assert.equal(artifact.target, `bun-sql-${dialect}`);
    validateCertificationArtifact(artifact, {
      sourceSha,
      requiredCaseIds: REQUIRED_CASE_IDS,
      expectedCapabilities: expectedCapabilities(dialect),
      expectedTransactionOptions: expectedTransactionOptions(dialect),
      expectedGuardedCases: expectedGuardedCases(dialect),
    });
    const failures = Object.values(artifact.cases).filter((result) => result.status === "fail");
    if (failures.length > 0) failed = true;
    results.push({ target: `bun-sql-${dialect}`, artifact, failures: failures.map((result) => ({ name: result.name, error: result.error })) });
  } catch (error) {
    failed = true;
    results.push({ target: `bun-sql-${dialect}`, error: errorRecord(error) });
  }
}
const report = { runtime: { id: "bun", version: Bun.version }, sourceSha, results };
if (artifactPath) await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
