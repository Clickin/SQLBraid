import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../runner.js";
import { betterSqlite3CertificationTarget } from "./sqlite-better-sqlite3.js";
import { libsqlCertificationTarget } from "./sqlite-libsql.js";
import { nodeSqliteCertificationTarget } from "./sqlite-node-sqlite.js";
import { isSourceSha, REQUIRED_CASE_IDS } from "../types.js";
import { installedPackageVersion } from "../node-version.js";

const stress = process.env.SQLBRAID_CERT_STRESS === "1" || process.env.SQLBRAID_CERT_STRESS === "true";

for (const target of [nodeSqliteCertificationTarget, betterSqlite3CertificationTarget, libsqlCertificationTarget]) {
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  if (!sourceSha || !isSourceSha(sourceSha)) throw new Error("SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  const artifactDirectory = process.env.SQLBRAID_CERT_ARTIFACT;
  if (!artifactDirectory) throw new Error("SQLBRAID_CERT_ARTIFACT is required for certification targets.");
  const measuredDriverVersion = target.id === "sqlite-node-sqlite-node-22-18-0"
    ? process.versions.node
    : target.id === "better-sqlite3-node-22-18-0"
      ? installedPackageVersion("better-sqlite3")
      : installedPackageVersion("@libsql/client");
  const candidate = { ...target, sourceSha, measuredDriverVersion };
  test(`RC3 certifies every common case for ${target.id}`, async () => {
    const artifact = await certifyTarget(candidate, { stress });
    validateCertificationArtifact(artifact, { sourceSha });
    assert.deepEqual(Object.keys(artifact.cases).sort(), [...REQUIRED_CASE_IDS].sort());
    assert.equal(artifact.cases.CAP001.status, "pass");
    assert.equal(artifact.cases.CAP002.status, "pass");
    await mkdir(artifactDirectory, { recursive: true });
    await writeCertificationArtifact(join(artifactDirectory, `${target.id}.json`), artifact);
  }, stress ? 300_000 : 120_000);
}
