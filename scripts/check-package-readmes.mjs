#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(root, "packages");
const canonicalDocsRoot = "https://clickin.github.io/SQLBraid/";

function exportKeys(exportsField) {
  if (exportsField === undefined) return new Set();
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return new Set(["."]);
  if (exportsField === null || typeof exportsField !== "object") return new Set();

  const keys = Object.keys(exportsField);
  return keys.some((key) => key.startsWith(".")) ? new Set(keys) : new Set(["."]);
}

function readFencedBlocks(text) {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const blocks = [];
  let current;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!current) {
      const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
      if (opening) current = { character: opening[1][0], length: opening[1].length, lines: [], start: index };
      continue;
    }

    const closing = line.match(/^\s{0,3}(`+|~+)\s*$/u);
    if (closing && closing[1][0] === current.character && closing[1].length >= current.length) {
      blocks.push(current);
      current = undefined;
    } else {
      current.lines.push({ text: line, number: index + 1 });
    }
  }
  if (current) blocks.push(current);
  return { blocks, lines };
}

function importsInBlock(block) {
  const patterns = [
    /\bfrom\s*["']([^"'\n]+)["']/gu,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/gu,
    /\bimport\s*["']([^"'\n]+)["']/gu,
  ];
  const imports = [];
  for (const { text, number } of block.lines) {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) imports.push({ specifier: match[1], number });
    }
  }
  return imports;
}

function packageImport(specifier, discovered) {
  for (const [packageName, manifest] of discovered) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      const suffix = specifier.slice(packageName.length);
      return { packageName, subpath: suffix ? `.${suffix}` : ".", manifest };
    }
  }

  let packageName;
  if (specifier === "sqlbraid" || specifier.startsWith("sqlbraid/")) {
    packageName = "sqlbraid";
  } else if (specifier.startsWith("@sqlbraid/")) {
    const parts = specifier.split("/");
    packageName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  } else {
    return undefined;
  }

  const manifest = discovered.get(packageName);
  if (!manifest) return { packageName, subpath: undefined, manifest: undefined };
  const suffix = specifier.slice(packageName.length);
  return {
    packageName,
    subpath: suffix ? `.${suffix}` : ".",
    manifest,
  };
}

async function discoverPackages() {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const manifests = new Map();
  const errors = [];

  for (const entry of entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const packageDir = join(packagesRoot, entry.name);
    const manifestPath = join(packageDir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      errors.push(`${relative(root, manifestPath)}: unable to read package manifest (${error.message})`);
      continue;
    }
    if (manifest.publishConfig?.access !== "public" || manifest.private === true) continue;
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      errors.push(`${relative(root, manifestPath)}: publishable package is missing a manifest name`);
      continue;
    }
    manifests.set(manifest.name, {
      directory: packageDir,
      name: manifest.name,
      exports: exportKeys(manifest.exports),
    });
  }
  return { manifests, errors };
}

async function checkPackage(readme, packageInfo) {
  const { blocks, lines } = readFencedBlocks(readme);
  const errors = [];
  const displayPath = relative(root, join(packageInfo.directory, "README.md"));

  const firstH1Number = lines.findIndex((line) => /^#(?!#)\s/u.test(line));
  const firstH1 = firstH1Number === -1 ? undefined : lines[firstH1Number];
  if (firstH1 !== `# ${packageInfo.name}`) {
    const number = firstH1Number === -1 ? 1 : firstH1Number + 1;
    errors.push(`${displayPath}:${number}: first H1 must be exactly "# ${packageInfo.name}"`);
  }
  if (!readme.includes(canonicalDocsRoot)) {
    errors.push(`${displayPath}: missing canonical docs link ${canonicalDocsRoot}`);
  }
  const installLine = lines.findIndex(
    (line) =>
      /\b(?:npm\s+(?:install|i)|pnpm\s+add|yarn\s+add|bun\s+add)\b/iu.test(line) && line.includes(packageInfo.name),
  );
  if (installLine === -1) {
    errors.push(`${displayPath}: missing an install command for ${packageInfo.name}`);
  }

  for (const block of blocks) {
    for (const imported of importsInBlock(block)) {
      const packageImportInfo = packageImport(imported.specifier, packageInfo.discovered);
      if (!packageImportInfo) continue;
      if (!packageImportInfo.manifest) {
        errors.push(
          `${displayPath}:${imported.number}: first-party import "${imported.specifier}" is not a discovered publishable package`,
        );
        continue;
      }
      if (!packageImportInfo.manifest.exports.has(packageImportInfo.subpath)) {
        const available = [...packageImportInfo.manifest.exports].sort().join(", ") || "(none)";
        errors.push(
          `${displayPath}:${imported.number}: import "${imported.specifier}" is not exported by ${packageImportInfo.packageName}; available exports: ${available}`,
        );
      }
    }
  }
  return errors;
}

async function main() {
  const { manifests, errors } = await discoverPackages();
  const packages = [...manifests.values()].sort((a, b) =>
    a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0,
  );
  for (const packageInfo of packages) {
    packageInfo.discovered = manifests;
    const readmePath = join(packageInfo.directory, "README.md");
    let readme;
    try {
      readme = await readFile(readmePath, "utf8");
    } catch (error) {
      errors.push(`${relative(root, readmePath)}: unable to read README.md (${error.message})`);
      continue;
    }
    errors.push(...(await checkPackage(readme, packageInfo)));
  }

  if (errors.length > 0) {
    console.error("Package README checks failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Package README checks passed for ${packages.length} publishable packages.`);
}

main().catch((error) => {
  console.error(`Package README checks failed: ${error.message}`);
  process.exitCode = 1;
});
