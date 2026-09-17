import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { aggregateCertificationArtifacts, writeCertificationAggregate } from "./runner.js";
import { CERTIFICATION_CONTRACTS } from "./contracts.js";
import { isSourceSha, type CertificationArtifact, type CertificationCandidateIdentity } from "./types.js";

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.name.endsWith(".json") && entry.name !== "aggregate.json") result.push(path);
  }
  return result;
}

test("aggregate the complete certification catalog", async () => {
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  const inputDirectory = process.env.SQLBRAID_CERT_AGGREGATE_INPUT;
  const outputPath = process.env.SQLBRAID_CERT_AGGREGATE_OUTPUT;
  if (!sourceSha || !isSourceSha(sourceSha))
    throw new Error("SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  if (!inputDirectory || !outputPath)
    throw new Error("SQLBRAID_CERT_AGGREGATE_INPUT and SQLBRAID_CERT_AGGREGATE_OUTPUT are required.");
  const artifacts = await Promise.all(
    (await files(resolve(inputDirectory))).map(
      async (path) => JSON.parse(await readFile(path, "utf8")) as CertificationArtifact,
    ),
  );
  const requiredTargets = Object.freeze(Object.keys(CERTIFICATION_CONTRACTS));
  const candidate =
    process.env.SQLBRAID_CERT_CANDIDATE_JSON === undefined
      ? undefined
      : (JSON.parse(process.env.SQLBRAID_CERT_CANDIDATE_JSON) as CertificationCandidateIdentity);
  const aggregate = aggregateCertificationArtifacts(artifacts, {
    sourceSha,
    requiredTargets,
    requiredTargetContracts: Object.fromEntries(
      requiredTargets.map((id) => [id, CERTIFICATION_CONTRACTS[id].expectedCapabilities]),
    ),
    requiredTargetOptionContracts: Object.fromEntries(
      requiredTargets.map((id) => [id, CERTIFICATION_CONTRACTS[id].expectedTransactionOptions]),
    ),
    requiredTargetGuardedCaseContracts: Object.fromEntries(
      requiredTargets.map((id) => [id, CERTIFICATION_CONTRACTS[id].expectedGuardedCases]),
    ),
    requiredTargetTuples: Object.fromEntries(requiredTargets.map((id) => [id, CERTIFICATION_CONTRACTS[id].tuple])),
    requiredCandidate: candidate,
  });
  await writeCertificationAggregate(resolve(outputPath), aggregate);
  await writeFile(
    `${resolve(outputPath)}.summary`,
    `${JSON.stringify({ targets: requiredTargets.length, cases: Object.values(aggregate.targets).reduce((total, artifact) => total + Object.keys(artifact.cases).length, 0) })}\n`,
  );
});
