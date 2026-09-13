import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareSemVer, isSemVer } from "./docs-history.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
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
  return /\bE404\b|404 Not Found|No match found/iu.test(commandErrorText(error));
}

function interactiveCommand(file, args, cwd) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(file, args, { cwd, env: process.env, stdio: "inherit" });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolveCommand("");
      else rejectCommand(new Error(`${file} ${args.join(" ")} exited with ${signal ?? `code ${code ?? "unknown"}`}.`));
    });
  });
}

async function defaultCommand(file, args, cwd = root, { quiet = false, interactive = false } = {}) {
  if (interactive) return interactiveCommand(file, args, cwd);
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
  return (await command("git", ["rev-parse", "HEAD"])).trim();
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
  await mkdir(artifactDir, { recursive: true });
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
    packages: order.map((name) => ({ name, file: basename(tarballs.get(name)), sha256: null, integrity: null })),
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

async function readReleaseManifest() {
  const manifest = await json(join(artifactDir, "release-manifest.json"));
  if (manifest.version !== version || !Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error("Invalid release-manifest.json.");
  const names = new Set();
  const files = new Set();
  for (const entry of manifest.packages) {
    if (typeof entry.name !== "string" || typeof entry.file !== "string" || basename(entry.file) !== entry.file || names.has(entry.name) || files.has(entry.file)) {
      throw new Error("Invalid release-manifest.json package entries.");
    }
    names.add(entry.name);
    files.add(entry.file);
    const path = join(artifactDir, entry.file);
    const actualSha = await hash(path);
    if (actualSha !== entry.sha256) throw new Error(`Validated tarball changed: ${entry.file}.`);
    const actualIntegrity = await integrity(path);
    if (entry.integrity && actualIntegrity !== entry.integrity) throw new Error(`Validated tarball integrity changed: ${entry.file}.`);
    entry.integrity = actualIntegrity;
    await validateTarball(path, names);
  }
  const stamp = await json(join(artifactDir, "pack-check-success.json"));
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

function npmVersionAtLeast(value, minimum) {
  const parse = (text) => text.trim().replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const actual = parse(value);
  const required = parse(minimum);
  return actual[0] > required[0] || (actual[0] === required[0] && (actual[1] > required[1] || (actual[1] === required[1] && actual[2] >= required[2])));
}

async function assertNpmVersion() {
  const npmVersion = await command("npm", ["--version"]);
  if (!npmVersionAtLeast(npmVersion, "11.15.0")) throw new Error(`npm ${npmVersion.trim()} is too old for trusted publishing; install npm >=11.15.0.`);
}

async function assertOfficialRegistry() {
  const configured = (await command("npm", ["config", "get", "registry"], root, { quiet: true })).trim().replace(/\/?$/u, "/");
  if (configured !== registry) throw new Error(`npm registry must be ${registry}; found ${configured || "empty"}.`);
  await command("npm", ["ping", "--registry", registry], root, { quiet: true });
}

function hasWriteAccess(value) {
  if (typeof value === "string") return /^(?:write|read-write|owner|admin|developer)$/iu.test(value);
  if (Array.isArray(value)) return value.some((entry) => hasWriteAccess(entry));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) => /(?:access|permission|role)/iu.test(key) && hasWriteAccess(entry)) || Object.values(value).some((entry) => hasWriteAccess(entry));
  }
  return false;
}

async function assertNpmIdentityAndWriteAccess(packages) {
  const user = (await command("npm", ["whoami"], root, { quiet: true })).trim();
  if (!user) throw new Error("npm whoami returned no authenticated user.");
  await assertOfficialRegistry();
  let accessOutput = "";
  try {
    accessOutput = await command("npm", ["access", "ls-packages", user, "--json", "--registry", registry], root, { quiet: true });
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
    if (await npmView(name, "name")) {
      if (!hasWriteAccess(access?.[name])) throw new Error(`Authenticated npm user ${user} does not have write access to ${name}.`);
    } else if (name.startsWith("@sqlbraid/")) {
      if (organizationAccess === undefined) {
        const organization = await command("npm", ["org", "ls", "sqlbraid", user, "--json", "--registry", registry], root, { quiet: true });
        organizationAccess = hasWriteAccess(JSON.parse(organization));
      }
      if (!organizationAccess) throw new Error(`Authenticated npm user ${user} cannot create packages in the @sqlbraid organization.`);
    }
  }
  return user;
}

async function npmView(spec, field) {
  try {
    const output = await command("npm", ["view", spec, field, "--json", "--registry", registry], root, { quiet: true });
    if (!output.trim() || output.trim() === "null") return undefined;
    return JSON.parse(output);
  } catch (error) {
    if (registryNotFound(error)) return undefined;
    throw error;
  }
}

async function registryIntegrity(name, releaseVersion) {
  const value = await npmView(`${name}@${releaseVersion}`, "dist.integrity");
  return typeof value === "string" && value ? value : undefined;
}

async function registryDistTags(name) {
  const value = await npmView(name, "dist-tags");
  return value && typeof value === "object" ? value : {};
}

async function assertRegistryIntegrity(entry) {
  const found = await registryIntegrity(entry.name, version);
  if (found !== entry.integrity) throw new Error(`Registry integrity mismatch for ${entry.name}@${version}: expected ${entry.integrity}, found ${found ?? "absent"}.`);
}

async function ensureReleaseTag(name, tag, { allowMove }) {
  const tags = await registryDistTags(name);
  const found = tags[tag];
  if (found === version) return;
  assertNoTagDowngrade(name, tag, found);
  if (found && !allowMove) throw new Error(`Registry tag ${name}:${tag} points at ${found}, not ${version}.`);
  await command("npm", ["dist-tag", "add", `${name}@${version}`, tag, "--registry", registry]);
  const verified = await registryDistTags(name);
  if (verified[tag] !== version) throw new Error(`Registry tag ${name}:${tag} was not moved to ${version}.`);
}

