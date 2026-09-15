import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareSemVer, isSemVer } from "./docs-history.mjs";
import { assertNoPriorStageAttempt, assertReleaseWorkflows } from "./assert-release-workflows.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageManager = rootManifest.packageManager;
const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageManager ?? "")?.[1];
if (!pnpmVersion) throw new Error("Release requires an exact pnpm version in package.json#packageManager.");
let version = process.env.SQLBRAID_RELEASE_VERSION ?? rootManifest.version;
let semver = parseSemver(version);
let expectedTag = `v${version}`;
const packageFields = ["dependencies", "optionalDependencies", "peerDependencies"];
const artifactArgument = option("--artifact-dir", process.env.SQLBRAID_RELEASE_ARTIFACT_DIR);
let artifactDir = resolve(artifactArgument ?? join(tmpdir(), `sqlbraid-release-${version}`));
const registry = "https://registry.npmjs.org/";

function option(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function parseSemver(value) {
  const match = isSemVer(value) && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value);
  if (!match) throw new Error(`Invalid release version ${value}; expected a SemVer version.`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
    isPrerelease: Boolean(match[4]),
  };
}

function releasePrereleaseArg(value) {
  return parseSemver(value).isPrerelease ? "--prerelease" : undefined;
}

function releaseTag() {
  return semver.isPrerelease ? "next" : `release-${version}`;
}

function candidateIdentity(manifest) {
  return {
    version: manifest.version,
    commit: manifest.commit,
    extension: manifest.extension ?? null,
    packages: manifest.packages,
  };
}

function candidateIdentityDigest(manifest) {
  return createHash("sha256").update(JSON.stringify(candidateIdentity(manifest))).digest("hex");
}

function commandErrorText(error) {
  return [error?.message, error?.code, error?.stdout, error?.stderr].filter((value) => typeof value === "string").join("\n");
}

function registryNotFound(error) {
  return /\b(?:E404|ERR_PNPM_FETCH_404|ERR_PNPM_PACKAGE_NOT_FOUND)\b|404 Not Found|No matching version found|No match found/iu.test(commandErrorText(error));
}

async function defaultCommand(file, args, cwd = root, { quiet = false } = {}) {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  if (!quiet && stderr.trim()) process.stderr.write(stderr);
  if (!quiet && stdout.trim()) process.stdout.write(stdout);
  return stdout;
}

