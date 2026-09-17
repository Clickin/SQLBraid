import assert from "node:assert/strict";
import { test } from "vitest";
import { certifyTarget, validateCertificationArtifact } from "../../certification/runner.js";
import { mssqlTediousTarget } from "../../certification/targets/mssql-tedious.js";
import { REQUIRED_CASE_IDS } from "../../certification/types.js";

test("mssql-tedious certifies the independent real-database contract", { timeout: 30 * 60_000 }, async () => {
  const artifact = await certifyTarget(mssqlTediousTarget, { stress: process.env.SQLBRAID_CERT_STRESS === "1" });
  validateCertificationArtifact(artifact, { sourceSha: mssqlTediousTarget.sourceSha });
  assert.equal(Object.keys(artifact.cases).length, REQUIRED_CASE_IDS.length);
  assert.deepEqual(Object.values(artifact.cases).map((result) => result.status).filter((status) => status === "fail"), []);
});