async function publishPackage(entry, { dryRun, provenance }) {
  const tag = releaseTag();
  const path = join(artifactDir, entry.file);
  if (dryRun) {
    await command("npm", ["publish", path, "--access", "public", "--tag", tag, "--dry-run", "--registry", registry]);
    return;
  }
  const existing = await registryIntegrity(entry.name, version);
  if (existing) {
    if (existing !== entry.integrity) throw new Error(`Registry integrity mismatch for ${entry.name}@${version}: expected ${entry.integrity}, found ${existing}.`);
    process.stdout.write(`Already published exact ${entry.name}@${version}; verifying ${tag}.\n`);
    await ensureReleaseTag(entry.name, tag, { allowMove: semver.isPrerelease });
    return;
  }
  const args = ["publish", path, "--access", "public", "--tag", tag, "--registry", registry];
  if (provenance) args.push("--provenance");
  try {
    await command("npm", args, root, { interactive: !provenance });
  } catch (error) {
    const afterFailure = await registryIntegrity(entry.name, version);
    if (afterFailure === entry.integrity) {
      process.stdout.write(`Publish outcome uncertain for ${entry.name}; registry contains the exact validated artifact.\n`);
      await ensureReleaseTag(entry.name, tag, { allowMove: semver.isPrerelease });
      return;
    }
    if (afterFailure) throw new Error(`Registry integrity mismatch for ${entry.name}@${version}: expected ${entry.integrity}, found ${afterFailure}.`);
    throw error;
  }
  await assertRegistryIntegrity(entry);
  await ensureReleaseTag(entry.name, tag, { allowMove: semver.isPrerelease });
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

async function promoteLatest(manifest, before) {
  for (const entry of manifest.packages) {
    assertLatestUnchanged(before.get(entry.name), await registryDistTags(entry.name), entry.name);
    assertNoTagDowngrade(entry.name, "latest", before.get(entry.name).latest);
    await command("npm", ["dist-tag", "add", `${entry.name}@${version}`, "latest", "--registry", registry]);
    const tags = await registryDistTags(entry.name);
    if (tags.latest !== version) throw new Error(`Registry latest tag for ${entry.name} does not point at ${version}.`);
  }
}

async function npmPublish(manifest, { dryRun, provenance }) {
  await assertNpmVersion();
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
    await promoteLatest(manifest, before);
    for (const entry of manifest.packages) {
      const tags = await registryDistTags(entry.name);
      if (tags.latest !== version) throw new Error(`Registry latest tag for ${entry.name} does not point at ${version}.`);
    }
  }
}

async function main() {
  const mode = option("--mode", "dry-run");
  if (!["preflight", "pack", "pack-only", "dry-run", "publish-dry-run", "publish", "bootstrap"].includes(mode)) throw new Error(`Unknown release mode ${mode}.`);
  const packages = await packageManifests();
  await assertVersions(packages);
  const order = publishOrder(packages);
  process.stdout.write(`Dependency-derived publication order: ${order.join(" -> ")}\n`);
  if (mode === "preflight") {
    await assertCleanTree();
    if (process.env.GITHUB_REF?.startsWith("refs/tags/")) await assertTaggedSha();
    return;
  }
  if (mode === "publish") {
    if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Publishing is allowed only from GitHub Actions trusted publishing.");
    await assertCleanTree();
    const sha = await assertTaggedSha();
    const manifest = await readReleaseManifest();
    if (manifest.commit !== sha) throw new Error("Validated release artifacts do not match this tagged commit.");
    assertManifestOrder(manifest, order);
    await npmPublish(manifest, { dryRun: false, provenance: true });
    return;
  }
  if (mode === "bootstrap") {
    if (!artifactArgument) throw new Error("RC bootstrap requires --artifact-dir pointing at validated release artifacts.");
    if (version !== "0.1.0-rc.0") throw new Error(`RC bootstrap requires version 0.1.0-rc.0; found ${version}.`);
    await assertCleanTree();
    const sha = await currentSha();
    const manifest = await readReleaseManifest();
    if (manifest.commit !== sha) throw new Error("Validated release artifacts do not match the current clean commit.");
    assertManifestOrder(manifest, order);
    await assertNpmIdentityAndWriteAccess(manifest.packages);
    await npmPublish(manifest, { dryRun: false, provenance: false });
    return;
  }
  if (mode === "publish-dry-run") {
    await assertCleanTree();
    const sha = await currentSha();
    const manifest = await readReleaseManifest();
    if (manifest.commit !== sha) throw new Error("Validated release artifacts do not match this candidate.");
    assertManifestOrder(manifest, order);
    await npmPublish(manifest, { dryRun: true, provenance: false });
    return;
  }
  await assertCleanTree();
  const sha = process.env.GITHUB_REF?.startsWith("refs/tags/") ? await assertTaggedSha() : await currentSha();
  const manifest = await pack(packages, order, sha);
  if (mode === "dry-run") await npmPublish(manifest, { dryRun: true, provenance: false });
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

function setReleaseVersion(nextVersion) {
  version = nextVersion;
  semver = parseSemver(nextVersion);
  expectedTag = `v${nextVersion}`;
  if (!artifactArgument) artifactDir = resolve(join(tmpdir(), `sqlbraid-release-${nextVersion}`));
}

export { assertManifestOrder, assertNpmIdentityAndWriteAccess, npmPublish, npmVersionAtLeast, parseSemver, releaseTag, setReleaseCommand, setReleaseVersion };
