import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inject, test } from "vitest";
import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../runner.js";
import { createPostgresTarget, disposePostgresTarget } from "./postgres-pg.js";
import { isSourceSha } from "../types.js";
import { installedPackageVersion } from "../node-version.js";

test("PostgreSQL certification target executes all required cases", { timeout: 1_800_000 }, async () => {
  const targetId = (process.env.SQLBRAID_CERT_TARGET ?? "postgres-pg-node-16-4") as
    | "postgres-pg-node-16-4"
    | "postgres-current"
    | "postgres-pg-deno-2-9-3";
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  if (!sourceSha || !isSourceSha(sourceSha))
    throw new Error("SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  const artifactPath = process.env.SQLBRAID_CERT_ARTIFACT;
  if (!artifactPath) throw new Error("SQLBRAID_CERT_ARTIFACT is required for certification artifacts.");
  const target = createPostgresTarget(
    targetId,
    inject("postgres").connectionUri,
    sourceSha,
    installedPackageVersion("pg"),
  );
  try {
    const artifact = await certifyTarget(target, {
      stress: process.env.SQLBRAID_CERT_STRESS === "1" || process.env.SQLBRAID_CERT_STRESS === "true",
    });
    validateCertificationArtifact(artifact, { sourceSha });
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeCertificationArtifact(artifactPath, artifact);
    await writeFile(
      "/tmp/sqlbraid-rc3-pg-result.md",
      `# PostgreSQL certification result\n\n- target: ${artifact.target}\n- sourceSha: ${artifact.sourceSha}\n- cases: ${Object.keys(artifact.cases).length}\n- failures: ${Object.values(artifact.cases).filter((result) => result.status === "fail").length}\n- artifact: ${artifactPath}\n`,
      "utf8",
    );
  } finally {
    await disposePostgresTarget(targetId);
  }
});
