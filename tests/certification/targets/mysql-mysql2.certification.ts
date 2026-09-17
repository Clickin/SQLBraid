import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { inject, test } from "vitest";
import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../runner.js";
import { isSourceSha } from "../types.js";
import { MYSQL2_EXPECTED_CAPABILITIES, MYSQL2_EXPECTED_TRANSACTION_OPTIONS } from "../contracts.js";
import { createMysql2NodeTarget } from "./mysql-mysql2.js";
import { installedPackageVersion } from "../node-version.js";

test("MySQL mysql2 certifies the complete common contract", { timeout: 900_000 }, async () => {
  const settings = inject("mysql") as { readonly connectionUri: string };
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  if (!sourceSha || !isSourceSha(sourceSha)) throw new Error("SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  const target = createMysql2NodeTarget(settings.connectionUri, sourceSha, installedPackageVersion("mysql2"));
  const artifact = await certifyTarget(target, { stress: process.env.SQLBRAID_CERT_STRESS === "1" || process.env.SQLBRAID_CERT_STRESS === "true" });
  const output = process.env.SQLBRAID_CERT_ARTIFACT;
  if (!output) throw new Error("SQLBRAID_CERT_ARTIFACT is required for certification artifacts.");
  validateCertificationArtifact(artifact, {
    sourceSha,
    expectedCapabilities: MYSQL2_EXPECTED_CAPABILITIES,
    expectedTransactionOptions: MYSQL2_EXPECTED_TRANSACTION_OPTIONS,
  });
  await mkdir(dirname(output), { recursive: true });
  await writeCertificationArtifact(output, artifact);
});
