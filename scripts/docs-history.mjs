import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isSemVer(value) {
  if (typeof value !== "string") return false;
  const match = semverPattern.exec(value);
  if (!match) return false;
  if (!match[4]) return true;
  return match[4].split(".").every((part) => !/^\d+$/u.test(part) || part === "0" || !part.startsWith("0"));
}

function semverParts(value) {
  const match = semverPattern.exec(value);
  if (!match) throw new Error(`Invalid SemVer: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareSemVer(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function sortVersions(versions) {
  return [...new Set(versions)].sort((left, right) => compareSemVer(right, left));
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function copyTree(source, destination) {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) throw new Error(`Refusing symlink in documentation tree: ${source}`);
  if (!sourceInfo.isDirectory()) throw new Error(`Documentation source must be a directory: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in documentation tree: ${from}`);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Unsupported documentation entry: ${from}`);
  }
}

async function replaceDirectory(source, destination) {
  const temporary = await mkdtemp(join(dirname(destination), ".docs-tree-"));
  try {
    await copyTree(source, temporary);
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function walkFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in documentation tree: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(directory);
  return files;
}

export async function collectRoutes(siteDirectory) {
  const pages = { root: [], ko: [] };
  if (!(await exists(siteDirectory))) return pages;
  for (const file of await walkFiles(siteDirectory)) {
    const fileRelative = relative(siteDirectory, file).split(sep).join("/");
    if (!fileRelative.endsWith(".html")) continue;
    const parts = fileRelative.split("/");
    const fileName = parts.pop();
    if (fileName === "404.html") continue;
    if (fileName !== "index.html") continue;
    const locale = parts[0] === "ko" ? "ko" : "root";
    const routeParts = locale === "ko" ? parts.slice(1) : parts;
    pages[locale].push(routeParts.join("/"));
  }
  pages.root = [...new Set(pages.root)].sort();
  pages.ko = [...new Set(pages.ko)].sort();
  return pages;
}

function emptyIndex() {
  return { stable: null, versions: [], pages: {} };
}

export async function readVersions(historyDirectory) {
  const path = join(historyDirectory, "versions.json");
  if (!(await exists(path))) return emptyIndex();
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid documentation versions.json: ${error.message}`);
  }
  if (!value || typeof value !== "object" || !Array.isArray(value.versions)) {
    throw new Error("Documentation versions.json must contain a versions array.");
  }
  if (value.stable !== null && value.stable !== undefined && !isSemVer(value.stable)) {
    throw new Error("Documentation versions.json stable must be null or a SemVer string.");
  }
  if (value.versions.some((entry) => !isSemVer(entry))) {
    throw new Error("Documentation versions.json versions must contain only SemVer strings.");
  }
  const versions = sortVersions(value.versions);
  if (new Set(value.versions).size !== value.versions.length) {
    throw new Error("Documentation versions.json versions must be unique.");
  }
  if (value.stable && !versions.includes(value.stable)) {
    throw new Error("Documentation versions.json stable must be present in versions.");
  }
  const pages = value.pages && typeof value.pages === "object" ? value.pages : {};
  return { stable: value.stable ?? null, versions, pages };
}

async function writeVersions(historyDirectory, index) {
  await mkdir(historyDirectory, { recursive: true });
  const path = join(historyDirectory, "versions.json");
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({
    stable: index.stable,
    versions: sortVersions(index.versions),
    pages: index.pages,
  }, null, 2)}\n`);
  await rename(temporary, path);
}

