import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tagPattern = /^(?:v|([a-z0-9][a-z0-9._-]*)-v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies", "engines"];
const commitTypes = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build and tooling"],
  ["ci", "Build and tooling"],
  ["chore", "Build and tooling"],
];

/** `v2.0.0` selects the `sqlbraid` facade. `postgres-v2.0.0` selects `@sqlbraid/postgres`. */
export function parseReleaseTag(tag) {
  const match = tagPattern.exec(tag);
  if (!match) throw new Error(`Tag ${tag} is not v<version> or <package>-v<version>.`);
  return { slug: match[1] ?? "sqlbraid", version: match[2] };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareVersions(left, right) {
  const [leftCore, leftPre] = left.split("-", 2);
  const [rightCore, rightPre] = right.split("-", 2);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  const leftIds = leftPre.split(".");
  const rightIds = rightPre.split(".");
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index += 1) {
    if (leftIds[index] === undefined) return -1;
    if (rightIds[index] === undefined) return 1;
    const result = compareIdentifiers(leftIds[index], rightIds[index]);
    if (result !== 0) return result;
  }
  return 0;
}

/**
 * The previous release of the same package: the highest lower version.
 * A stable release skips prereleases, so a stable line always compares with the last stable line.
 */
export function selectPreviousTag(tags, current) {
  const parsedCurrent = parseReleaseTag(current);
  const stable = !parsedCurrent.version.includes("-");
  const candidates = tags
    .map((tag) => {
      try {
        return { tag, ...parseReleaseTag(tag) };
      } catch {
        return undefined;
      }
    })
    .filter(
      (entry) =>
        entry &&
        entry.slug === parsedCurrent.slug &&
        compareVersions(entry.version, parsedCurrent.version) < 0 &&
        (!stable || !entry.version.includes("-")),
    )
    .toSorted((left, right) => compareVersions(right.version, left.version));
  return candidates[0]?.tag;
}

function flatten(value, prefix = "", output = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, output);
  } else if (prefix) {
    output[prefix] = JSON.stringify(value);
  }
  return output;
}

/** Compare the parts of two `package.json` files that decide what a consumer installs and imports. */
export function diffManifest(before, after) {
  const entries = [];
  const sections = [...dependencyFields, "exports", "bin"];
  for (const field of sections) {
    const left = flatten(before?.[field] ?? {});
    const right = flatten(after?.[field] ?? {});
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].toSorted()) {
      if (left[key] === right[key]) continue;
      const label =
        field === "exports"
          ? `exports["${key.replace(/\.(import|require|types|default|node)$/u, "")}"]`
          : `${field}.${key}`;
      entries.push({ field, key: label, before: left[key], after: right[key] });
    }
  }
  return entries;
}

const cell = (value) => (value === undefined ? "—" : `\`${JSON.parse(value)}\``);

function formatManifestDiff(entries) {
  if (entries.length === 0) return "No dependency, engine, export or bin changes.";
  return [
    "| Field | Before | After |",
    "| --- | --- | --- |",
    ...entries.map(({ key, before, after }) => `| \`${key}\` | ${cell(before)} | ${cell(after)} |`),
  ].join("\n");
}

/** Group conventional commit subjects. A `!` after the type marks a breaking change. */
export function groupCommits(commits) {
  const groups = new Map([["Breaking changes", []]]);
  for (const [, title] of commitTypes) groups.set(title, []);
  groups.set("Other", []);
  for (const { sha, subject } of commits) {
    const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/u.exec(subject);
    const line = `- ${match ? `${match[2] ? `**${match[2]}**: ` : ""}${match[4]}` : subject} (${sha.slice(0, 7)})`;
    if (match?.[3]) groups.get("Breaking changes").push(line);
    else groups.get(commitTypes.find(([type]) => type === match?.[1])?.[1] ?? "Other").push(line);
  }
  return [...groups].filter(([, lines]) => lines.length > 0);
}

export function renderNotes({ tag, packageName, version, previousTag, repo, message, manifestDiff, commits }) {
  const parts = [];
  parts.push(message);
  const install = packageName === "sqlbraid" ? "sqlbraid" : packageName;
  parts.push(`## Install\n\n\`\`\`sh\npnpm add ${install}@${version}\n\`\`\``);
  if (previousTag) {
    parts.push(
      `## Changes since ${previousTag}\n\n[Full diff](https://github.com/${repo}/compare/${previousTag}...${tag})\n\n### Package interface\n\n${formatManifestDiff(manifestDiff)}`,
    );
    const groups = groupCommits(commits);
    parts.push(
      groups.length === 0
        ? "### Commits\n\nNo commit changed this package directory."
        : `### Commits\n\n${groups.map(([title, lines]) => `**${title}**\n\n${lines.join("\n")}`).join("\n\n")}`,
    );
  } else {
    parts.push(`## Changes\n\nThis is the first release of \`${packageName}\` with a tag in this repository.`);
  }
  return `${parts.join("\n\n")}\n`;
}

