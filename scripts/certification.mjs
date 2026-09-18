#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";

const root = resolve(new URL("..", import.meta.url).pathname);
const contractRegistry = await import(new URL("../tests/certification/contracts.ts", import.meta.url));
const requiredTargets = Object.freeze(Object.keys(contractRegistry.CERTIFICATION_CONTRACTS));
const nodeProjects = new Map([
  ["postgres-pg-node-16-4", "cert-pg"],
  ["postgres-current", "cert-pg"],
  ["mysql-mysql2-node-8-4-2", "cert-mysql"],
  ["mariadb-connector-node-11-8-9", "cert-mariadb"],
  ["oracle-oracledb-thin-node-23-9", "cert-oracle"],
  ["mssql-tedious-developer-node-2022-cu18", "cert-mssql"],
]);
const denoTargets = new Map([
  ["postgres-pg-deno-2-9-3", "tests/certification/targets/postgres-pg.deno.ts"],
  ["mysql-mysql2-deno-2-9-3", "tests/certification/targets/mysql-mysql2.deno.ts"],
  ["sqlite-node-sqlite-deno-2-9-3", "tests/certification/targets/sqlite-node-sqlite.deno.ts"],
]);
const bunTargets = new Map([
  ["bun-sql-postgres", "postgres"],
  ["bun-sql-mysql", "mysql"],
  ["bun-sql-mariadb", "mariadb"],
  ["bun-sql-sqlite", "sqlite"],
]);
let sqliteGroupComplete = false;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
function has(name) {
  return process.argv.includes(name);
}
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  return value;
}
function equalNormalized(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
function candidateWithoutSourceCheck() {
  const text = process.env.SQLBRAID_CERT_CANDIDATE_JSON;
  if (text === undefined) return undefined;
  const value = JSON.parse(text);
  if (
    value === null ||
    typeof value !== "object" ||
    !["source", "prepared", "release-prepared"].includes(value.kind) ||
    !/^[0-9a-f]{40}$/iu.test(value.sourceSha ?? "")
  ) {
    throw new Error("Candidate provenance must include a valid kind and exact source SHA.");
  }
  return value;
}
function checkedOutHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}
function sourceSha() {
  const value = option("--source-sha", process.env.SQLBRAID_CERT_SOURCE_SHA);
  if (!/^[0-9a-f]{40}$/iu.test(value ?? ""))
    throw new Error("Certification requires an exact 40-character --source-sha or SQLBRAID_CERT_SOURCE_SHA.");
  const head = checkedOutHead();
  const prepared = candidateWithoutSourceCheck();
  const preparedMode =
    process.env.SQLBRAID_CERT_PREPARED_DIR !== undefined &&
    (prepared?.kind === "prepared" || prepared?.kind === "release-prepared");
  if (head === undefined && !has("--verify-prepared") && !preparedMode) {
    throw new Error("Certification source SHA cannot be verified because the checkout has no readable git HEAD.");
  }
  if (head !== undefined && head.toLowerCase() !== value.toLowerCase()) {
    throw new Error(`Certification source SHA ${value} does not match checked-out HEAD ${head}.`);
  }
  return value;
}
function stress() {
  const value = process.env.SQLBRAID_CERT_STRESS;
  if (value !== undefined && !["0", "1", "false", "true"].includes(value))
    throw new Error("SQLBRAID_CERT_STRESS must be 0, 1, false, or true.");
  return has("--stress") || value === "1" || value === "true";
}
function candidate() {
  const value = candidateWithoutSourceCheck();
  if (value === undefined) return undefined;
  if (value.sourceSha !== sourceSha())
    throw new Error("Candidate provenance source SHA does not match certification source SHA.");
  return value;
}
function run(command, args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}.`)),
    );
  });
}
async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function hashTree(directory, relative = "", output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = join(relative, entry.name);
    if (entry.isDirectory()) await hashTree(path, name, output);
    else output.push([name, await readFile(path)]);
  }
  return output;
}
async function distSha() {
  const packages = await readdir(join(root, "packages"), { withFileTypes: true });
  const distFiles = [];
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, "packages", entry.name, "dist");
    try {
      await hashTree(directory, join(entry.name, "dist"), distFiles);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (distFiles.length === 0) throw new Error("Prepared build contains no package dist files.");
  const hash = createHash("sha256");
  for (const [name, content] of distFiles.sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name);
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
}
async function directorySha(directory) {
  const directoryFiles = await hashTree(directory);
  const hash = createHash("sha256");
  for (const [name, content] of directoryFiles.sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name);
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
}
async function preparedIntegrity() {
  const directory = process.env.SQLBRAID_CERT_PREPARED_DIR;
  const identity = candidate();
  if (!directory || identity === undefined) return undefined;
  const preparedBuild = join(resolve(directory), "prepared-build.tar.gz");
  const observedArchiveSha = await sha256(preparedBuild);
  if (observedArchiveSha !== identity.preparedBuildSha256) {
    throw new Error(
      `Prepared build checksum mismatch: expected ${identity.preparedBuildSha256}, received ${observedArchiveSha}.`,
    );
  }
  return { archiveSha256: observedArchiveSha, distSha256: await distSha() };
}
async function verifyPrepared() {
  const sha = sourceSha();
  const directory = resolve(
    option(
      "--candidate-dir",
      process.env.SQLBRAID_CERT_PREPARED_DIR ?? join(process.env.RUNNER_TEMP ?? "/tmp", "prepared"),
    ),
  );
  const identity = JSON.parse(await readFile(join(directory, "candidate.json"), "utf8"));
  if (identity.sourceSha !== sha || typeof identity.preparedBuildSha256 !== "string")
    throw new Error("Prepared candidate identity does not match the certification source SHA.");
  const archiveSha256 = await sha256(join(directory, "prepared-build.tar.gz"));
  if (archiveSha256 !== identity.preparedBuildSha256)
    throw new Error(
      `Prepared build checksum mismatch: expected ${identity.preparedBuildSha256}, received ${archiveSha256}.`,
    );
  const observedDistSha256 = await distSha();
  const expectedDistSha256 = option("--expected-dist-sha");
  if (expectedDistSha256 !== undefined && expectedDistSha256 !== observedDistSha256)
    throw new Error(`Prepared dist checksum mismatch: expected ${expectedDistSha256}, received ${observedDistSha256}.`);
  const output = { sourceSha: sha, archiveSha256, distSha256: observedDistSha256 };
  const outputPath = option("--output");
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  console.log(JSON.stringify(output));
}
async function tarManifest(path) {
  return new Promise((resolveManifest, reject) => {
    const child = spawn("tar", ["-xOf", path, "sqlbraid-release-artifacts/release-manifest.json"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolveManifest(JSON.parse(stdout))
        : reject(new Error(`Cannot read release manifest from ${path}: ${stderr}`)),
    );
  });
}
async function verifyCandidate() {
  const sha = sourceSha();
  const directory = resolve(
    option(
      "--candidate-dir",
      process.env.SQLBRAID_CERT_CANDIDATE_DIR ?? join(process.env.RUNNER_TEMP ?? "/tmp", "prepared"),
    ),
  );
  const candidateArchive = join(directory, "release-candidate.tar.gz");
  const preparedBuild = join(directory, "prepared-build.tar.gz");
  const [candidateSha, preparedSha, manifest] = await Promise.all([
    sha256(candidateArchive),
    sha256(preparedBuild),
    tarManifest(candidateArchive),
  ]);
  if (manifest.commit !== sha)
    throw new Error(`Release candidate manifest commit ${manifest.commit} does not match ${sha}.`);
  const runId = process.env.SQLBRAID_CERT_EXPECTED_RUN_ID ?? process.env.GITHUB_RUN_ID;
  const expectedCandidateValue = option("--expected-candidate", process.env.SQLBRAID_CERT_EXPECTED_CANDIDATE);
  const expectedCandidatePath =
    expectedCandidateValue === undefined || expectedCandidateValue === "" ? undefined : expectedCandidateValue;
  const runAttempt =
    process.env.SQLBRAID_CERT_EXPECTED_RUN_ATTEMPT ??
    (process.env.SQLBRAID_CERT_EXPECTED_RUN_ID === undefined ||
    process.env.SQLBRAID_CERT_EXPECTED_RUN_ID === process.env.GITHUB_RUN_ID
      ? process.env.GITHUB_RUN_ATTEMPT
      : undefined);
  if (runId !== undefined && String(manifest.runId) !== runId)
    throw new Error("Release candidate producer run does not match the current run.");
  if (runAttempt !== undefined && String(manifest.runAttempt) !== runAttempt)
    throw new Error("Release candidate producer attempt does not match the current run.");
  if (
    runId !== undefined &&
    process.env.GITHUB_RUN_ID !== undefined &&
    runId !== process.env.GITHUB_RUN_ID &&
    expectedCandidatePath === undefined
  ) {
    throw new Error("Cross-run release candidate verification requires the producer candidate identity.");
  }
  const packageDirectories = new Map();
  for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const packageManifest = JSON.parse(await readFile(join(root, "packages", entry.name, "package.json"), "utf8"));
      if (typeof packageManifest.name === "string") packageDirectories.set(packageManifest.name, entry.name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const extracted = await mkdtemp(join(tmpdir(), "sqlbraid-candidate-"));
  try {
    await run("tar", ["-xzf", candidateArchive, "-C", extracted]);
    await run("tar", ["-xzf", preparedBuild, "-C", extracted]);
    for (const entry of manifest.packages) {
      const packageDirectory = packageDirectories.get(entry.name);
      if (packageDirectory === undefined)
        throw new Error(`Release candidate package ${entry.name} has no workspace package.`);
      const packedDirectory = join(extracted, "packed", entry.name.replaceAll("/", "-"));
      await mkdir(packedDirectory, { recursive: true });
      await run("tar", ["-xzf", join(extracted, "sqlbraid-release-artifacts", entry.file), "-C", packedDirectory]);
      const preparedDist = join(extracted, "packages", packageDirectory, "dist");
      const packedDist = join(packedDirectory, "package", "dist");
      if ((await directorySha(preparedDist)) !== (await directorySha(packedDist)))
        throw new Error(`Release candidate ${entry.name} dist bytes do not match the prepared build.`);
    }
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
  const identity = {
    kind: "release-prepared",
    sourceSha: sha,
    producerRunId: String(manifest.runId ?? runId ?? ""),
    producerRunAttempt: String(manifest.runAttempt ?? runAttempt ?? ""),
    artifactName: "release-prepared",
    preparedBuildSha256: preparedSha,
    releaseCandidateSha256: candidateSha,
  };
  if (expectedCandidatePath !== undefined) {
    const expectedIdentity = JSON.parse(await readFile(resolve(expectedCandidatePath), "utf8"));
    if (!equalNormalized(expectedIdentity, identity))
      throw new Error(
        "Release candidate producer identity does not match its validated artifact manifest and digests.",
      );
  }
  const output = option("--output");
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(identity, null, 2)}\n`);
  }
  console.log(JSON.stringify(identity, null, 2));
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.name.endsWith(".json") && entry.name !== "aggregate.json") result.push(path);
  }
  return result;
}
async function aggregate() {
  const sha = sourceSha();
  const input = resolve(option("--input-dir", process.env.SQLBRAID_CERT_ARTIFACT_DIR ?? "/tmp/sqlbraid-certification"));
  const output = resolve(option("--output", join(input, "aggregate.json")));
  const artifacts = await Promise.all(
    (await files(input)).map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  if (artifacts.length !== requiredTargets.length)
    throw new Error(`Expected ${requiredTargets.length} certification artifacts, found ${artifacts.length}.`);
  await mkdir(dirname(output), { recursive: true });
  await run(
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.certification.config.ts", "--project", "cert-aggregate"],
    {
      SQLBRAID_CERT_SOURCE_SHA: sha,
      SQLBRAID_CERT_AGGREGATE_INPUT: input,
      SQLBRAID_CERT_AGGREGATE_OUTPUT: output,
      ...(candidate() === undefined ? {} : { SQLBRAID_CERT_CANDIDATE_JSON: JSON.stringify(candidate()) }),
    },
  );
  const summary = JSON.parse(await readFile(`${output}.summary`, "utf8"));
  console.log(`Certification aggregate passed: ${summary.targets} targets, ${summary.cases} cases.`);
}
async function attachCandidate(directory) {
  const identity = candidate();
  if (identity === undefined) return;
  for (const path of await files(directory)) {
    const artifact = JSON.parse(await readFile(path, "utf8"));
    if (!requiredTargets.includes(artifact.target)) continue;
    if (artifact.sourceSha !== identity.sourceSha)
      throw new Error(`Certification artifact ${artifact.target} has a candidate source SHA mismatch.`);
    artifact.provenance = { ...artifact.provenance, candidate: identity };
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }
}

async function certifyTarget(target) {
  const sha = sourceSha();
  const preparedBefore = await preparedIntegrity();
  const artifactDir = resolve(
    option(
      "--artifact-dir",
      process.env.SQLBRAID_CERT_ARTIFACT_DIR ?? join(process.env.RUNNER_TEMP ?? "/tmp", "sqlbraid-certification"),
    ),
  );
  await mkdir(artifactDir, { recursive: true });
  const commonEnv = {
    SQLBRAID_CERT_SOURCE_SHA: sha,
    SQLBRAID_CERT_STRESS: stress() ? "1" : "0",
    SQLBRAID_CERT_ARTIFACT_DIR: artifactDir,
  };
  if (nodeProjects.has(target)) {
    const setupEnv =
      target === "postgres-pg-node-16-4"
        ? { SQLBRAID_POSTGRES_TARGET: "postgres" }
        : target === "postgres-current"
          ? { SQLBRAID_POSTGRES_TARGET: "postgres-current" }
          : {};
    await run(
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.certification.config.ts", "--project", nodeProjects.get(target)],
      {
        ...commonEnv,
        ...setupEnv,
        SQLBRAID_CERT_TARGET: target,
        SQLBRAID_CERT_ARTIFACT: join(artifactDir, `${target}.json`),
      },
    );
    await attachCandidate(artifactDir);
    const preparedAfter = await preparedIntegrity();
    if (preparedBefore !== undefined && preparedBefore.distSha256 !== preparedAfter?.distSha256)
      throw new Error("Prepared build dist changed during certification.");
    return;
  }
  if (
    ["sqlite-node-sqlite-node-22-18-0", "better-sqlite3-node-22-18-0", "libsql-local-node-22-18-0"].includes(target)
  ) {
    const existing = new Set((await files(artifactDir)).map((path) => path.split("/").pop()));
    if (sqliteGroupComplete && existing.has(`${target}.json`)) {
      await attachCandidate(artifactDir);
      return;
    }
    await run(
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.certification.config.ts", "--project", "cert-sqlite"],
      { ...commonEnv, SQLBRAID_CERT_ARTIFACT: artifactDir },
    );
    sqliteGroupComplete = true;
    await attachCandidate(artifactDir);
    const preparedAfter = await preparedIntegrity();
    if (preparedBefore !== undefined && preparedBefore.distSha256 !== preparedAfter?.distSha256)
      throw new Error("Prepared build dist changed during certification.");
    return;
  }
  if (denoTargets.has(target)) {
    const env = {
      ...commonEnv,
      SQLBRAID_CERT_TARGET: target,
      SQLBRAID_CERT_ARTIFACT: join(artifactDir, `${target}.json`),
    };
    await run(
      "deno",
      ["run", "--allow-all", "--no-lock", "--node-modules-dir=manual", "--sloppy-imports", denoTargets.get(target)],
      env,
    );
    await attachCandidate(artifactDir);
    const preparedAfter = await preparedIntegrity();
    if (preparedBefore !== undefined && preparedBefore.distSha256 !== preparedAfter?.distSha256)
      throw new Error("Prepared build dist changed during certification.");
    return;
  }
  if (bunTargets.has(target)) {
    await run(
      "bun",
      [
        "tests/scripts/bun-sql-certification.mjs",
        "--source-sha",
        sha,
        "--artifact",
        join(artifactDir, `${target}.json`),
        bunTargets.get(target),
      ],
      commonEnv,
    );
    await attachCandidate(artifactDir);
    const preparedAfter = await preparedIntegrity();
    if (preparedBefore !== undefined && preparedBefore.distSha256 !== preparedAfter?.distSha256)
      throw new Error("Prepared build dist changed during certification.");
    return;
  }
  if (target === "d1-cloudflare-workerd-2026-07-30") {
    await run("pnpm", ["run", "test:d1"], {
      ...commonEnv,
      SQLBRAID_CERT_ARTIFACT: join(artifactDir, `${target}.json`),
    });
    await attachCandidate(artifactDir);
    const preparedAfter = await preparedIntegrity();
    if (preparedBefore !== undefined && preparedBefore.distSha256 !== preparedAfter?.distSha256)
      throw new Error("Prepared build dist changed during certification.");
    return;
  }
  if (target === "sqlite-wasm-browser-3-53-4") {
    await run("pnpm", ["run", "test:browser"], {
      ...commonEnv,
      SQLBRAID_CERT_ARTIFACT: join(artifactDir, `${target}.json`),
    });
    await attachCandidate(artifactDir);
    const preparedAfter = await preparedIntegrity();
    if (preparedBefore !== undefined && preparedBefore.distSha256 !== preparedAfter?.distSha256)
      throw new Error("Prepared build dist changed during certification.");
    return;
  }
  throw new Error(`Unknown certification target: ${target}`);
}
async function validateArtifact() {
  const sha = sourceSha();
  const artifactPath = option("--artifact", process.env.SQLBRAID_CERT_VALIDATE_ARTIFACT);
  if (!artifactPath) throw new Error("Certification artifact validation requires --artifact.");
  await run(
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.certification.config.ts", "--project", "cert-validate"],
    {
      SQLBRAID_CERT_SOURCE_SHA: sha,
      SQLBRAID_CERT_VALIDATE_ARTIFACT: resolve(artifactPath),
    },
  );
}
async function certifyAll() {
  const requested = option("--target");
  const targets = requested ? [requested] : requiredTargets;
  for (const target of targets) {
    if (!requiredTargets.includes(target)) throw new Error(`Unknown certification target: ${target}`);
    await certifyTarget(target);
  }
  if (!requested) await aggregate();
}
if (has("--validate")) await validateArtifact();
else if (has("--verify-candidate")) await verifyCandidate();
else if (has("--verify-prepared")) await verifyPrepared();
else if (has("--aggregate")) await aggregate();
else await certifyAll();
