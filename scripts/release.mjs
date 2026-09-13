import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.SQLBRAID_RELEASE_VERSION ?? "0.1.0";
const expectedTag = `v${version}`;
const defaultArtifactDir = join(tmpdir(), `sqlbraid-release-${version}`);
const packageFields = ["dependencies", "optionalDependencies", "peerDependencies"];

function option(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const mode = option("--mode", "dry-run");
const artifactDir = resolve(option("--artifact-dir", process.env.SQLBRAID_RELEASE_ARTIFACT_DIR ?? defaultArtifactDir));

async function command(file, args, cwd = root) {
  const { stdout, stderr } = await execFileAsync(file, args, { cwd, maxBuffer: 10 * 1024 * 1024, env: process.env });
  if (stderr.trim()) process.stderr.write(stderr);
  if (stdout.trim()) process.stdout.write(stdout);
  return stdout;
}

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
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) throw new Error(`Workflow SHA ${process.env.GITHUB_SHA} does not equal checked out HEAD ${head}.`);
  const tagged = (await command("git", ["rev-list", "-n", "1", `refs/tags/${expectedTag}`])).trim();
  if (!tagged || tagged !== head) throw new Error(`Tag ${expectedTag} does not point at HEAD (${head}).`);
  return head;
}

async function assertVersions(packages) {
  const mismatches = packages
    .filter(({ manifest }) => manifest.version !== version)
    .map(({ manifest }) => `${manifest.name}@${manifest.version}`);
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
  const content = await command("tar", ["-xOf", path, "package/package.json"]);
  return JSON.parse(content);
}

async function validateTarball(path, packageNames) {
  const manifest = await tarballManifest(path);
  if (!packageNames.has(manifest.name)) throw new Error(`Unexpected package in ${path}: ${manifest.name}.`);
  if (manifest.version !== version) throw new Error(`${manifest.name} in ${path} is ${manifest.version}, expected ${version}.`);
  if (JSON.stringify(manifest).includes("workspace:")) throw new Error(`${path} leaks a workspace: dependency.`);
  const listing = await command("tar", ["-tf", path]);
  for (const required of ["package/package.json", "package/README.md", "package/LICENSE"]) {
    if (!listing.split("\n").includes(required)) throw new Error(`${path} does not contain ${required}.`);
  }
  return manifest;
}

async function hash(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
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
    packages: order.map((name) => ({ name, file: basename(tarballs.get(name)), sha256: null })),
  };
  for (const entry of manifest.packages) entry.sha256 = await hash(join(artifactDir, entry.file));
  await writeFile(join(artifactDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Preserved ${manifest.packages.length} validated tarballs in ${artifactDir}.\n`);
  return manifest;
}

async function readReleaseManifest() {
  const manifest = await json(join(artifactDir, "release-manifest.json"));
  if (manifest.version !== version || !Array.isArray(manifest.packages)) throw new Error("Invalid release-manifest.json.");
  for (const entry of manifest.packages) {
    const path = join(artifactDir, entry.file);
    if (await hash(path) !== entry.sha256) throw new Error(`Validated tarball changed: ${entry.file}.`);
    await validateTarball(path, new Set(manifest.packages.map((item) => item.name)));
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

function npmVersionAtLeast(value, minimum) {
  const parse = (text) => text.trim().replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10));
  const actual = parse(value);
  const required = parse(minimum);
  return actual[0] > required[0] || (actual[0] === required[0] && (actual[1] > required[1] || (actual[1] === required[1] && actual[2] >= required[2])));
}

async function npmPublish(manifest, dryRun) {
  const npmVersion = await command("npm", ["--version"]);
  if (!npmVersionAtLeast(npmVersion, "11.5.1")) throw new Error(`npm ${npmVersion.trim()} is too old for trusted publishing; install npm >=11.5.1.`);
  for (const entry of manifest.packages) {
    const path = join(artifactDir, entry.file);
    const args = ["publish", path, "--access", "public", ...(dryRun ? ["--dry-run"] : ["--provenance"])];
    await command("npm", args);
  }
}

async function main() {
  if (!["preflight", "pack", "pack-only", "dry-run", "publish-dry-run", "publish"].includes(mode)) throw new Error(`Unknown release mode ${mode}.`);
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
    if (manifest.commit !== sha || manifest.packages.map(({ name }) => name).join("\n") !== order.join("\n")) throw new Error("Validated release artifacts do not match this tagged commit/order.");
    await npmPublish(manifest, false);
    return;
  }
  if (mode === "publish-dry-run") {
    await assertCleanTree();
    const sha = await currentSha();
    const manifest = await readReleaseManifest();
    if (manifest.commit !== sha || manifest.packages.map(({ name }) => name).join("\n") !== order.join("\n")) throw new Error("Validated release artifacts do not match this candidate/order.");
    await npmPublish(manifest, true);
    return;
  }
  await assertCleanTree();
  const sha = process.env.GITHUB_REF?.startsWith("refs/tags/") ? await assertTaggedSha() : await currentSha();
  const manifest = await pack(packages, order, sha);
  if (mode === "dry-run") await npmPublish(manifest, true);
}

await main();
