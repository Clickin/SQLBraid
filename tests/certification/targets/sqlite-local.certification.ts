import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../runner.js";
import { betterSqlite3CertificationTarget } from "./sqlite-better-sqlite3.js";
import { libsqlCertificationTarget } from "./sqlite-libsql.js";
import { nodeSqliteCertificationTarget } from "./sqlite-node-sqlite.js";
import { REQUIRED_CASE_IDS } from "../types.js";

for (const target of [nodeSqliteCertificationTarget, betterSqlite3CertificationTarget, libsqlCertificationTarget]) {
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  if (!sourceSha) throw new Error("SQLBRAID_CERT_SOURCE_SHA is required for certification targets.");
  const candidate = { ...target, sourceSha };
  test(`RC3 certifies every common case for ${target.id}`, async () => {
    const artifact = await certifyTarget(candidate, { stress: process.env.SQLBRAID_CERT_STRESS === "true" });
    const artifactDirectory = process.env.SQLBRAID_CERT_ARTIFACT;
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await writeCertificationArtifact(join(artifactDirectory, `${target.id}.json`), artifact);
    }
    validateCertificationArtifact(artifact, { sourceSha });
    assert.deepEqual(Object.keys(artifact.cases).sort(), [...REQUIRED_CASE_IDS].sort());
    assert.equal(artifact.cases.CAP001.status, "pass");
    assert.equal(artifact.cases.CAP002.status, "pass");
  }, process.env.SQLBRAID_CERT_STRESS === "true" ? 300_000 : 120_000);
}