async function git(...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitShowJson(ref, path) {
  try {
    return JSON.parse(await git("show", `${ref}:${path}`));
  } catch {
    return undefined;
  }
}

async function findPackageDirectory(ref, slug) {
  const wanted = slug === "sqlbraid" ? "sqlbraid" : `@sqlbraid/${slug}`;
  for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `packages/${entry.name}/package.json`;
    // oxlint-disable-next-line eslint/no-await-in-loop -- The package list is short and the first match ends the search.
    const manifest = await gitShowJson(ref, path);
    if (manifest?.name === wanted) return { directory: `packages/${entry.name}`, manifest };
  }
  throw new Error(`No package named ${wanted} at ${ref}.`);
}

/**
 * The message of an annotated tag. A lightweight tag has no message of its own: Git would return the
 * message of the commit it points at, so the tag object type is checked first.
 */
export async function readTagMessage(tag) {
  const [type, ...rest] = (await git("for-each-ref", `refs/tags/${tag}`, "--format=%(objecttype)%0a%(contents)")).split(
    "\n",
  );
  if (type !== "tag") {
    throw new Error(`Tag ${tag} must be annotated (git tag -a). Its message is the release summary.`);
  }
  const message = rest.join("\n").trim();
  if (!message) throw new Error(`Tag ${tag} has an empty message. Write the release summary in the tag message.`);
  return message;
}

/** Checks that need no network: the tag form, the annotation, and the package version at the tagged commit. */
export async function checkReleaseTag(tag) {
  const { slug, version } = parseReleaseTag(tag);
  const { directory, manifest } = await findPackageDirectory(tag, slug);
  if (manifest.version !== version) {
    throw new Error(`Tag ${tag} names ${version}, but ${directory}/package.json at the tag has ${manifest.version}.`);
  }
  return { slug, version, directory, manifest, message: await readTagMessage(tag) };
}

export async function generateReleaseNotes({ tag, previous, repo }) {
  const { slug, version, directory, manifest, message } = await checkReleaseTag(tag);
  const tags = (await git("tag", "--list")).split("\n").filter(Boolean);
  const previousTag = previous ?? selectPreviousTag(tags, tag);
  let manifestDiff = [];
  let commits = [];
  if (previousTag) {
    const before = (await findPackageDirectory(previousTag, slug).catch(() => undefined))?.manifest;
    manifestDiff = diffManifest(before, manifest);
    commits = (await git("log", "--no-merges", "--format=%H%x1f%s", `${previousTag}..${tag}`, "--", directory))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\u001f");
        return { sha, subject };
      });
  }
  return renderNotes({ tag, packageName: manifest.name, version, previousTag, repo, message, manifestDiff, commits });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The `pre-push` hook passes `<local ref> <local sha> <remote ref> <remote sha>` lines on stdin. */
async function checkPushedTags() {
  const tags = (await readStdin())
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([ref, sha]) => ref?.startsWith("refs/tags/") && !/^0+$/u.test(sha ?? ""))
    .map(([ref]) => ref.slice("refs/tags/".length))
    .filter((tag) => tagPattern.test(tag));
  for (const tag of tags) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Report the first failing tag; a push has few tags.
    await checkReleaseTag(tag);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--pre-push")) {
    await checkPushedTags().catch((error) => {
      process.stderr.write(`release tag check failed: ${error.message}\n`);
      process.exit(1);
    });
  } else {
    const tag = option("--tag");
    if (!tag)
      throw new Error(
        "Usage: node scripts/release-notes.mjs --tag <tag> [--check | [--previous <tag>] [--repo owner/name] [--out file]]\n       node scripts/release-notes.mjs --pre-push < ref-lines",
      );
    if (process.argv.includes("--check")) {
      await checkReleaseTag(tag);
    } else {
      const notes = await generateReleaseNotes({
        tag,
        previous: option("--previous"),
        repo: option("--repo") ?? process.env.GITHUB_REPOSITORY ?? "Clickin/SQLBraid",
      });
      const out = option("--out");
      if (out) await writeFile(out, notes);
      else process.stdout.write(notes);
    }
  }
}
