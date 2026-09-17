#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageRoot = join(root, "packages");
const supplied = process.env.SQLBRAID_PACK_INPUT_DIR;
const output = resolve(supplied ?? process.env.SQLBRAID_PACK_OUTPUT_DIR ?? join(root, ".compatibility-packages"));
const packageNames = (await readdir(packageRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (supplied) {
  const artifacts = (await readdir(output)).filter((name) => name.endsWith(".tgz"));
  if (artifacts.length < packageNames.length)
    throw new Error(
      `Expected at least ${packageNames.length} supplied package artifacts in ${output}; found ${artifacts.length}.`,
    );
  console.info(`Reusing ${artifacts.length} supplied package artifacts from ${output}`);
} else {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const packageName of packageNames) {
    execFileSync("pnpm", ["--dir", join(packageRoot, packageName), "pack", "--pack-destination", output], {
      cwd: root,
      stdio: "inherit",
    });
  }
  console.info(`Prepared ${packageNames.length} package artifacts in ${output}`);
}
