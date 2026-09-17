import assert from "node:assert/strict";
import { test } from "vitest";
import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../../certification/runner.js";
import { createMssqlTediousTarget } from "../../certification/targets/mssql-tedious.js";
import { REQUIRED_CASE_IDS } from "../../certification/types.js";

test("mssql-tedious certifies the independent real-database contract", { timeout: 30 * 60_000 }, async () => {
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  assert.ok(sourceSha, "SQLBRAID_CERT_SOURCE_SHA must identify the tested candidate commit.");
  const target = createMssqlTediousTarget(sourceSha);
  const artifact = await certifyTarget(target, { stress: process.env.SQLBRAID_CERT_STRESS === "1" });
  validateCertificationArtifact(artifact, { sourceSha: target.sourceSha });
  assert.equal(Object.keys(artifact.cases).length, REQUIRED_CASE_IDS.length);
  assert.deepEqual(Object.values(artifact.cases).map((result) => result.status).filter((status) => status === "fail"), []);
  if (process.env.SQLBRAID_CERT_ARTIFACT) await writeCertificationArtifact(process.env.SQLBRAID_CERT_ARTIFACT, artifact);
});