async function migrateLegacyLatest(historyDirectory, index) {
  const legacyDirectory = join(historyDirectory, "dev");
  const latestDirectory = join(historyDirectory, "latest");
  let changed = false;
  if (await exists(legacyDirectory)) {
    if (await exists(latestDirectory)) await rm(legacyDirectory, { recursive: true, force: true });
    else {
      await rename(legacyDirectory, latestDirectory);
      await rewriteLegacyBaseLinks(latestDirectory, "/SQLBraid/latest");
    }
    changed = true;
  }
  if (index.pages.dev !== undefined) {
    const pages = { ...index.pages };
    if (pages.latest === undefined) pages.latest = pages.dev;
    delete pages.dev;
    index = { ...index, pages };
    changed = true;
  }
  if (changed) await writeVersions(historyDirectory, index);
  return index;
}

async function git(rootDirectory, args) {
  try {
    const result = await execFileAsync("git", ["-C", rootDirectory, ...args], { encoding: "utf8" });
    return result.stdout.trim();
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export async function assertReleaseSource({ rootDirectory = root, version, commit, ref } = {}) {
  if (!isSemVer(version)) {
    throw new Error(`Release documentation version must be a SemVer: ${version}`);
  }
  if (!commit) throw new Error("Release documentation requires the checked-out commit SHA.");
  const manifest = JSON.parse(await readFile(join(rootDirectory, "package.json"), "utf8"));
  if (manifest.version !== version) throw new Error(`Release docs version ${version} differs from package version ${manifest.version}.`);
  const head = await git(rootDirectory, ["rev-parse", "HEAD"]);
  if (head !== commit) throw new Error(`Release docs source is ${head}, expected exact commit ${commit}.`);
  const tag = `v${version}`;
  const tagCommit = await git(rootDirectory, ["rev-parse", `refs/tags/${tag}^{commit}`]);
  if (tagCommit !== head) throw new Error(`Release docs source must be the exact ${tag} tag commit.`);
  const status = await git(rootDirectory, ["status", "--porcelain", "--untracked-files=no"]);
  if (status) throw new Error("Release docs source has tracked changes; build from the exact release checkout.");
  if (ref && ref !== tag && ref !== `refs/tags/${tag}`) {
    throw new Error(`Release docs ref must be ${tag}, received ${ref}.`);
  }
  return { head, tag };
}

export async function archiveRelease({
  sourceDirectory,
  historyDirectory,
  version,
  rootDirectory = root,
  commit,
  ref,
  verifySource = true,
} = {}) {
  if (!isSemVer(version)) {
    throw new Error(`Release documentation version must be a SemVer: ${version}`);
  }
  if (!sourceDirectory || !historyDirectory) throw new Error("Release archive requires sourceDirectory and historyDirectory.");
  if (verifySource) await assertReleaseSource({ rootDirectory, version, commit, ref });
  const index = await migrateLegacyLatest(historyDirectory, await readVersions(historyDirectory));
  const destination = join(historyDirectory, "v", version);
  if (await exists(destination)) {
    const provenancePath = join(destination, ".sqlbraid-source.json");
    const provenance = await exists(provenancePath) ? JSON.parse(await readFile(provenancePath, "utf8")) : undefined;
    if (!verifySource || (provenance && (provenance.commit !== commit || provenance.version !== version))) {
      throw new Error(`Documentation archive v/${version} already exists and cannot be overwritten.`);
    }
    // A deployment retry reuses the recorded archive, never the newly built tree.
  } else {
    await mkdir(dirname(destination), { recursive: true });
    const temporary = await mkdtemp(join(dirname(destination), `.v-${version}-`));
    try {
      await copyTree(sourceDirectory, temporary);
      if (verifySource) await writeFile(join(temporary, ".sqlbraid-source.json"), `${JSON.stringify({ version, commit })}\n`);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  const versions = sortVersions([...index.versions, version]);
  const next = {
    stable: versions.find((entry) => semverParts(entry).prerelease.length === 0) ?? null,
    versions,
    pages: { ...index.pages, [version]: await collectRoutes(destination) },
  };
  await writeVersions(historyDirectory, next);
  return next;
}

export async function syncLatest({ sourceDirectory, historyDirectory } = {}) {
  if (!sourceDirectory || !historyDirectory) throw new Error("Latest docs sync requires sourceDirectory and historyDirectory.");
  const destination = join(historyDirectory, "latest");
  await mkdir(historyDirectory, { recursive: true });
  await migrateLegacyLatest(historyDirectory, await readVersions(historyDirectory));
  await replaceDirectory(sourceDirectory, destination);
  const index = await readVersions(historyDirectory);
  const next = { ...index, pages: { ...index.pages, latest: await collectRoutes(destination) } };
  await writeVersions(historyDirectory, next);
  return next;
}

export function rootRedirect(stable, publicRoot = "/SQLBraid") {
  const target = stable ? `${publicRoot}/v/${stable}/` : `${publicRoot}/latest/`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><link rel="canonical" href="${target}"><title>SQLBraid documentation</title></head><body><p>Continue to <a href="${target}">SQLBraid documentation</a>.</p></body></html>\n`;
}

export async function rewriteLegacyBaseLinks(outputDirectory, base) {
  if (!outputDirectory || !base) throw new Error("Legacy documentation links require an output directory and base.");
  const normalizedBase = base.replace(/\/+$/u, "");
  for (const file of await walkFiles(outputDirectory)) {
    if (!/\.(?:html|css|m?js)$/u.test(file)) continue;
    const source = await readFile(file, "utf8");
    // Generated workers and stylesheets also embed their build's asset base.
    let rewritten = source.replaceAll("/SQLBraid/dev/", `${normalizedBase}/`);
    if (!file.endsWith(".html")) {
      if (rewritten !== source) await writeFile(file, rewritten);
      continue;
    }
    const localePrefix = relative(outputDirectory, file).split(sep)[0] === "ko" ? "ko/" : "";
    rewritten = rewritten.replace(/((?:href|src)=")(https:\/\/clickin\.github\.io)?\/SQLBraid\/(?!v\/)(latest\/)?([^"]*)/gu, (match, prefix, origin, channel, target) => {
      const isPage = prefix.startsWith("href=") && !channel && !target.startsWith("_") && !/\.[^/]+(?:[?#].*)?$/u.test(target);
      const localizedTarget = isPage && !target.startsWith("ko/") ? `${localePrefix}${target}` : target;
      return `${prefix}${origin ?? ""}${normalizedBase}/${localizedTarget}`;
    });
    if (rewritten !== source) await writeFile(file, rewritten);
  }
}

export async function releaseTags({ rootDirectory = root } = {}) {
  const tags = await git(rootDirectory, ["tag", "--list", "v*"]);
  return tags.split("\n").filter(Boolean)
    .map((tag) => ({ tag, version: tag.slice(1) }))
    .filter(({ version }) => isSemVer(version))
    .sort((left, right) => compareSemVer(right.version, left.version));
}

export async function missingReleaseTags({ historyDirectory, rootDirectory = root } = {}) {
  if (!historyDirectory) throw new Error("Missing documentation history directory.");
  const index = await readVersions(historyDirectory);
  const tags = await releaseTags({ rootDirectory });
  const missing = [];
  for (const entry of tags) {
    const destination = join(historyDirectory, "v", entry.version);
    if (!index.versions.includes(entry.version) || !(await exists(destination))) missing.push(entry);
  }
  for (const version of index.versions) {
    if (!(await exists(join(historyDirectory, "v", version)))
      && !tags.some((entry) => entry.version === version)) {
      throw new Error(`Documentation versions.json indexes a missing release archive v/${version}.`);
    }
  }
  return missing;
}

export async function stageDeployment({ historyDirectory, outputDirectory, latestDirectory, publicRoot = "/SQLBraid" } = {}) {
  if (!historyDirectory || !outputDirectory) throw new Error("Documentation deployment requires historyDirectory and outputDirectory.");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const index = await readVersions(historyDirectory);
  const versionsDirectory = join(historyDirectory, "v");
  if (await exists(versionsDirectory)) await copyTree(versionsDirectory, join(outputDirectory, "v"));
  let latestSource = latestDirectory ?? join(historyDirectory, "latest");
  if (!(await exists(latestSource))) {
    const legacySource = join(historyDirectory, "dev");
    if (await exists(legacySource)) latestSource = legacySource;
  }
  if (await exists(latestSource)) {
    await copyTree(latestSource, join(outputDirectory, "latest"));
    await rewriteLegacyBaseLinks(join(outputDirectory, "latest"), `${publicRoot}/latest`);
  }
  const pages = { ...index.pages };
  if (pages.dev !== undefined) {
    if (pages.latest === undefined) pages.latest = pages.dev;
    delete pages.dev;
  }
  for (const entry of ["latest", ...index.versions]) {
    const siteDirectory = entry === "latest" ? join(outputDirectory, "latest") : join(outputDirectory, "v", entry);
    if (await exists(siteDirectory)) pages[entry] = await collectRoutes(siteDirectory);
  }
  const stagedIndex = { ...index, pages };
  await writeFile(join(outputDirectory, "versions.json"), `${JSON.stringify(stagedIndex, null, 2)}\n`);
  await writeFile(join(outputDirectory, "index.html"), rootRedirect(stagedIndex.stable, publicRoot));
  if (!(await exists(join(outputDirectory, "404.html")))) {
    const fallback = join(outputDirectory, "latest", "404.html");
    const releaseFallback = stagedIndex.stable ? join(outputDirectory, "v", stagedIndex.stable, "404.html") : undefined;
    if (await exists(fallback)) await copyFile(fallback, join(outputDirectory, "404.html"));
    else if (releaseFallback && await exists(releaseFallback)) await copyFile(releaseFallback, join(outputDirectory, "404.html"));
  }
  return stagedIndex;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function cli(args) {
  const command = args[0];
  const historyDirectory = option(args, "--history", join(root, ".docs-history"));
  if (command === "assert-source" || command === "verify-source") {
    await assertReleaseSource({
      rootDirectory: option(args, "--root", root),
      version: required(args, "--version"),
      commit: required(args, "--commit"),
      ref: option(args, "--ref", process.env.GITHUB_REF),
    });
    return;
  }
  if (command === "versions") {
    const index = await readVersions(historyDirectory);
    process.stdout.write(`${JSON.stringify(index.versions)}\n`);
    return;
  }
  if (command === "archive" || command === "archive-release") {
    await archiveRelease({
      sourceDirectory: required(args, "--source"),
      historyDirectory,
      version: required(args, "--version"),
      rootDirectory: option(args, "--root", root),
      commit: option(args, "--commit", process.env.GITHUB_SHA),
      ref: option(args, "--ref", process.env.GITHUB_REF),
      verifySource: option(args, "--verify-source", "true") !== "false",
    });
    return;
  }
  if (command === "sync-latest") {
    await syncLatest({ sourceDirectory: required(args, "--source"), historyDirectory });
    return;
  }
  if (command === "rewrite-links") {
    await rewriteLegacyBaseLinks(required(args, "--source"), required(args, "--base"));
    return;
  }
  if (command === "missing-tags") {
    const missing = await missingReleaseTags({
      historyDirectory,
      rootDirectory: option(args, "--root", root),
    });
    process.stdout.write(`${JSON.stringify(missing)}\n`);
    return;
  }
  if (command === "stage" || command === "deploy") {
    await stageDeployment({
      historyDirectory,
      outputDirectory: required(args, "--output"),
      latestDirectory: option(args, "--latest-source"),
      publicRoot: option(args, "--public-root", "/SQLBraid"),
    });
    return;
  }
  throw new Error("Usage: docs-history.mjs assert-source|versions|archive|sync-latest|missing-tags|rewrite-links|stage");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR ${error.message}\n`);
    process.exitCode = 1;
  }
}
