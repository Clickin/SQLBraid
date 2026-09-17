import assert from "node:assert/strict";
import { test } from "vitest";
import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../runner.js";
import { createMariaDbCertificationTarget } from "./mariadb.js";
import { REQUIRED_CASE_IDS } from "../types.js";

test("rc3.mariadb.certification", async () => {
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  assert.ok(sourceSha, "SQLBRAID_CERT_SOURCE_SHA must identify the tested candidate commit.");
  const target = createMariaDbCertificationTarget(sourceSha);
  const artifact = await certifyTarget(target, {
    stress: process.env.SQLBRAID_CERT_STRESS === "1" || process.env.SQLBRAID_CERT_STRESS === "true",
  });
  validateCertificationArtifact(artifact, {
    sourceSha,
    expectedCapabilities: target.expectedCapabilities,
    expectedTransactionOptions: target.expectedTransactionOptions,
  });
  if (process.env.SQLBRAID_CERT_ARTIFACT) await writeCertificationArtifact(process.env.SQLBRAID_CERT_ARTIFACT, artifact);
  assert.equal(Object.keys(artifact.cases).length, REQUIRED_CASE_IDS.length);
  for (const id of REQUIRED_CASE_IDS) {
    assert.notEqual(artifact.cases[id]?.status, "fail", `${id}: ${artifact.cases[id]?.error ?? "failed"}`);
  }
});
