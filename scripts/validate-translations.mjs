import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(root, "website", "src", "content", "docs");
const registryPath = join(root, "website", "translation-registry.json");

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && /\.(?:md|mdx)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(messages) {
  if (messages.length === 0) return;
  throw new Error(messages.join("\n"));
}

const registry = JSON.parse(await readFile(registryPath, "utf8"));
if (!registry || registry.version !== 1 || registry.sourceLocale !== "en" || registry.targetLocale !== "ko" || !Array.isArray(registry.entries)) {
  throw new Error("Translation registry must declare version 1, en/ko locales, and an entries array.");
}

const entries = new Map();
const errors = [];
for (const entry of registry.entries) {
  if (!entry || typeof entry.source !== "string" || typeof entry.translation !== "string") {
    errors.push("DOCS_TRANSLATION_REGISTRY: every entry needs source and translation paths");
    continue;
  }
  if (entries.has(entry.source)) errors.push(`DOCS_TRANSLATION_REGISTRY: duplicate source ${entry.source}`);
  entries.set(entry.source, entry);
  if (entry.translationOf !== entry.source) {
    errors.push(`DOCS_TRANSLATION_REGISTRY: ${entry.source} must set translationOf to itself`);
  }
  if (entry.optOut === true) {
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      errors.push(`DOCS_TRANSLATION_REGISTRY: opt-out ${entry.source} requires a reason`);
    }
    continue;
  }
  if (typeof entry.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sourceDigest)) {
    errors.push(`DOCS_TRANSLATION_REGISTRY: tracked ${entry.source} requires a SHA-256 sourceDigest`);
  }
}

const sourceFiles = (await walk(docsRoot))
  .filter((path) => !path.split(sep).includes("ko"))
  .map((path) => relative(root, path).split(sep).join("/"));
const sourceSet = new Set(sourceFiles);
for (const source of sourceFiles) {
  if (!entries.has(source)) errors.push(`DOCS_TRANSLATION_REGISTRY: missing page entry for ${source}`);
}
for (const source of entries.keys()) {
  if (!sourceSet.has(source)) errors.push(`DOCS_TRANSLATION_REGISTRY: source does not exist: ${source}`);
}

for (const entry of entries.values()) {
  const sourcePath = join(root, entry.source);
  const translationPath = join(root, entry.translation);
  try {
    await stat(sourcePath);
    await stat(translationPath);
  } catch {
    errors.push(`DOCS_TRANSLATION_MISSING: ${entry.source} -> ${entry.translation}`);
    continue;
  }
  if (entry.optOut === true) continue;
  const actual = digest(await readFile(sourcePath));
  if (actual !== entry.sourceDigest) {
    errors.push(`DOCS_TRANSLATION_STALE: ${entry.source} -> ${entry.translation}; expected sourceDigest ${entry.sourceDigest}, found ${actual}. Update the Korean prose and registry digest, or add an explicit opt-out with a reason. No automatic translation is performed.`);
  }
}

fail(errors);
console.log(`PASS translation registry: ${entries.size} EN pages checked (${[...entries.values()].filter((entry) => entry.optOut === true).length} explicit opt-outs)`);
