import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "vitest";
import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../runner.js";
import { createMariaDbCertificationTarget } from "./mariadb.js";
import { isSourceSha, REQUIRED_CASE_IDS } from "../types.js";
import { installedPackageVersion } from "../node-version.js";

test("rc3.mariadb.certification", async () => {
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  assert.ok(sourceSha && isSourceSha(sourceSha), "SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  const output = process.env.SQLBRAID_CERT_ARTIFACT;
  assert.ok(output, "SQLBRAID_CERT_ARTIFACT is required for certification artifacts.");
  const target = createMariaDbCertificationTarget(sourceSha, installedPackageVersion("mariadb"));
  const artifact = await certifyTarget(target, {
    stress: process.env.SQLBRAID_CERT_STRESS === "1" || process.env.SQLBRAID_CERT_STRESS === "true",
  });
  validateCertificationArtifact(artifact, {
    sourceSha,
    expectedCapabilities: target.expectedCapabilities,
    expectedTransactionOptions: target.expectedTransactionOptions,
  });
  await mkdir(dirname(output), { recursive: true });
  await writeCertificationArtifact(output, artifact);
  assert.equal(Object.keys(artifact.cases).length, REQUIRED_CASE_IDS.length);
  for (const id of REQUIRED_CASE_IDS) {
    assert.notEqual(artifact.cases[id]?.status, "fail", `${id}: ${artifact.cases[id]?.error ?? "failed"}`);
  }
});
