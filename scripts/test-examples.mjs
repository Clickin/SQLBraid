#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages");
const examplesRoot = join(root, "examples");
const temp = await mkdtemp(join(tmpdir(), "sqlbraid-examples-"));

async function run(command, args, cwd, env = {}) {
  try {
    return await execFile(command, args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const details = [error.stdout, error.stderr].filter((value) => value).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`, { cause: error });
  }
}

async function packageManifest(tarball) {
  const { stdout } = await run("tar", ["-xOf", tarball, "package/package.json"], root);
  return JSON.parse(stdout);
}

async function packPackages() {
  const tarballs = new Map();
  const packageEntries = (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of packageEntries) {
    const before = new Set(await readdir(temp));
    await run("pnpm", ["--dir", join(packageRoot, entry.name), "pack", "--pack-destination", temp], root);
    const added = (await readdir(temp)).filter((name) => name.endsWith(".tgz") && !before.has(name));
    assert.equal(added.length, 1, `expected one tarball for ${entry.name}`);
    const tarball = join(temp, added[0]);
    const manifest = await packageManifest(tarball);
    tarballs.set(manifest.name, { tarball, manifest });
  }
  assert.equal(tarballs.size, packageEntries.length, "every package must produce one tarball");
  console.info(`PASS packed ${tarballs.size} SQLBraid packages for external examples`);
  return tarballs;
}

async function installExample(name, tarballs) {
  const directory = join(temp, name);
  await cp(join(examplesRoot, name), directory, { recursive: true });
  const packageJsonPath = join(directory, "package.json");
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const included = new Set();
  function include(packageName) {
    if (!packageName.startsWith("@sqlbraid/") || included.has(packageName)) return;
    const packed = tarballs.get(packageName);
    assert.ok(packed, `missing packed dependency ${packageName}`);
    included.add(packageName);
    dependencies[packageName] = `file:${packed.tarball}`;
    for (const dependency of Object.keys({ ...packed.manifest.dependencies, ...packed.manifest.optionalDependencies })) include(dependency);
  }
  for (const name of Object.keys(dependencies)) include(name);
  await writeFile(packageJsonPath, `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
  console.info(`PASS ${name} installed from packed tarballs`);
  return directory;
}

async function cli(directory, args) {
  const executable = join(directory, "node_modules/@sqlbraid/cli/dist/index.js");
  return run(process.execPath, [executable, ...args], directory);
}

async function tsc(directory, args) {
  const executable = join(directory, "node_modules/typescript/bin/tsc");
  return run(process.execPath, [executable, ...args], directory);
}

async function compileAndRun(name, directory, environment = {}) {
  await cli(directory, ["build", "--file", "src/index.ts", "--out-file", "build/index.js"]);
  console.info(`PASS ${name} SQLBraid compiler lowering`);
  await tsc(directory, ["--project", "tsconfig.json", "--noEmit", "--pretty", "false"]);
  console.info(`PASS ${name} TypeScript compile against packed packages`);
  const result = await run(process.execPath, ["build/index.js"], directory, environment);
  process.stdout.write(result.stdout);
  console.info(`PASS ${name} runtime`);
}

async function runCodegen(directory) {
  const generated = await cli(directory, ["codegen", "--json"]);
  const generatedResults = JSON.parse(generated.stdout);
  assert.equal(generatedResults.length, 1);
  assert.equal(generatedResults[0].status, "written");
  console.info("PASS codegen snapshot/config -> CLI generate");

  await tsc(directory, ["--project", "tsconfig.json", "--pretty", "false"]);
  console.info("PASS codegen generated model TypeScript compile");

  const checked = await cli(directory, ["codegen", "--check", "--json"]);
  const checkedResults = JSON.parse(checked.stdout);
  assert.equal(checkedResults.length, 1);
  assert.equal(checkedResults[0].status, "unchanged");
  console.info("PASS codegen --check deterministic snapshot");
}

async function startPostgres() {
  const existing = process.env.SQLBRAID_POSTGRES_URL;
  if (existing) return { url: existing, stop: async () => {} };
  const container = await new PostgreSqlContainer("postgres:16.4-alpine")
    .withDatabase("sqlbraid")
    .withUsername("sqlbraid")
    .withPassword("sqlbraid")
    .start();
  return { url: container.getConnectionUri(), stop: () => container.stop() };
}

async function startMysql() {
  const existing = process.env.SQLBRAID_MYSQL_URL;
  if (existing) return { url: existing, stop: async () => {} };
  const container = await new MySqlContainer("mysql:8.4.2")
    .withDatabase("sqlbraid")
    .withUsername("sqlbraid")
    .withUserPassword("sqlbraid")
    .start();
  return { url: container.getConnectionUri(), stop: () => container.stop() };
}

let postgres;
let mysql;
try {
  const tarballs = await packPackages();
  const sqlite = await installExample("sqlite-quickstart", tarballs);
  const codegen = await installExample("codegen", tarballs);
  const postgresExample = await installExample("postgres", tarballs);
  const mysqlExample = await installExample("mysql", tarballs);

  const quickstart = await readFile(join(root, "website/src/content/docs/getting-started/sqlite.md"), "utf8");
  const source = /```ts\n([\s\S]*?)```/.exec(quickstart)?.[1];
  assert.ok(source, "the public SQLite quickstart must contain runnable TypeScript");
  await writeFile(join(sqlite, "src/docs-quickstart.ts"), source);
  await run(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    let rows;
    console.log = (value) => { rows = value; };
    await import("./src/docs-quickstart.ts");
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ id: "1", name: "Ada" }]);
  `], sqlite);
  console.info("PASS exact published SQLite quickstart without compiler lowering");
  await compileAndRun("sqlite", sqlite);
  await runCodegen(codegen);

  postgres = await startPostgres();
  await compileAndRun("postgres", postgresExample, { SQLBRAID_POSTGRES_URL: postgres.url });

  mysql = await startMysql();
  await compileAndRun("mysql", mysqlExample, { SQLBRAID_MYSQL_URL: mysql.url });
} finally {
  await Promise.allSettled([
    postgres?.stop?.(),
    mysql?.stop?.(),
  ]);
  await rm(temp, { recursive: true, force: true });
}
