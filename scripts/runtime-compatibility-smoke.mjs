#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compatibility = JSON.parse(readFileSync(join(root, "support/runtime-compatibility.json"), "utf8"));
const cellId = process.env.SQLBRAID_COMPAT_CELL;
const cell = compatibility.cells.find(({ id }) => id === cellId);
if (!cell) throw new Error(`Unknown SQLBraid runtime compatibility cell: ${cellId ?? "unset"}`);
if (process.versions.node !== cell.runtime.version) {
  throw new Error(`Expected Node ${cell.runtime.version}; found ${process.versions.node}.`);
}

const packageDirectory = resolve(process.env.SQLBRAID_COMPAT_PACKAGE_DIR ?? join(root, ".compatibility-packages"));
const consumer = resolve(process.env.SQLBRAID_COMPAT_CONSUMER ?? mkdtempSync(join(tmpdir(), "sqlbraid-runtime-compat-")));
const tarballs = new Map();
for (const file of readdirSync(packageDirectory)) {
  if (!file.endsWith(".tgz")) continue;
  const path = join(packageDirectory, file);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
  if (tarballs.has(manifest.name)) throw new Error(`Duplicate packed artifact for ${manifest.name}.`);
  tarballs.set(manifest.name, path);
}
const dependencies = {};
for (const packageName of cell.packages) {
  const tarball = tarballs.get(packageName);
  if (!tarball) throw new Error(`${cell.id} is missing packed artifact ${packageName}.`);
  dependencies[packageName] = `file:${tarball}`;
}
if (cell.driver) dependencies[cell.driver.package] = cell.driver.version;
writeFileSync(join(consumer, "package.json"), JSON.stringify({
  name: `sqlbraid-runtime-compat-${cell.id}`,
  private: true,
  type: "module",
  dependencies,
}, null, 2));
execFileSync("npm", ["install", "--engine-strict", "--no-audit", "--no-fund"], {
  cwd: consumer,
  stdio: "inherit",
  env: { ...process.env, npm_config_engine_strict: "true" },
});
copyFileSync(join(root, "scripts/runtime-compatibility-consumer.mjs"), join(consumer, "runtime-compatibility-consumer.mjs"));
execFileSync(process.execPath, ["runtime-compatibility-consumer.mjs"], {
  cwd: consumer,
  stdio: "inherit",
  env: { ...process.env, SQLBRAID_COMPAT_DRIVER: cell.driver?.package ?? "" },
});
console.info(`PASS packed SQLBraid compatibility consumer: ${cell.id}`);
