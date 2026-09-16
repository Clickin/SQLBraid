#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv/dist/2020.js";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedPackageEngines = Object.freeze({
  "@sqlbraid/core": ">=16.20.2",
  "@sqlbraid/template": ">=16.20.2",
  "@sqlbraid/runtime": ">=16.20.2",
  "@sqlbraid/operations": ">=16.20.2",
  "@sqlbraid/postgres": ">=16.20.2",
  "@sqlbraid/mysql": ">=16.20.2",
  "@sqlbraid/mariadb": ">=16.20.2",
  "@sqlbraid/sqlite": ">=16.20.2",
  "@sqlbraid/oracle": ">=16.20.2",
  "@sqlbraid/mssql": ">=16.20.2",
  sqlbraid: ">=16.20.2",
  "@sqlbraid/metadata": ">=22.18.0",
  "@sqlbraid/compiler": ">=22.18.0",
  "@sqlbraid/codegen": ">=22.18.0",
  "@sqlbraid/vite": ">=22.18.0",
  "@sqlbraid/tooling": ">=22.18.0",
  "@sqlbraid/cli": ">=22.18.0",
  "@sqlbraid/language-server": ">=22.18.0",
});
const requiredCells = new Set([
  "node-16-20-2-runtime",
  "node-16-20-2-better-sqlite3-9-6-0",
  "node-22-18-0-better-sqlite3-13-0-3",
  "node-16-20-2-libsql-0-18-0",
]);

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail("RUNTIME_COMPATIBILITY_FILE", `${path}: ${error.message}`);
  }
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function assertExactVersion(value, label) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/u.test(value)) {
    fail("RUNTIME_COMPATIBILITY_VERSION", `${label} must be an exact numeric x.y.z version.`);
  }
}

function assertEngineCompatible(engine, runtimeVersion, packageName) {
  const match = /^>=(\d+\.\d+\.\d+)$/u.exec(engine ?? "");
  if (!match || compareVersions(runtimeVersion, match[1]) < 0) {
    fail("RUNTIME_COMPATIBILITY_ENGINE", `${packageName} declares ${engine ?? "no engine"}, incompatible with Node ${runtimeVersion}.`);
  }
}

async function validateRuntimeCompatibility({ root = scriptRoot } = {}) {
  const manifestPath = join(root, "support/runtime-compatibility.json");
  const schemaPath = join(root, "support/runtime-compatibility.schema.json");
  const manifest = await json(manifestPath);
  const schema = await json(schemaPath);
  const ajv = new Ajv({ allErrors: true, strict: true });
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    fail("RUNTIME_COMPATIBILITY_SCHEMA", error.message);
  }
  if (!validate(manifest)) {
    fail("RUNTIME_COMPATIBILITY_SCHEMA", ajv.errorsText(validate.errors, { separator: "\n" }));
  }

  const packageDirectories = await readdir(join(root, "packages"), { withFileTypes: true });
  const packages = new Map();
  for (const directory of packageDirectories) {
    if (!directory.isDirectory()) continue;
    const path = join(root, "packages", directory.name, "package.json");
    try {
      const packageManifest = await json(path);
      packages.set(packageManifest.name, packageManifest);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const actualNames = Object.keys(manifest.packageEngines).sort();
  const expectedNames = Object.keys(expectedPackageEngines).sort();
  assert.deepEqual(actualNames, expectedNames, "runtime compatibility package classification changed unexpectedly");
  for (const [packageName, expectedEngine] of Object.entries(expectedPackageEngines)) {
    const packageManifest = packages.get(packageName);
    if (!packageManifest) fail("RUNTIME_COMPATIBILITY_PACKAGE", `Missing published package ${packageName}.`);
    if (manifest.packageEngines[packageName] !== expectedEngine) {
      fail("RUNTIME_COMPATIBILITY_CLASSIFICATION", `${packageName} must be classified at ${expectedEngine}.`);
    }
    if (packageManifest.engines?.node !== expectedEngine) {
      fail("RUNTIME_COMPATIBILITY_ENGINE", `${packageName} manifest must declare ${expectedEngine}; found ${packageManifest.engines?.node ?? "missing"}.`);
    }
  }
  const bunSql = packages.get("@sqlbraid/bun-sql");
  if (!bunSql || bunSql.engines?.bun !== ">=1.3.14" || bunSql.engines?.node !== undefined) {
    fail("RUNTIME_COMPATIBILITY_ENGINE", "@sqlbraid/bun-sql must retain its Bun-only engine declaration.");
  }

  const ids = new Set();
  const blockingCells = [];
  for (const cell of manifest.cells) {
    if (ids.has(cell.id)) fail("RUNTIME_COMPATIBILITY_DUPLICATE", `Duplicate compatibility cell ${cell.id}.`);
    ids.add(cell.id);
    assertExactVersion(cell.runtime.version, `${cell.id}.runtime.version`);
    if (cell.runtime.id !== "node") fail("RUNTIME_COMPATIBILITY_RUNTIME", `${cell.id} must use Node.`);
    for (const packageName of cell.packages) {
      if (!packages.has(packageName)) fail("RUNTIME_COMPATIBILITY_PACKAGE", `${cell.id} references unknown package ${packageName}.`);
      const packageEngine = manifest.packageEngines[packageName];
      if (packageEngine) assertEngineCompatible(packageEngine, cell.runtime.version, packageName);
    }
    if (cell.driver) {
      assertExactVersion(cell.driver.version, `${cell.id}.driver.version`);
      if (cell.driver.package !== "better-sqlite3" && cell.driver.package !== "@libsql/client") {
        fail("RUNTIME_COMPATIBILITY_DRIVER", `${cell.id} has an unregistered driver ${cell.driver.package}.`);
      }
    }
    const smokePath = join(root, cell.smoke.entrypoint);
    try {
      await access(smokePath);
    } catch {
      fail("RUNTIME_COMPATIBILITY_SMOKE", `${cell.id} references missing ${cell.smoke.entrypoint}.`);
    }
    if (cell.releaseBlocking) blockingCells.push(cell.id);
  }
  for (const required of requiredCells) if (!ids.has(required)) fail("RUNTIME_COMPATIBILITY_CELL", `Missing required exact cell ${required}.`);
  if (!blockingCells.length) fail("RUNTIME_COMPATIBILITY_CI", "At least one compatibility cell must be release-blocking.");
  return {
    manifest,
    packageNames: expectedNames,
    cells: manifest.cells.map(({ id }) => id),
    blockingCells,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await validateRuntimeCompatibility();
    console.info(`Runtime compatibility manifest valid: ${result.cells.length} exact cells, ${result.blockingCells.length} release-blocking.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { compareVersions, expectedPackageEngines, validateRuntimeCompatibility };
