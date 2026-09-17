import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFile } from "node:fs/promises";
import { inject, test } from "vitest";
import { certifyTarget, validateCertificationArtifact } from "../runner.js";
import { createOracleOracledbTarget } from "./oracle-oracledb.js";
import { isSourceSha, type CertificationArtifact } from "../types.js";

const SOURCE_SHA = process.env.SQLBRAID_CERT_SOURCE_SHA;

test("Oracle node-oracledb passes the complete independent certification matrix", { timeout: 1_800_000 }, async () => {
  if (!SOURCE_SHA || !isSourceSha(SOURCE_SHA)) throw new Error("SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  const artifactPath = process.env.SQLBRAID_CERT_ARTIFACT;
  if (!artifactPath) throw new Error("SQLBRAID_CERT_ARTIFACT is required for Oracle certification.");
  const settings = inject("oracle");
  const target = await createOracleOracledbTarget({
    connectionUri: settings.connectionUri,
    user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
    password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
    sourceSha: SOURCE_SHA,
  });
  let artifact: CertificationArtifact | undefined;
  try {
    artifact = await certifyTarget(target, { stress: process.env.SQLBRAID_CERT_STRESS === "1" || process.env.SQLBRAID_CERT_STRESS === "true" });
    validateCertificationArtifact(artifact, {
      sourceSha: SOURCE_SHA,
      expectedCapabilities: target.expectedCapabilities,
      expectedTransactionOptions: target.expectedTransactionOptions,
    });
    const failures = Object.values(artifact.cases).filter((result) => result.status === "fail");
    assert.deepEqual(failures, []);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      "/tmp/sqlbraid-rc3-oracle-result.md",
      [
        "# SQLBraid RC3 B4 Oracle certification",
        "",
        `- target: ${artifact.target}`,
        `- sourceSha: ${artifact.sourceSha}`,
        `- cases: ${Object.keys(artifact.cases).length}`,
        `- passed: ${Object.values(artifact.cases).filter((result) => result.status === "pass").length}`,
        `- unsupported: ${Object.values(artifact.cases).filter((result) => result.status === "pass-unsupported").length}`,
        "",
        "```text",
        ...Object.values(artifact.cases).map((result) => `${result.status}\t${result.name}${result.code ? `\t${result.code}` : ""}`),
        "```",
        "",
        "Raw evidence: Oracle Testcontainers fixture, direct and pooled Database handles, independent capability and transaction-option declarations.",
        "",
      ].join("\n"),
      "utf8",
    );
  } finally {
    await target.close();
  }
});
