#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const temp = await realpath(await mkdtemp(join(tmpdir(), "driver-extraction-packed-")));
const consumer = join(temp, "consumer");
let container;
let primaryError;

function run(command, args, cwd, env = process.env) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? done() : reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code}).`)),
    );
  });
}

try {
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "driver-extraction-consumer", private: true, type: "module" }),
  );
  await run("pnpm", ["--dir", join(root, "experiments/driver-extraction"), "pack", "--pack-destination", temp], root);
  const tarballs = (await readdir(temp)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  await run(
    "pnpm",
    ["add", "--save-exact", "--ignore-scripts", join(temp, tarballs[0]), "pg@8.23.0", "kysely@0.29.7"],
    consumer,
  );
  const installedPath = await realpath(join(consumer, "node_modules/@execution-lab/driver"));
  assert.ok(
    installedPath.startsWith(`${temp}/`),
    "The consumer must load a packed installation, not a workspace symlink.",
  );
  const manifest = JSON.parse(await readFile(join(installedPath, "package.json"), "utf8"));
  assert.equal(manifest.name, "@execution-lab/driver");
  for (const dependencies of [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
    assert.ok(!Object.keys(dependencies ?? {}).some((name) => name === "sqlbraid" || name.startsWith("@sqlbraid/")));
  }
  for (const name of ["faults.mjs", "sqlite.mjs", "pg.mjs", "kysely.mjs"]) {
    await copyFile(join(here, name), join(consumer, name));
  }
  await run(process.execPath, ["--test", "faults.mjs"], consumer);
  await run(process.execPath, ["sqlite.mjs"], consumer);

  // Always own the database. Never infer permission to modify an environment-provided server.
  const target = JSON.parse(await readFile(join(root, "support/targets/postgres.json"), "utf8"));
  container = await new PostgreSqlContainer(target.reproducibility.image)
    .withDatabase("driver_extraction")
    .withUsername("driver_extraction")
    .withPassword("driver_extraction")
    .start();
  const connectionString = container.getConnectionUri();
  const env = { ...process.env, DRIVER_EXPERIMENT_DATABASE_URL: connectionString };
  await run(process.execPath, ["pg.mjs"], consumer, env);
  await run(process.execPath, ["kysely.mjs"], consumer, env);
  console.log(
    "Packed driver extraction checks passed: isolated consumer, pg 8.23.0, Kysely 0.29.7, node:sqlite, lifecycle faults.",
  );
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const errors = [];
  if (container) {
    try {
      await container.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await rm(temp, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(primaryError ? [primaryError, ...errors] : errors, "Packed runner cleanup failed.");
}
