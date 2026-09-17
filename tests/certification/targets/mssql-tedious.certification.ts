import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "vitest";
import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../runner.js";
import { createMssqlTediousTarget } from "./mssql-tedious.js";
import { isSourceSha, REQUIRED_CASE_IDS } from "../types.js";
import { installedPackageVersion } from "../node-version.js";

test("mssql-tedious certifies the independent real-database contract", { timeout: 30 * 60_000 }, async () => {
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  assert.ok(sourceSha && isSourceSha(sourceSha), "SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  const output = process.env.SQLBRAID_CERT_ARTIFACT;
  assert.ok(output, "SQLBRAID_CERT_ARTIFACT is required for certification artifacts.");
  const target = createMssqlTediousTarget(sourceSha, installedPackageVersion("tedious"));
  const artifact = await certifyTarget(target, {
    stress: process.env.SQLBRAID_CERT_STRESS === "1" || process.env.SQLBRAID_CERT_STRESS === "true",
  });
  validateCertificationArtifact(artifact, { sourceSha: target.sourceSha });
  assert.equal(Object.keys(artifact.cases).length, REQUIRED_CASE_IDS.length);
  assert.deepEqual(
    Object.values(artifact.cases)
      .map((result) => result.status)
      .filter((status) => status === "fail"),
    [],
  );
  await mkdir(dirname(output), { recursive: true });
  await writeCertificationArtifact(output, artifact);
});
