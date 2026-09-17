import { inject, test } from "vitest";
import { certifyTarget } from "../../certification/runner.js";
import { validateCertificationArtifact, writeCertificationArtifact } from "../../certification/runner.js";
import { createPostgresTarget, disposePostgresTarget } from "../../certification/targets/postgres-pg.js";
import { writeFile } from "node:fs/promises";

test("PostgreSQL certification target executes all required cases", { timeout: 1_800_000 }, async () => {
  const targetId = (process.env.SQLBRAID_CERT_TARGET ?? "postgres-pg-node-16-4") as "postgres-pg-node-16-4" | "postgres-current" | "postgres-pg-deno-2-9-3";
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  if (!sourceSha) throw new Error("SQLBRAID_CERT_SOURCE_SHA is required for certification artifacts.");
  const target = createPostgresTarget(targetId, inject("postgres").connectionUri, sourceSha);
  try {
    const artifact = await certifyTarget(target, { stress: process.env.SQLBRAID_CERT_STRESS === "true" });
    const resultPath = process.env.SQLBRAID_CERT_ARTIFACT ?? `/tmp/sqlbraid-rc3-pg-${targetId}.json`;
    await writeCertificationArtifact(resultPath, artifact);
    await writeFile(
      "/tmp/sqlbraid-rc3-pg-result.md",
      `# PostgreSQL certification result\n\n- target: ${artifact.target}\n- sourceSha: ${artifact.sourceSha}\n- cases: ${Object.keys(artifact.cases).length}\n- failures: ${Object.values(artifact.cases).filter((result) => result.status === "fail").length}\n- artifact: ${resultPath}\n`,
      "utf8",
    );
    validateCertificationArtifact(artifact, { sourceSha });
  } finally {
    await disposePostgresTarget(targetId);
  }
});
