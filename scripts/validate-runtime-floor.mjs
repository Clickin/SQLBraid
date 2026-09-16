#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const floorConfig = {
  target: "ES2021",
  lib: new Set(["ES2022"]),
};
const runtimePackages = ["core", "template", "runtime", "operations", "postgres", "mysql", "mariadb", "sqlite", "oracle", "mssql", "sqlbraid"];
const forbiddenRuntimeSyntax = [
  [/\bPromise\.withResolvers\b/u, "Promise.withResolvers (Node 22+)"],
  [/\bPromise\.try\b/u, "Promise.try (Node 23+)"],
  [/\bArray\.fromAsync\b/u, "Array.fromAsync (Node 22+)"],
  [/\bObject\.groupBy\b/u, "Object.groupBy (Node 21+)"],
  [/\bMap\.groupBy\b/u, "Map.groupBy (Node 21+)"],
  [/\.(?:toReversed|toSorted|toSpliced)\b/u, "ES2023 copying array method"],
];

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

async function validateRuntimeFloor({ root = scriptRoot, checkDist = true } = {}) {
  const config = JSON.parse(await readFile(join(root, "tsconfig.runtime-floor.json"), "utf8"));
  if (config.compilerOptions?.target !== floorConfig.target) fail("RUNTIME_FLOOR_CONFIG", "runtime-floor target must remain ES2021.");
  if (!Array.isArray(config.compilerOptions?.lib) || ![...floorConfig.lib].every((entry) => config.compilerOptions.lib.includes(entry))) {
    fail("RUNTIME_FLOOR_CONFIG", "runtime-floor lib must include ES2022.");
  }
  const files = [];
  for (const packageName of runtimePackages) {
    const packageRoot = join(root, "packages", packageName);
    const sourceManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (sourceManifest.engines?.node !== ">=16.20.2") fail("RUNTIME_FLOOR_ENGINE", `${sourceManifest.name} is not a Node 16.20.2 runtime package.`);
    if (!checkDist) continue;
    const dist = join(packageRoot, "dist");
    let entries;
    try {
      entries = await readdir(dist, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") fail("RUNTIME_FLOOR_BUILD", `Missing built output for ${sourceManifest.name}.`);
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/u.test(entry.name)) continue;
      files.push(join(entry.parentPath, entry.name));
    }
  }
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const [pattern, api] of forbiddenRuntimeSyntax) if (pattern.test(text)) {
      fail("RUNTIME_FLOOR_API", `${file} contains ${api}.`);
    }
  }
  return { target: floorConfig.target, packages: runtimePackages, files: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await validateRuntimeFloor({ checkDist: process.argv.includes("--dist") });
    console.info(`Runtime floor guard valid: ${result.target}, ${result.packages.length} packages${process.argv.includes("--dist") ? `, ${result.files} emitted files` : ""}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { validateRuntimeFloor };
