import { execFileSync } from "node:child_process";
import { inject, test } from "vitest";
import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../runner.js";
import { createMysql2NodeTarget, MYSQL2_EXPECTED_CAPABILITIES, MYSQL2_EXPECTED_TRANSACTION_OPTIONS } from "./mysql-mysql2.js";

test("MySQL mysql2 certifies the complete common contract", { timeout: 900_000 }, async () => {
  const settings = inject("mysql") as { readonly connectionUri: string };
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA
    ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const target = createMysql2NodeTarget(settings.connectionUri, sourceSha);
  const artifact = await certifyTarget(target, { stress: process.env.SQLBRAID_CERT_STRESS !== "0" });
  const output = process.env.SQLBRAID_CERT_ARTIFACT;
  if (output) await writeCertificationArtifact(output, artifact);
  validateCertificationArtifact(artifact, {
    sourceSha,
    expectedCapabilities: MYSQL2_EXPECTED_CAPABILITIES,
    expectedTransactionOptions: MYSQL2_EXPECTED_TRANSACTION_OPTIONS,
  });
});