let command = defaultCommand;
async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function packageManifests() {
  const entries = await readdir(join(root, "packages"), { withFileTypes: true });
  const manifests = [];
  for (const entry of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, "packages", entry.name, "package.json");
    try {
      manifests.push({ directory: dirname(path), path, manifest: await json(path) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (manifests.length === 0) throw new Error("No publishable package manifests found under packages/.");
  return manifests;
}

function workspaceDependencyNames(manifest) {
  return packageFields.flatMap((field) => Object.entries(manifest[field] ?? {})
    .filter(([, specifier]) => typeof specifier === "string" && specifier.startsWith("workspace:"))
    .map(([name]) => name));
}

function publishOrder(packages) {
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
  if (byName.size !== packages.length) throw new Error("Duplicate package names prevent deterministic publication.");
  const dependencies = new Map(packages.map((entry) => [entry.manifest.name, new Set()]));
  const dependents = new Map(packages.map((entry) => [entry.manifest.name, new Set()]));
  for (const entry of packages) {
    for (const dependency of workspaceDependencyNames(entry.manifest)) {
      if (!byName.has(dependency)) throw new Error(`${entry.manifest.name} references missing workspace package ${dependency}.`);
      dependencies.get(entry.manifest.name).add(dependency);
      dependents.get(dependency).add(entry.manifest.name);
    }
  }
  const ready = [...dependencies].filter(([, values]) => values.size === 0).map(([name]) => name).sort();
  const order = [];
  while (ready.length > 0) {
    const name = ready.shift();
    order.push(name);
    for (const dependent of [...dependents.get(name)].sort()) {
      const remaining = dependencies.get(dependent);
      remaining.delete(name);
      if (remaining.size === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== packages.length) {
    const cycle = [...dependencies].filter(([, values]) => values.size > 0).map(([name]) => name).sort();
    throw new Error(`Workspace dependency cycle prevents publication: ${cycle.join(", ")}.`);
  }
  return order;
}

async function assertCleanTree() {
  const status = await command("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.trim()) throw new Error("Release requires a clean git tree.");
}

async function currentSha() {
  const head = (await command("git", ["rev-parse", "HEAD"])).trim();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) throw new Error(`Workflow SHA ${process.env.GITHUB_SHA} does not equal checked out HEAD ${head}.`);
  return head;
}

async function assertTaggedSha() {
  const ref = process.env.GITHUB_REF ?? `refs/tags/${process.env.GITHUB_REF_NAME ?? ""}`;
  if (ref !== `refs/tags/${expectedTag}`) throw new Error(`Final release must run from tag ${expectedTag}; found ${ref || "no tag"}.`);
  const head = await currentSha();
  if (process.env.GITHUB_ACTIONS === "true" && !process.env.GITHUB_SHA) throw new Error("GitHub release publication requires GITHUB_SHA.");
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) throw new Error(`Workflow SHA ${process.env.GITHUB_SHA} does not equal checked out HEAD ${head}.`);
  const tagged = (await command("git", ["rev-list", "-n", "1", `refs/tags/${expectedTag}`])).trim();
  if (!tagged || tagged !== head) throw new Error(`Tag ${expectedTag} does not point at HEAD (${head}).`);
  const previous = process.env.SQLBRAID_TAG_BEFORE;
  if (previous && !/^0+$/u.test(previous) && previous !== head) {
    throw new Error(`Candidate tag ${expectedTag} moved from ${previous} to ${head}; create a new release candidate version instead of reusing the tag.`);
  }
  return head;
}

async function assertVersions(packages) {
  const mismatches = [];
  if (rootManifest.version !== version) mismatches.push(`workspace@${rootManifest.version}`);
  mismatches.push(...packages
    .filter(({ manifest }) => manifest.version !== version)
    .map(({ manifest }) => `${manifest.name}@${manifest.version}`));
  const extension = await json(join(root, "extensions", "vscode", "package.json"));
  if (extension.version !== version) mismatches.push(`${extension.name}@${extension.version}`);
  if (mismatches.length > 0) throw new Error(`All first-party packages must be synchronized at ${version}: ${mismatches.join(", ")}.`);
}

async function tarballFiles() {
  return (await readdir(artifactDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => join(artifactDir, entry.name));
}

async function tarballManifest(path) {
  const content = await command("tar", ["-xOf", path, "package/package.json"], root, { quiet: true });
  return JSON.parse(content);
}

async function validateTarball(path, packageNames) {
  const manifest = await tarballManifest(path);
  if (!packageNames.has(manifest.name)) throw new Error(`Unexpected package in ${path}: ${manifest.name}.`);
  if (manifest.version !== version) throw new Error(`${manifest.name} in ${path} is ${manifest.version}, expected ${version}.`);
  if (JSON.stringify(manifest).includes("workspace:")) throw new Error(`${path} leaks a workspace: dependency.`);
  const listing = await command("tar", ["-tf", path], root, { quiet: true });
  for (const required of ["package/package.json", "package/README.md", "package/LICENSE"]) {
    if (!listing.split("\n").includes(required)) throw new Error(`${path} does not contain ${required}.`);
  }
  return manifest;
}

async function hash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function integrity(path) {
  return `sha512-${createHash("sha512").update(await readFile(path)).digest("base64")}`;
}

async function pack(packages, order, sha) {
  await assertPnpmVersion();
  await mkdir(artifactDir, { recursive: true });
  if (process.env.GITHUB_ACTIONS === "true" && (!process.env.GITHUB_RUN_ID || !process.env.GITHUB_RUN_ATTEMPT)) {
    throw new Error("GitHub release candidates require GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT.");
  }
  const existing = await readdir(artifactDir, { withFileTypes: true });
  const conflicting = existing
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".tgz") || entry.name === "release-manifest.json" || entry.name === "pack-check-success.json"))
    .map((entry) => entry.name);
  if (conflicting.length > 0) {
    throw new Error(`Release artifact directory already contains validated outputs: ${conflicting.join(", ")}. Use a new directory.`);
  }
  const packageNames = new Set(packages.map(({ manifest }) => manifest.name));
  const tarballs = new Map();
  for (const entry of packages) {
    const before = new Set(await tarballFiles());
    await command("pnpm", ["pack", "--pack-destination", artifactDir], entry.directory);
    const added = (await tarballFiles()).filter((path) => !before.has(path));
    if (added.length !== 1) throw new Error(`Expected one tarball for ${entry.manifest.name}; found ${added.length}.`);
    await validateTarball(added[0], packageNames);
    tarballs.set(entry.manifest.name, added[0]);
  }
  const manifest = {
    version,
    commit: sha,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    packages: order.map((name) => ({ name, version, file: basename(tarballs.get(name)), sha256: null, integrity: null,
      dependencies: [...new Set(workspaceDependencyNames(packages.find((entry) => entry.manifest.name === name).manifest))].sort() })),
  };
  for (const entry of manifest.packages) {
    const path = join(artifactDir, entry.file);
    entry.sha256 = await hash(path);
    entry.integrity = await integrity(path);
  }
  await writeFile(join(artifactDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Preserved ${manifest.packages.length} validated tarballs in ${artifactDir}.\n`);
  return manifest;
}

function assertExtensionIdentity(extension) {
  if (!extension || typeof extension !== "object"
    || typeof extension.file !== "string" || basename(extension.file) !== extension.file
    || !/^[a-f\d]{64}$/u.test(extension.sha256 ?? "")
    || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(extension.integrity ?? "")
    || typeof extension.version !== "string" || extension.version !== version
    || typeof extension.publisher !== "string" || !extension.publisher
    || typeof extension.name !== "string" || !extension.name
    || !extension.bundled || typeof extension.bundled.cli !== "string"
    || typeof extension.bundled.languageServer !== "string"
    || extension.bundled.cli !== version || extension.bundled.languageServer !== version) {
    throw new Error("Invalid release manifest VSIX identity, version, or hashes.");
  }
}

function assertManifestIdentity(manifest, { requireExtension = false } = {}) {
  if (manifest.version !== version || !/^[a-f\d]{40}$/u.test(manifest.commit ?? "")
    || !Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error("Invalid release-manifest.json.");
  if (requireExtension || manifest.extension !== undefined) assertExtensionIdentity(manifest.extension);
  const names = new Set();
  for (const entry of manifest.packages) {
    if (!entry || typeof entry.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(entry.name)
      || names.has(entry.name) || entry.version !== version
      || typeof entry.sha256 !== "string" || !/^[a-f\d]{64}$/u.test(entry.sha256)
      || typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity)) {
      throw new Error("Invalid release manifest package identity, version, or hashes.");
    }
    names.add(entry.name);
  }
}

async function readReleaseManifest(directory = artifactDir, { priorCandidateRunId, allowCurrentAttemptMismatch = false } = {}) {
  const manifest = await json(join(directory, "release-manifest.json"));
  assertManifestIdentity(manifest, { requireExtension: true });
  if (priorCandidateRunId !== undefined) {
    if (!/^\d+$/u.test(String(priorCandidateRunId))
      || !/^\d+$/u.test(manifest.runId ?? "") || !/^\d+$/u.test(manifest.runAttempt ?? "")) {
      throw new Error("Validated release artifacts do not belong to the requested prior candidate run.");
    }
  } else {
    if (process.env.GITHUB_RUN_ID && manifest.runId !== process.env.GITHUB_RUN_ID) throw new Error(`Validated release artifacts belong to run ${manifest.runId ?? "unknown"}, not ${process.env.GITHUB_RUN_ID}.`);
    if (!allowCurrentAttemptMismatch && process.env.GITHUB_RUN_ATTEMPT && manifest.runAttempt !== process.env.GITHUB_RUN_ATTEMPT) throw new Error(`Validated release artifacts belong to attempt ${manifest.runAttempt ?? "unknown"}, not ${process.env.GITHUB_RUN_ATTEMPT}.`);
  }
  const files = new Set();
  const packageNames = new Set(manifest.packages.map(({ name }) => name));
  for (const entry of manifest.packages) {
    if (typeof entry.file !== "string" || basename(entry.file) !== entry.file || files.has(entry.file)) {
      throw new Error("Invalid release-manifest.json package entries.");
    }
    files.add(entry.file);
    const path = join(directory, entry.file);
    const actualSha = await hash(path);
    if (actualSha !== entry.sha256) throw new Error(`Validated tarball changed: ${entry.file}.`);
    const actualIntegrity = await integrity(path);
    if (actualIntegrity !== entry.integrity) throw new Error(`Validated tarball integrity changed: ${entry.file}.`);
    const packedManifest = await validateTarball(path, packageNames);
    if (packedManifest.name !== entry.name) throw new Error(`Candidate package identity mismatch: ${entry.file}.`);
    const dependencies = [...new Set(packageFields.flatMap((field) => Object.keys(packedManifest[field] ?? {}))
      .filter((name) => packageNames.has(name)))].sort();
    if (!Array.isArray(entry.dependencies) || JSON.stringify(entry.dependencies) !== JSON.stringify(dependencies)) {
      throw new Error(`Candidate dependency evidence mismatch: ${entry.file}.`);
    }
  }
  const extensionPath = join(directory, manifest.extension.file);
  if (await hash(extensionPath) !== manifest.extension.sha256) throw new Error(`Validated VSIX changed: ${manifest.extension.file}.`);
  if (await integrity(extensionPath) !== manifest.extension.integrity) throw new Error(`Validated VSIX integrity changed: ${manifest.extension.file}.`);
  const stamp = await json(join(directory, "pack-check-success.json"));
  if (stamp.version !== version || stamp.commit !== manifest.commit || !Array.isArray(stamp.packages) || stamp.packages.length !== manifest.packages.length) {
    throw new Error("Release artifacts do not have a matching successful pack-check stamp.");
  }
  const stampPackages = stamp.packages.map(({ name, sha256 }) => `${name}:${sha256}`).sort().join("\n");
  const manifestPackages = manifest.packages.map(({ name, sha256 }) => `${name}:${sha256}`).sort().join("\n");
  if (stampPackages !== manifestPackages) throw new Error("Pack-check stamp does not match validated release tarball hashes.");
  if (JSON.stringify(stamp.extension) !== JSON.stringify(manifest.extension)) throw new Error("Pack-check stamp does not match validated VSIX identity.");
  return manifest;
}

function assertManifestOrder(manifest, order) {
  if (manifest.packages.map(({ name }) => name).join("\n") !== order.join("\n")) {
    throw new Error("Validated release artifacts do not match the current dependency-derived package order.");
  }
}

function pnpmArgs(args, { registryArg = true } = {}) {
  return [...args, ...(registryArg ? ["--registry", registry] : [])];
}

async function pnpm(args, cwd = root, options = {}) {
  return command("pnpm", pnpmArgs(args, options), cwd, options);
}

async function assertPnpmVersion() {
  const actual = (await pnpm(["--version"], root, { registryArg: false, quiet: true })).trim();
  if (actual !== pnpmVersion) throw new Error(`Release requires pnpm ${pnpmVersion}; found ${actual || "unknown"}.`);
}

async function assertOfficialRegistry() {
  const configured = (await pnpm(["config", "get", "registry"], root, { registryArg: false, quiet: true })).trim().replace(/\/?$/u, "/");
  if (configured !== registry) throw new Error(`pnpm registry must be ${registry}; found ${configured || "empty"}.`);
  await pnpm(["ping"], root, { quiet: true });
}

async function pnpmView(spec, field) {
  try {
    const output = await pnpm(["view", spec, field, "--json"], root, { quiet: true });
    if (!output.trim() || output.trim() === "null") return undefined;
    return JSON.parse(output);
  } catch (error) {
    if (registryNotFound(error)) return undefined;
    throw error;
  }
}

async function registryIntegrity(name, releaseVersion) {
  const spec = `${name}@${releaseVersion}`;
  const value = await pnpmView(spec, "dist.integrity");
  if (!value && await pnpmView(spec, "version")) throw new Error(`Registry integrity is missing for existing ${spec}.`);
  return typeof value === "string" && value ? value : undefined;
}

async function registryDistTags(name) {
  const value = await pnpmView(name, "dist-tags");
  return value && typeof value === "object" ? value : {};
}

async function assertRegistryIntegrity(entry) {
  const found = await registryIntegrity(entry.name, version);
  if (found !== entry.integrity) throw new Error(`Registry integrity mismatch for ${entry.name}@${version}: expected ${entry.integrity}, found ${found ?? "absent"}.`);
}

function assertStageId(id) {
  if (typeof id !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(id)) throw new Error("Missing or invalid npm stage ID.");
  return id;
}

function manifestDigest(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function createReleaseEvidence(manifest, staged, {
  directory = artifactDir,
  supportEvidencePath,
  targetEvidenceDirectory,
  stagedEvidencePath,
} = {}) {
  assertManifestIdentity(manifest, { requireExtension: true });
  assertStagingEvidence(manifest, staged, { expectedRunId: staged.runId, expectedRunAttempt: staged.runAttempt });
  if (!supportEvidencePath || !targetEvidenceDirectory || !stagedEvidencePath) {
    throw new Error("Durable release evidence requires support, target, and staged evidence paths.");
  }
  for (const entry of [...manifest.packages, manifest.extension]) {
    const path = join(directory, entry.file);
    if (await hash(path) !== entry.sha256 || await integrity(path) !== entry.integrity) {
      throw new Error(`Durable release evidence cannot include changed artifact: ${entry.file}.`);
    }
  }
  const supportPath = resolve(supportEvidencePath);
  const support = await json(supportPath);
  if (support.format !== "sqlbraid-support-evidence" || support.version !== 1
    || support.commit !== manifest.commit || !Array.isArray(support.targets)) {
    throw new Error("Support evidence does not match the release candidate.");
  }
  const supportTargetIds = [...new Set(support.targets.map((entry) => entry?.id).filter((id) => typeof id === "string"))].sort();
  if (supportTargetIds.length === 0) throw new Error("Support evidence has no certified targets.");
  const targetFiles = (await readdir(resolve(targetEvidenceDirectory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const targets = [];
  for (const file of targetFiles) {
    const targetPath = join(resolve(targetEvidenceDirectory), file);
    const target = await json(targetPath);
    if (target.format !== "sqlbraid-support-evidence" || target.version !== 1
      || target.commit !== manifest.commit || !Array.isArray(target.targets)) {
      throw new Error(`Target evidence does not match the release candidate: ${file}.`);
    }
    const ids = [...new Set(target.targets.map((entry) => entry?.id).filter((id) => typeof id === "string"))].sort();
    if (ids.length === 0) throw new Error(`Target evidence has no certified targets: ${file}.`);
    targets.push({ file, sha256: await hash(targetPath), ids, commit: target.commit });
  }
  if (targets.length === 0) throw new Error("No exact target evidence is available for durable release evidence.");
  const stagedPath = resolve(stagedEvidencePath);
  const durable = {
    format: "sqlbraid-release-evidence",
    version: manifest.version,
    commit: manifest.commit,
    candidate: {
      manifestSha256: manifestDigest(manifest),
      runId: manifest.runId ?? null,
      runAttempt: manifest.runAttempt ?? null,
      packages: manifest.packages.map(({ name, version, file, sha256, integrity }) => ({ name, version, file, sha256, integrity })),
      extension: manifest.extension,
    },
    certification: {
      support: {
        file: basename(supportPath),
        sha256: await hash(supportPath),
        format: support.format,
        version: support.version,
        commit: support.commit,
        run: support.run ?? null,
        targetIds: supportTargetIds,
      },
      targets,
    },
    publication: {
      file: basename(stagedPath),
      sha256: await hash(stagedPath),
      mode: staged.mode,
      manifestSha256: staged.manifestSha256,
      candidateIdentitySha256: staged.candidateIdentitySha256,
      runId: staged.runId ?? null,
      runAttempt: staged.runAttempt ?? null,
      reconciledFrom: staged.reconciledFrom ?? null,
      complete: staged.complete,
      approval: "human-interactive-after-staging",
      latestBefore: staged.latestBefore,
      packages: staged.packages.map(({ name, version, state, stageId, candidateSha256, candidateIntegrity, tag }) => ({
        name, version, state, stageId: stageId ?? null, candidateSha256, candidateIntegrity, tag,
      })),
    },
  };
  await writeFile(join(directory, "release-evidence.json"), `${JSON.stringify(durable, null, 2)}\n`);
  return durable;
}

function approvalCommands(manifest, records) {
  const levels = new Map();
  const layers = [];
  for (const entry of manifest.packages) {
    const dependencies = entry.dependencies ?? [];
    if (dependencies.some((name) => !levels.has(name))) throw new Error("Candidate dependencies are not in publication order.");
    const level = dependencies.reduce((max, name) => Math.max(max, levels.get(name) + 1), 0);
    levels.set(entry.name, level);
    const record = records.find(({ name }) => name === entry.name);
    if (record?.state === "staged") (layers[level] ??= []).push(assertStageId(record.stageId));
  }
  return layers.flatMap((ids, index) => ids?.length ? [{ layer: index + 1, command: `pnpm stage approve ${ids.join(" ")} --registry ${registry}` }] : []);
}

async function persistStaging(manifest, evidence, directory) {
  evidence.approvalCommands = approvalCommands(manifest, evidence.packages);
  const pending = join(directory, ".staged-publication.json.tmp");
  await writeFile(pending, `${JSON.stringify(evidence, null, 2)}\n`);
  await rename(pending, join(directory, "staged-publication.json"));
}

async function stagingSummary(evidence) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = ["## npm staging — human approval required", "", evidence.complete
    ? "Candidates are staged or already public with matching integrity. No approval was executed."
    : "Staging incomplete. Review partial evidence before retrying; do not approve a partial release.", "",
    "| Package | Version | Stage ID / state | Dist-tag requested | Candidate SHA-256 |",
    "| --- | --- | --- | --- | --- |"];
  for (const entry of evidence.packages) lines.push(`| ${entry.name} | ${entry.version} | ${entry.stageId ?? entry.state} (${entry.state}) | ${entry.tag} | ${entry.candidateSha256} |`);
  if (evidence.complete) {
    lines.push("", "After reviewing metadata and current dist-tags, approve each dependency layer interactively with 2FA. Approval is sequential, not atomic; stop on failure.");
    for (const { layer, command } of evidence.approvalCommands) lines.push("", `Layer ${layer}:`, "\n```sh", command, "```");
  }
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, { flag: "a" });
}

async function stagePackage(entry, record, persist, directory) {
  const existing = await registryIntegrity(entry.name, entry.version);
  if (existing) {
    if (existing !== entry.integrity) throw new Error(`Registry integrity mismatch for ${entry.name}@${entry.version}.`);
    record.state = "public";
    await persist();
    return;
  }
  if (record.state === "pending" || record.stageId) {
    throw new Error(`Uncertain prior stage for ${entry.name}; refusing another upload. Maintainer must reconcile the staged publication before retrying.`);
  }
  record.state = "pending";
  await persist(); // durable intent before the OIDC stage upload
  let output;
  try {
    output = await pnpm(["stage", "publish", join(directory, entry.file), "--access", "public", "--tag", releaseTag(),
      "--no-git-checks", "--ignore-scripts", "--provenance", "--json", "--reporter=silent", "--npmrc-auth-file", "/dev/null"], root, { quiet: true });
  } catch (error) {
    throw new Error(`Staging outcome unresolved for ${entry.name}; retained pending evidence, refusing another upload.`, { cause: error });
  }
  let summary;
  try {
    summary = JSON.parse(output)?.[entry.name];
    record.stageId = assertStageId(summary?.stageId);
    await persist(); // keep the returned ID if later validation fails
  } catch (error) {
    throw new Error(`Staging outcome unresolved for ${entry.name}; retained pending evidence, refusing another upload.`, { cause: error });
  }
  if (summary.name !== entry.name || summary.version !== entry.version || summary.integrity !== entry.integrity) {
    throw new Error("pnpm stage summary does not match the validated candidate.");
  }
  record.state = "staged";
  await persist();
}

async function registryTagSnapshot(manifest) {
  return Object.fromEntries(await Promise.all(manifest.packages.map(async (entry) => [entry.name, await registryDistTags(entry.name)])));
}

function assertLatestUnchanged(before, after, name) {
  if ((before.latest ?? undefined) !== (after.latest ?? undefined)) {
    throw new Error(`Registry latest tag changed unexpectedly for ${name}: ${before.latest ?? "absent"} -> ${after.latest ?? "absent"}.`);
  }
}

function assertNoTagDowngrade(name, tag, found) {
  if (found && (!isSemVer(found) || compareSemVer(found, version) > 0)) {
    throw new Error(`Refusing to move ${name}:${tag} backward from ${found} to ${version}.`);
  }
}

async function stageCandidates(manifest, {
  dryRun = false,
  directory = artifactDir,
  priorEvidence,
  priorRunId,
  currentRunId = manifest.runId,
  currentRunAttempt = manifest.runAttempt,
} = {}) {
  assertManifestIdentity(manifest);
  await assertPnpmVersion();
  if (dryRun) {
    for (const entry of manifest.packages) {
      const output = await pnpm(["stage", "publish", join(directory, entry.file), "--access", "public", "--tag", releaseTag(),
        "--dry-run", "--no-git-checks", "--ignore-scripts", "--provenance", "--json", "--reporter=silent", "--npmrc-auth-file", "/dev/null"], root, { quiet: true });
      const summary = JSON.parse(output)?.[entry.name];
      if (summary?.name !== entry.name || summary.version !== entry.version || summary.integrity !== entry.integrity || summary.stageId) throw new Error("Staged dry-run did not report the exact candidate integrity without a stage ID.");
    }
    return;
  }
  assertPublicationCredentials("stage");
  await assertOfficialRegistry();
  let evidence;
  let existingEvidence;
  try { existingEvidence = await json(join(directory, "staged-publication.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existingEvidence && priorEvidence) throw new Error("Provide either existing staged evidence or explicit prior evidence, not both.");
  if (existingEvidence) {
    evidence = existingEvidence;
    assertStagingEvidence(manifest, evidence);
  } else if (priorEvidence) {
    if (priorRunId !== undefined && String(priorEvidence.runId) !== String(priorRunId)) {
      throw new Error("Prior staged evidence does not belong to the requested prior candidate run.");
    }
    if (priorEvidence.manifestSha256 !== manifestDigest(manifest)) {
      throw new Error("Prior staged evidence does not match the immutable prior candidate manifest.");
    }
    assertStagingEvidence(manifest, priorEvidence, { allowPriorIdentity: true });
    evidence = {
      ...priorEvidence,
      mode: "reconcile",
      runId: currentRunId,
      runAttempt: currentRunAttempt,
      candidateRunId: manifest.runId,
      candidateRunAttempt: manifest.runAttempt,
      manifestSha256: manifestDigest(manifest),
      candidateIdentitySha256: candidateIdentityDigest(manifest),
      reconciledFrom: {
        runId: priorEvidence.runId,
        runAttempt: priorEvidence.runAttempt,
        manifestSha256: priorEvidence.manifestSha256,
        candidateIdentitySha256: priorEvidence.candidateIdentitySha256,
      },
      packages: priorEvidence.packages.map((record) => ({ ...record })),
    };
  } else {
    evidence = { format: "sqlbraid-staged-publication", mode: "fresh", version: manifest.version, commit: manifest.commit,
      runId: currentRunId, runAttempt: currentRunAttempt, candidateRunId: manifest.runId, candidateRunAttempt: manifest.runAttempt,
      manifestSha256: manifestDigest(manifest),
      candidateIdentitySha256: candidateIdentityDigest(manifest),
      latestBefore: await registryTagSnapshot(manifest), complete: false, packages: manifest.packages.map((entry) => ({
        name: entry.name, version: entry.version, candidateSha256: entry.sha256, candidateIntegrity: entry.integrity,
        tag: releaseTag(), state: "absent",
      })), approvalCommands: [] };
  }
  evidence.complete = false;
  const persist = () => persistStaging(manifest, evidence, directory);
  await persist();
  try {
    for (const entry of manifest.packages) {
      const tags = await registryDistTags(entry.name);
      assertLatestUnchanged(evidence.latestBefore[entry.name], tags, entry.name);
      assertNoTagDowngrade(entry.name, semver.isPrerelease ? "next" : "latest", tags[semver.isPrerelease ? "next" : "latest"]);
      assertNoTagDowngrade(entry.name, releaseTag(), tags[releaseTag()]);
      if (semver.isPrerelease && tags.latest === version) throw new Error(`Refusing prerelease ${version} under latest for ${entry.name}.`);
    }
    for (const [index, entry] of manifest.packages.entries()) {
      // pnpm obtains its own short-lived OIDC credential for stage publish.
      // Staged-package list/view/download endpoints require maintainer auth and
      // are intentionally left to the post-CI review boundary.
      await stagePackage(entry, evidence.packages[index], persist, directory);
      const tags = await registryDistTags(entry.name);
      assertLatestUnchanged(evidence.latestBefore[entry.name], tags, entry.name);
      if (evidence.packages[index].state === "public" && tags[releaseTag()] !== version) {
        throw new Error(`Exact public ${entry.name}@${version} has incorrect ${releaseTag()} tag; maintainer must reconcile the tag before retrying. No tag was changed.`);
      }
    }
    for (const entry of manifest.packages) {
      const tags = await registryDistTags(entry.name);
      assertLatestUnchanged(evidence.latestBefore[entry.name], tags, entry.name);
      assertNoTagDowngrade(entry.name, releaseTag(), tags[releaseTag()]);
    }
    evidence.complete = true;
  } finally {
    await persist();
    await stagingSummary(evidence);
  }
  return evidence;
}

function assertStagingEvidence(manifest, evidence, { allowPriorIdentity = false, expectedRunId, expectedRunAttempt } = {}) {
  const manifestMatches = evidence?.manifestSha256 === manifestDigest(manifest);
  const candidateMatches = evidence?.candidateIdentitySha256 === candidateIdentityDigest(manifest);
  if (evidence?.format !== "sqlbraid-staged-publication" || (!manifestMatches && !(allowPriorIdentity && candidateMatches))
    || evidence.version !== manifest.version || evidence.commit !== manifest.commit
    || !/^[a-f\d]{64}$/u.test(evidence.candidateIdentitySha256 ?? "")
    || (!allowPriorIdentity && (evidence.mode !== "fresh" && evidence.mode !== "reconcile"))
    || (!allowPriorIdentity && (evidence.runId !== (expectedRunId ?? manifest.runId)
      || evidence.runAttempt !== (expectedRunAttempt ?? manifest.runAttempt)))
    || (allowPriorIdentity && (!["fresh", "reconcile"].includes(evidence.mode)
      || !/^[a-f\d]{64}$/u.test(evidence.manifestSha256 ?? "")))
    || !Array.isArray(evidence.packages) || evidence.packages.length !== manifest.packages.length) throw new Error("Staging evidence does not match the immutable release manifest.");
  if (evidence.candidateRunId !== undefined && (evidence.candidateRunId !== manifest.runId
    || evidence.candidateRunAttempt !== manifest.runAttempt)) {
    throw new Error("Staging evidence does not preserve the immutable candidate run identity.");
  }
  for (const [index, entry] of manifest.packages.entries()) {
    const record = evidence.packages[index];
    if (record.name !== entry.name || record.version !== entry.version || record.candidateSha256 !== entry.sha256
      || record.candidateIntegrity !== entry.integrity || record.tag !== releaseTag() || !evidence.latestBefore?.[entry.name]
      || !["absent", "pending", "staged", "public"].includes(record.state)) throw new Error("Invalid staging package evidence.");
    if (record.stageId) assertStageId(record.stageId);
  }
  if (evidence.mode === "reconcile" && (!evidence.reconciledFrom
    || !/^[a-f\d]{64}$/u.test(evidence.reconciledFrom.manifestSha256 ?? ""))) {
    throw new Error("Reconciled staging evidence must retain the prior manifest identity.");
  }
}

async function verifyPublished(manifest, evidence, { requireLatest = false } = {}) {
  assertManifestIdentity(manifest);
  assertStagingEvidence(manifest, evidence, { expectedRunId: evidence.runId, expectedRunAttempt: evidence.runAttempt });
  await assertPnpmVersion();
  for (const entry of manifest.packages) {
    await assertRegistryIntegrity(entry);
    const tags = await registryDistTags(entry.name);
    if (tags[releaseTag()] !== version) throw new Error(`Registry tag ${entry.name}:${releaseTag()} does not point at ${version}.`);
    if (!semver.isPrerelease && requireLatest) {
      if (tags.latest !== version) throw new Error(`Registry latest for ${entry.name} does not point at ${version}.`);
    } else assertLatestUnchanged(evidence.latestBefore[entry.name], tags, entry.name);
    const attestations = await pnpmView(`${entry.name}@${entry.version}`, "dist.attestations");
    if (typeof attestations?.url !== "string" || !attestations.provenance?.predicateType) throw new Error(`Public provenance metadata missing for ${entry.name}@${entry.version}.`);
  }
  process.stdout.write(`Verified every ${version} package publicly: candidate integrity, requested tags, provenance metadata, and latest policy.\n`);
  if (!semver.isPrerelease && !requireLatest) {
    process.stdout.write("All packages are public. Immediately recheck latest for concurrent releases before these manual promotions:\n");
    for (const entry of manifest.packages) process.stdout.write(`pnpm dist-tag add ${entry.name}@${version} latest --registry ${registry}\n`);
    process.stdout.write("Then rerun verify-published --require-latest. No dist-tag was changed by this helper.\n");
  }
}

async function main() {
  const mode = option("--mode", "stage-dry-run");
  if (!["preflight", "pack", "pack-only", "stage-dry-run", "stage", "verify-published", "durable-evidence", "release-prerelease-flag"].includes(mode)) throw new Error(`Unknown release script mode ${mode}; full certify is a workflow mode.`);
  const priorEvidencePath = option("--prior-staged-publication");
  const priorCandidateRunId = option("--prior-candidate-run-id");
  if (priorEvidencePath && mode !== "stage") throw new Error("Prior staged evidence is accepted only for explicit staging reconciliation.");
  if (priorCandidateRunId && !["stage", "stage-dry-run"].includes(mode)) throw new Error("Prior candidate identity is accepted only for staging or staging certification.");
  if (mode === "durable-evidence") {
    const manifestPath = resolve(option("--manifest", join(artifactDir, "release-manifest.json")));
    const stagedPath = resolve(option("--staged-publication", join(artifactDir, "staged-publication.json")));
    const manifest = await json(manifestPath);
    setReleaseVersion(manifest.version);
    const staged = await json(stagedPath);
    await createReleaseEvidence(manifest, staged, {
      directory: resolve(option("--artifact-dir", dirname(manifestPath))),
      supportEvidencePath: option("--support-evidence"),
      targetEvidenceDirectory: option("--target-evidence-dir"),
      stagedEvidencePath: stagedPath,
    });
    return;
  }
  if (mode === "release-prerelease-flag") {
    const argument = releasePrereleaseArg(option("--version", version));
    if (argument) process.stdout.write(`${argument}\n`);
    return;
  }
  if (mode === "verify-published") {
    const manifest = await json(resolve(option("--manifest", join(artifactDir, "release-manifest.json"))));
    const evidence = await json(resolve(option("--staged-publication", join(artifactDir, "staged-publication.json"))));
    setReleaseVersion(manifest.version);
    await verifyPublished(manifest, evidence, { requireLatest: process.argv.includes("--require-latest") });
    return;
  }
  const packages = await packageManifests();
  await assertVersions(packages);
  const order = publishOrder(packages);
  process.stdout.write(`Dependency-derived staging order: ${order.join(" -> ")}\n`);
  if (mode === "preflight") {
    if (process.env.SQLBRAID_RELEASE_MODE === "stage") assertMutationAuthorization("stage");
    else if (![undefined, "certify", "pack-only"].includes(process.env.SQLBRAID_RELEASE_MODE)) throw new Error("Unknown workflow release mode.");
    await assertCleanTree();
    if (process.env.GITHUB_REF?.startsWith("refs/tags/")) await assertTaggedSha();
    else await currentSha();
    return;
  }
  if (mode === "pack-only" || mode === "pack") {
    await assertCleanTree();
    const sha = process.env.GITHUB_REF?.startsWith("refs/tags/") ? await assertTaggedSha() : await currentSha();
    await pack(packages, order, sha);
    return;
  }
  if (mode === "stage") {
    assertMutationAuthorization(mode);
    assertPublicationCredentials(mode);
    if (!artifactArgument) throw new Error("Staging requires --artifact-dir pointing at validated release artifacts.");
  }
  await assertCleanTree();
  const sha = mode === "stage" ? await assertTaggedSha() : await currentSha();
  const manifest = await readReleaseManifest(artifactDir, {
    priorCandidateRunId,
    allowCurrentAttemptMismatch: mode === "stage" || mode === "stage-dry-run",
  });
  if (manifest.commit !== sha) throw new Error("Validated release artifacts do not match this candidate commit.");
  assertManifestOrder(manifest, order);
  const priorEvidence = priorEvidencePath ? await json(resolve(priorEvidencePath)) : undefined;
  if (mode === "stage") {
    await assertReleaseWorkflows();
    await assertNoPriorStageAttempt(process.env, fetch, { allowReconciliation: Boolean(priorEvidence) });
  }
  await stageCandidates(manifest, {
    dryRun: mode === "stage-dry-run",
    priorEvidence,
    priorRunId: priorCandidateRunId,
    currentRunId: process.env.GITHUB_RUN_ID ?? manifest.runId,
    currentRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? manifest.runAttempt,
  });
}

function assertMutationAuthorization(mode, env = process.env) {
  if (mode !== "stage") throw new Error(`Not a staging mode: ${mode}.`);
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("stage is allowed only from GitHub Actions workflow_dispatch.");
  if (env.SQLBRAID_RELEASE_MODE !== mode) throw new Error("stage requires SQLBRAID_RELEASE_MODE=stage.");
  const expected = `refs/tags/${expectedTag}`;
  if (env.GITHUB_REF !== expected) throw new Error(`stage requires GITHUB_REF=${expected}; found ${env.GITHUB_REF ?? "unset"}.`);
  if (!/^[a-f\d]{40}$/u.test(env.GITHUB_SHA ?? "") || !/^\d+$/u.test(env.GITHUB_RUN_ID ?? "") || !/^\d+$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")) throw new Error("Staging requires exact workflow SHA, run ID, and run attempt.");
}

function assertPublicationCredentials(mode, env = process.env) {
  if (mode !== "stage") throw new Error("Only OIDC staging credentials are supported.");
  for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_BOOTSTRAP_TOKEN", "NPM_ID_TOKEN"]) {
    if (env[name]) throw new Error(`Normal OIDC staging must not receive ${name}.`);
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error("Normal staging requires GitHub Actions id-token permissions.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function setReleaseCommand(nextCommand) { command = nextCommand; }
function setReleaseVersion(nextVersion) {
  version = nextVersion;
  semver = parseSemver(nextVersion);
  expectedTag = `v${nextVersion}`;
  if (!artifactArgument) artifactDir = resolve(join(tmpdir(), `sqlbraid-release-${nextVersion}`));
}

export { assertManifestOrder, assertMutationAuthorization, assertPublicationCredentials, assertTaggedSha, createReleaseEvidence, stageCandidates, verifyPublished, parseSemver, readReleaseManifest, releasePrereleaseArg, releaseTag, setReleaseCommand, setReleaseVersion };
