import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareSemVer, isSemVer } from "./docs-history.mjs";
import { assertReleaseWorkflows } from "./assert-release-workflows.mjs";

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

function releaseTag() {
  return semver.isPrerelease ? "next" : `release-${version}`;
}

function commandErrorText(error) {
  return [error?.message, error?.stdout, error?.stderr].filter((value) => typeof value === "string").join("\n");
}

function registryNotFound(error) {
  return /\bE404\b|ERR_PNPM_FETCH_404|404 Not Found|No match found/iu.test(commandErrorText(error));
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
let request = fetch;

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

async function readReleaseManifest(directory = artifactDir) {
  const manifest = await json(join(directory, "release-manifest.json"));
  if (manifest.version !== version || !Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error("Invalid release-manifest.json.");
  if (process.env.GITHUB_RUN_ID && manifest.runId !== process.env.GITHUB_RUN_ID) throw new Error(`Validated release artifacts belong to run ${manifest.runId ?? "unknown"}, not ${process.env.GITHUB_RUN_ID}.`);
  if (process.env.GITHUB_RUN_ATTEMPT && manifest.runAttempt !== process.env.GITHUB_RUN_ATTEMPT) throw new Error(`Validated release artifacts belong to attempt ${manifest.runAttempt ?? "unknown"}, not ${process.env.GITHUB_RUN_ATTEMPT}.`);
  const names = new Set();
  const files = new Set();
  const packageNames = new Set(manifest.packages.map(({ name }) => name));
  for (const entry of manifest.packages) {
    if (typeof entry.name !== "string" || entry.version !== version || typeof entry.file !== "string" || basename(entry.file) !== entry.file || names.has(entry.name) || files.has(entry.file)) {
      throw new Error("Invalid release-manifest.json package entries.");
    }
    names.add(entry.name);
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
  const stamp = await json(join(directory, "pack-check-success.json"));
  if (stamp.version !== version || stamp.commit !== manifest.commit || !Array.isArray(stamp.packages) || stamp.packages.length !== manifest.packages.length) {
    throw new Error("Release artifacts do not have a matching successful pack-check stamp.");
  }
  const stampPackages = stamp.packages.map(({ name, sha256 }) => `${name}:${sha256}`).sort().join("\n");
  const manifestPackages = manifest.packages.map(({ name, sha256 }) => `${name}:${sha256}`).sort().join("\n");
  if (stampPackages !== manifestPackages) throw new Error("Pack-check stamp does not match validated release tarball hashes.");
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

async function oidcToken(name) {
  let idToken;
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.set("audience", `npm:${new URL(registry).hostname}`);
    const response = await request(url, {
      headers: { accept: "application/json", authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.value !== "string" || !body.value) throw new Error(`GitHub OIDC token request failed (${response.status}).`);
    idToken = body.value;
  }
  if (!idToken) throw new Error("OIDC publication requires GitHub Actions id-token permissions.");
  const escapedName = encodeURIComponent(name);
  const response = await request(new URL(`-/npm/v1/oidc/token/exchange/package/${escapedName}`, registry), {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.token !== "string" || !body.token) throw new Error(`npm OIDC token exchange failed for ${name} (${response.status}).`);
  return body.token;
}

// pnpm 12.3.4 stage reads do not exchange OIDC themselves. Use its same
// registry GET protocol with a fresh package-scoped OIDC token, kept in memory.
async function stageGet(path, token) {
  const response = await request(new URL(path, registry), {
    headers: { authorization: `Bearer ${token}`, "npm-auth-type": "web", "npm-command": "stage" },
    signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`npm stage read failed (HTTP ${response.status}); refusing to assume absence.`);
  return response;
}

function assertStageId(id) {
  if (typeof id !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(id)) throw new Error("Missing or invalid npm stage ID.");
  return id;
}

async function findStage(entry, token) {
  const items = [];
  let total;
  for (let page = 0; page < 1000; page += 1) {
    const query = new URLSearchParams({ package: entry.name, page: String(page), perPage: "100" });
    const body = await (await stageGet(`-/stage?${query}`, token)).json();
    if (!Array.isArray(body.items) || !Number.isSafeInteger(body.total) || body.total < 0
      || (total !== undefined && total !== body.total)) throw new Error("Invalid or changing stage list; retry after registry state settles.");
    total = body.total;
    for (const item of body.items) {
      if (item.packageName !== entry.name || typeof item.version !== "string") throw new Error("Stage list returned an unexpected package identity.");
      assertStageId(item.id);
      if (items.some((previous) => previous.id === item.id)) throw new Error("Duplicate stage list entry; cannot prove complete registry state.");
      items.push(item);
    }
    if (items.length === total) {
      const matches = items.filter((item) => item.version === entry.version);
      if (matches.length > 1) throw new Error(`Multiple stages for ${entry.name}@${entry.version}; maintainer must resolve ambiguity.`);
      return matches[0];
    }
    if (!body.items.length || items.length > total) break;
  }
  throw new Error("Incomplete stage list; refusing to create a potentially duplicate stage.");
}

async function verifyStage(entry, id, token) {
  assertStageId(id);
  const metadata = await (await stageGet(`-/stage/${id}`, token)).json();
  if (metadata.id !== id || metadata.packageName !== entry.name || metadata.version !== entry.version || metadata.tag !== releaseTag()) {
    throw new Error(`Staged package identity or requested tag mismatch for ${entry.name}.`);
  }
  // This endpoint returns the stored archive, not a repack. Require exact bytes;
  // an unavailable endpoint or a registry re-encoding fails closed.
  const bytes = new Uint8Array(await (await stageGet(`-/stage/${id}/tarball`, token)).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== entry.integrity) {
    throw new Error(`Staged tarball integrity mismatch for ${entry.name}@${entry.version}.`);
  }
}

function manifestDigest(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
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
  return layers.flatMap((ids, index) => ids?.length ? [{ layer: index + 1, command: `pnpm stage approve ${ids.join(" ")}` }] : []);
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

async function stagePackage(entry, record, token, persist, directory) {
  const existing = await registryIntegrity(entry.name, entry.version);
  if (existing) {
    if (existing !== entry.integrity) throw new Error(`Registry integrity mismatch for ${entry.name}@${entry.version}.`);
    record.state = "public";
    await persist();
    return;
  }
  let stage = await findStage(entry, token);
  if (!stage) {
    if (record.state === "pending" || record.stageId) throw new Error(`Uncertain prior stage for ${entry.name}; no visible stage. Refusing another upload; maintainer must reconcile registry state.`);
    record.state = "pending";
    await persist(); // durable intent before any upload, including network ambiguity
    let uploadError;
    try {
      const output = await pnpm(["stage", "publish", join(directory, entry.file), "--access", "public", "--tag", releaseTag(),
        "--no-git-checks", "--ignore-scripts", "--provenance", "--json", "--reporter=silent", "--npmrc-auth-file", "/dev/null"], root, { quiet: true });
      const summary = JSON.parse(output)?.[entry.name];
      record.stageId = assertStageId(summary?.stageId);
      await persist(); // keep the ID even if subsequent verification fails
      if (summary.name !== entry.name || summary.version !== entry.version || summary.integrity !== entry.integrity) throw new Error("pnpm stage summary does not match the validated candidate.");
    } catch (error) {
      uploadError = error;
    }
    // Always discover the registry state after upload; no automatic second POST.
    stage = await findStage(entry, token);
    if (!stage) {
      const publicIntegrity = await registryIntegrity(entry.name, entry.version);
      if (publicIntegrity) {
        if (publicIntegrity !== entry.integrity) throw new Error(`Registry integrity mismatch for ${entry.name}@${entry.version}.`);
        record.state = "public";
        await persist();
        return;
      }
      throw new Error(`Staging outcome unresolved for ${entry.name}; retained pending evidence, refusing another upload.`, { cause: uploadError });
    }
    if (record.stageId && record.stageId !== stage.id) throw new Error("Upload and registry stage IDs disagree; maintainer reconciliation required.");
  }
  record.stageId = assertStageId(stage.id);
  record.state = "pending";
  await persist();
  await verifyStage(entry, stage.id, token);
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

async function stageCandidates(manifest, { dryRun = false, directory = artifactDir } = {}) {
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
  try { evidence = await json(join(directory, "staged-publication.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (evidence) {
    assertStagingEvidence(manifest, evidence);
  } else {
    evidence = { format: "sqlbraid-staged-publication", version: manifest.version, commit: manifest.commit,
      runId: manifest.runId, runAttempt: manifest.runAttempt, manifestSha256: manifestDigest(manifest),
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
      // Reads authenticate with OIDC too, never an npm token fallback. pnpm
      // obtains its own per-package OIDC credential for the stage upload.
      await stagePackage(entry, evidence.packages[index], await oidcToken(entry.name), persist, directory);
      const tags = await registryDistTags(entry.name);
      assertLatestUnchanged(evidence.latestBefore[entry.name], tags, entry.name);
      if (evidence.packages[index].state === "public" && tags[releaseTag()] !== version) {
        throw new Error(`Exact public ${entry.name}@${version} has incorrect ${releaseTag()} tag; maintainer must reconcile the tag before retrying. No tag was changed.`);
      }
    }
    for (const entry of manifest.packages) {
      assertLatestUnchanged(evidence.latestBefore[entry.name], await registryDistTags(entry.name), entry.name);
    }
    evidence.complete = true;
  } finally {
    await persist();
    await stagingSummary(evidence);
  }
  return evidence;
}

function assertStagingEvidence(manifest, evidence) {
  if (evidence.format !== "sqlbraid-staged-publication" || evidence.manifestSha256 !== manifestDigest(manifest)
    || evidence.version !== manifest.version || evidence.commit !== manifest.commit
    || evidence.runId !== manifest.runId || evidence.runAttempt !== manifest.runAttempt
    || !Array.isArray(evidence.packages) || evidence.packages.length !== manifest.packages.length) throw new Error("Staging evidence does not match the immutable release manifest.");
  for (const [index, entry] of manifest.packages.entries()) {
    const record = evidence.packages[index];
    if (record.name !== entry.name || record.version !== entry.version || record.candidateSha256 !== entry.sha256
      || record.candidateIntegrity !== entry.integrity || record.tag !== releaseTag() || !evidence.latestBefore?.[entry.name]
      || !["absent", "pending", "staged", "public"].includes(record.state)) throw new Error("Invalid staging package evidence.");
    if (record.stageId) assertStageId(record.stageId);
  }
}

async function verifyPublished(manifest, evidence, { requireLatest = false } = {}) {
  assertStagingEvidence(manifest, evidence);
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
  if (!["preflight", "pack", "pack-only", "stage-dry-run", "stage", "verify-published"].includes(mode)) throw new Error(`Unknown release script mode ${mode}; full certify is a workflow mode.`);
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
  const manifest = await readReleaseManifest();
  if (manifest.commit !== sha) throw new Error("Validated release artifacts do not match this candidate commit.");
  assertManifestOrder(manifest, order);
  if (mode === "stage") await assertReleaseWorkflows();
  await stageCandidates(manifest, { dryRun: mode === "stage-dry-run" });
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
function setReleaseRequest(nextRequest) { request = nextRequest; }
function setReleaseVersion(nextVersion) {
  version = nextVersion;
  semver = parseSemver(nextVersion);
  expectedTag = `v${nextVersion}`;
  if (!artifactArgument) artifactDir = resolve(join(tmpdir(), `sqlbraid-release-${nextVersion}`));
}

export { assertManifestOrder, assertMutationAuthorization, assertPublicationCredentials, assertTaggedSha, stageCandidates, verifyPublished, parseSemver, readReleaseManifest, releaseTag, setReleaseCommand, setReleaseRequest, setReleaseVersion };
