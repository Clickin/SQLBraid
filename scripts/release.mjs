import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
    packages: order.map((name) => ({ name, version, file: basename(tarballs.get(name)), sha256: null, integrity: null })),
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

async function assertPnpmIdentityAndWriteAccess(packages) {
  await assertPnpmVersion();
  const user = (await pnpm(["whoami"], root, { quiet: true })).trim();
  if (!user) throw new Error("pnpm whoami returned no authenticated user.");
  await assertOfficialRegistry();
  let accessOutput = "";
  try {
    accessOutput = await pnpm(["access", "list", "packages", user, "--json"], root, { quiet: true });
  } catch (error) {
    if (!registryNotFound(error)) throw error;
  }
  let access;
  try {
    access = accessOutput.trim() ? JSON.parse(accessOutput) : undefined;
  } catch {
    access = undefined;
  }
  let organizationAccess;
  for (const { name } of packages) {
    if (await pnpmView(name, "name")) {
      if (access?.[name] !== "read-write") throw new Error(`Authenticated registry user ${user} does not have write access to ${name}.`);
    } else if (name.startsWith("@sqlbraid/")) {
      if (organizationAccess === undefined) {
        if (!process.env.NODE_AUTH_TOKEN) throw new Error("Bootstrap organization verification requires NODE_AUTH_TOKEN.");
        const response = await request(new URL("-/org/sqlbraid/user", registry), {
          headers: { authorization: `Bearer ${process.env.NODE_AUTH_TOKEN}`, accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`Bootstrap organization verification failed (HTTP ${response.status}).`);
        const organization = await response.json();
        organizationAccess = ["owner", "admin", "developer"].includes(organization?.[user]);
      }
      if (!organizationAccess) throw new Error(`Authenticated registry user ${user} cannot create packages in the @sqlbraid organization.`);
    } else if (name !== "sqlbraid") {
      throw new Error(`Authenticated registry user ${user} cannot verify creation access for ${name}; refusing bootstrap.`);
    }
  }
  await assertBootstrapTokenGrants();
  return user;
}

async function assertBootstrapTokenGrants() {
  const token = process.env.NODE_AUTH_TOKEN;
  if (!token) throw new Error("Bootstrap token verification requires NODE_AUTH_TOKEN.");
  const redacted = `${token.slice(0, 8)}...${token.slice(-4)}`;
  const matches = [];
  let seen = 0;
  let total;
  for (let page = 0; page < 10; page += 1) {
    const response = await request(new URL(`-/npm/v1/tokens?page=${page}&perPage=100`, registry), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Bootstrap token verification failed (HTTP ${response.status}).`);
    const body = await response.json();
    if (!Array.isArray(body.objects) || !Number.isSafeInteger(body.total) || body.total < 0
      || (total !== undefined && total !== body.total)) {
      throw new Error("Invalid or changing bootstrap token metadata; refusing publication.");
    }
    total = body.total;
    seen += body.objects.length;
    matches.push(...body.objects.filter((entry) => entry?.token === redacted));
    if (seen === total) break;
    if (!body.objects.length || seen > total) throw new Error("Incomplete bootstrap token metadata; refusing publication.");
  }
  if (seen !== total || matches.length !== 1) {
    throw new Error("Cannot uniquely verify the current bootstrap token; refusing publication.");
  }
  const current = matches[0];
  if (current.readonly !== false || current.bypass_2fa !== true || current.revoked !== null
    || !(Date.parse(current.expiry) > Date.now())
    || !current.permissions?.some((permission) => permission.name === "package" && permission.action === "write")
    || !current.scopes?.some((scope) => scope.type === "package" && scope.name === "*")) {
    throw new Error("Bootstrap requires an active automation token with package write access to All packages, including future unscoped sqlbraid.");
  }
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

async function oidcDistTagAdd(name, tag, releaseVersion) {
  const token = await oidcToken(name);
  const response = await request(new URL(`-/package/${encodeURIComponent(name)}/dist-tags/${encodeURIComponent(tag)}`, registry), {
    method: "PUT",
    headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(releaseVersion),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Registry dist-tag update failed for ${name}:${tag} (HTTP ${response.status}).`);
  }
}

async function ensureReleaseTag(name, tag, { allowMove, oidc = false }) {
  const tags = await registryDistTags(name);
  const found = tags[tag];
  if (found === version) return;
  assertNoTagDowngrade(name, tag, found);
  if (found && !allowMove) throw new Error(`Registry tag ${name}:${tag} points at ${found}, not ${version}.`);
  if (oidc) await oidcDistTagAdd(name, tag, version);
  else await pnpm(["dist-tag", "add", `${name}@${version}`, tag], root);
  const verified = await registryDistTags(name);
  if (verified[tag] !== version) throw new Error(`Registry tag ${name}:${tag} was not moved to ${version}.`);
}

async function publishPackage(entry, { dryRun, provenance }) {
  const tag = releaseTag();
  const path = join(artifactDir, entry.file);
  if (dryRun) {
    await pnpm(["publish", path, "--access", "public", "--tag", tag, "--dry-run", "--no-git-checks"], root);
    return;
  }
  const existing = await registryIntegrity(entry.name, version);
  if (existing) {
    if (existing !== entry.integrity) throw new Error(`Registry integrity mismatch for ${entry.name}@${version}: expected ${entry.integrity}, found ${existing}.`);
    process.stdout.write(`Already published exact ${entry.name}@${version}; verifying ${tag}.\n`);
    await ensureReleaseTag(entry.name, tag, { allowMove: semver.isPrerelease, oidc: provenance });
    return;
  }
  const args = ["publish", path, "--access", "public", "--tag", tag, "--no-git-checks"];
  if (provenance) args.push("--provenance");
  try {
    await pnpm(args, root);
  } catch (error) {
    const afterFailure = await registryIntegrity(entry.name, version);
    if (afterFailure === entry.integrity) {
      process.stdout.write(`Publish outcome uncertain for ${entry.name}; registry contains the exact validated artifact.\n`);
      await ensureReleaseTag(entry.name, tag, { allowMove: semver.isPrerelease, oidc: provenance });
      return;
    }
    if (afterFailure) throw new Error(`Registry integrity mismatch for ${entry.name}@${version}: expected ${entry.integrity}, found ${afterFailure}.`);
    throw error;
  }
  await assertRegistryIntegrity(entry);
  await ensureReleaseTag(entry.name, tag, { allowMove: semver.isPrerelease, oidc: provenance });
}

async function registryTagSnapshot(manifest) {
  return new Map(await Promise.all(manifest.packages.map(async (entry) => [entry.name, await registryDistTags(entry.name)])));
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

async function promoteLatest(manifest, before, { oidc = false } = {}) {
  for (const entry of manifest.packages) {
    assertLatestUnchanged(before.get(entry.name), await registryDistTags(entry.name), entry.name);
    assertNoTagDowngrade(entry.name, "latest", before.get(entry.name).latest);
    if (oidc) await oidcDistTagAdd(entry.name, "latest", version);
    else await pnpm(["dist-tag", "add", `${entry.name}@${version}`, "latest"], root);
    const tags = await registryDistTags(entry.name);
    if (tags.latest !== version) throw new Error(`Registry latest tag for ${entry.name} does not point at ${version}.`);
  }
}

async function pnpmPublish(manifest, { dryRun, provenance }) {
  await assertPnpmVersion();
  if (dryRun) {
    for (const entry of manifest.packages) await publishPackage(entry, { dryRun: true, provenance: false });
    return;
  }
  await assertOfficialRegistry();
  const before = await registryTagSnapshot(manifest);
  for (const [name, tags] of before) {
    const tag = semver.isPrerelease ? "next" : "latest";
    assertNoTagDowngrade(name, tag, tags[tag]);
  }
  if (semver.isPrerelease) {
    for (const [name, tags] of before) if (tags.latest === version) throw new Error(`Refusing to publish prerelease ${version} under latest for ${name}.`);
  }
  for (const entry of manifest.packages) await publishPackage(entry, { dryRun: false, provenance });
  for (const entry of manifest.packages) {
    await assertRegistryIntegrity(entry);
    const after = await registryDistTags(entry.name);
    if (semver.isPrerelease) assertLatestUnchanged(before.get(entry.name), after, entry.name);
    else if (after[releaseTag()] !== version) throw new Error(`Staged stable tag ${entry.name}:${releaseTag()} does not point at ${version}.`);
  }
  if (!semver.isPrerelease) {
    for (const entry of manifest.packages) assertLatestUnchanged(before.get(entry.name), await registryDistTags(entry.name), entry.name);
    await promoteLatest(manifest, before, { oidc: provenance });
    for (const entry of manifest.packages) {
      const tags = await registryDistTags(entry.name);
      if (tags.latest !== version) throw new Error(`Registry latest tag for ${entry.name} does not point at ${version}.`);
    }
  }
}

async function main() {
  const mode = option("--mode", "publish-dry-run");
  if (!["preflight", "pack", "pack-only", "publish-dry-run", "publish", "bootstrap-rc0"].includes(mode)) throw new Error(`Unknown release script mode ${mode}; full certify is a workflow mode.`);
  const packages = await packageManifests();
  await assertVersions(packages);
  const order = publishOrder(packages);
  process.stdout.write(`Dependency-derived publication order: ${order.join(" -> ")}\n`);
  if (mode === "preflight") {
    if (["publish", "bootstrap-rc0"].includes(process.env.SQLBRAID_RELEASE_MODE)) assertMutationAuthorization(process.env.SQLBRAID_RELEASE_MODE);
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
  if (mode === "publish") {
    assertMutationAuthorization(mode);
    assertPublicationCredentials(mode);
    await assertCleanTree();
    const sha = await assertTaggedSha();
    const manifest = await readReleaseManifest();
    if (manifest.commit !== sha) throw new Error("Validated release artifacts do not match this tagged commit.");
    assertManifestOrder(manifest, order);
    await assertReleaseWorkflows();
    await pnpmPublish(manifest, { dryRun: false, provenance: true });
    return;
  }
  if (mode === "bootstrap-rc0") {
    assertMutationAuthorization(mode);
    assertPublicationCredentials(mode);
    if (!artifactArgument) throw new Error("RC bootstrap requires --artifact-dir pointing at validated release artifacts.");
    if (version !== "0.1.0-rc.0") throw new Error(`RC bootstrap requires version 0.1.0-rc.0; found ${version}.`);
    await assertCleanTree();
    const sha = await assertTaggedSha();
    const manifest = await readReleaseManifest();
    if (manifest.commit !== sha) throw new Error("Validated release artifacts do not match this tagged commit.");
    assertManifestOrder(manifest, order);
    await assertReleaseWorkflows();
    await assertPnpmIdentityAndWriteAccess(manifest.packages);
    await pnpmPublish(manifest, { dryRun: false, provenance: false });
    return;
  }
  if (mode === "publish-dry-run") {
    await assertCleanTree();
    const sha = await currentSha();
    const manifest = await readReleaseManifest();
    if (manifest.commit !== sha) throw new Error("Validated release artifacts do not match this candidate.");
    assertManifestOrder(manifest, order);
    await pnpmPublish(manifest, { dryRun: true, provenance: false });
    return;
  }
}

function assertMutationAuthorization(mode, env = process.env) {
  if (!["publish", "bootstrap-rc0"].includes(mode)) throw new Error(`Not a publication mode: ${mode}.`);
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error(`${mode} is allowed only from GitHub Actions workflow_dispatch.`);
  if (env.SQLBRAID_RELEASE_MODE !== mode) throw new Error(`${mode} requires SQLBRAID_RELEASE_MODE=${mode}.`);
  if (mode === "bootstrap-rc0" && version !== "0.1.0-rc.0") throw new Error("Bootstrap requires exactly 0.1.0-rc.0.");
  const expected = `refs/tags/${expectedTag}`;
  if (env.GITHUB_REF !== expected) throw new Error(`${mode} requires GITHUB_REF=${expected}; found ${env.GITHUB_REF ?? "unset"}.`);
  if (!/^[a-f\d]{40}$/u.test(env.GITHUB_SHA ?? "") || !/^\d+$/u.test(env.GITHUB_RUN_ID ?? "") || !/^\d+$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")) throw new Error("Publication requires exact workflow SHA, run ID, and run attempt.");
}

function assertPublicationCredentials(mode, env = process.env) {
  if (mode === "bootstrap-rc0") {
    if (!env.NODE_AUTH_TOKEN) throw new Error("Bootstrap requires NPM_BOOTSTRAP_TOKEN via NODE_AUTH_TOKEN.");
    return;
  }
  for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_BOOTSTRAP_TOKEN", "NPM_ID_TOKEN"]) {
    if (env[name]) throw new Error(`Normal OIDC publication must not receive ${name}.`);
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error("Normal publication requires GitHub Actions id-token permissions.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function setReleaseCommand(nextCommand) {
  command = nextCommand;
}

function setReleaseRequest(nextRequest) {
  request = nextRequest;
}

function setReleaseVersion(nextVersion) {
  version = nextVersion;
  semver = parseSemver(nextVersion);
  expectedTag = `v${nextVersion}`;
  if (!artifactArgument) artifactDir = resolve(join(tmpdir(), `sqlbraid-release-${nextVersion}`));
}

export { assertManifestOrder, assertMutationAuthorization, assertPublicationCredentials, assertPnpmIdentityAndWriteAccess, assertTaggedSha, pnpmPublish, parseSemver, readReleaseManifest, releaseTag, setReleaseCommand, setReleaseRequest, setReleaseVersion };
