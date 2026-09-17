import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { validateCertificationArtifact } from "./runner.js";
import { isSourceSha } from "./types.js";

test("validate certification artifact", async () => {
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  const artifactPath = process.env.SQLBRAID_CERT_VALIDATE_ARTIFACT;
  if (!sourceSha || !isSourceSha(sourceSha))
    throw new Error("SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  if (!artifactPath) throw new Error("SQLBRAID_CERT_VALIDATE_ARTIFACT is required.");
  validateCertificationArtifact(JSON.parse(await readFile(artifactPath, "utf8")), { sourceSha });
});
