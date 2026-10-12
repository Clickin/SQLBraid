#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = join(root, "packages");
const examplesRoot = join(root, "examples");
const temp = await mkdtemp(join(tmpdir(), "sqlbraid-examples-"));
const packInputDir = process.env.SQLBRAID_PACK_INPUT_DIR ? resolve(process.env.SQLBRAID_PACK_INPUT_DIR) : undefined;

function isFirstPartyPackage(packageName) {
  return packageName === "sqlbraid" || packageName.startsWith("@sqlbraid/");
}

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

async function suppliedPackages() {
  let entries;
  try {
    entries = await readdir(packInputDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read supplied SQLBraid artifacts at ${packInputDir}`, { cause: error });
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => entry.name)
    .sort();
  assert.ok(files.length > 0, `No .tgz artifacts found in ${packInputDir}`);

  const tarballs = new Map();
  for (const file of files) {
    const tarball = join(packInputDir, file);
    let manifest;
    try {
      manifest = await packageManifest(tarball);
    } catch (error) {
      throw new Error(`Malformed supplied SQLBraid artifact ${file}`, { cause: error });
    }
    assert.ok(
      manifest && typeof manifest === "object" && typeof manifest.name === "string" && manifest.name.length > 0,
      `Supplied artifact ${file} has an invalid package manifest`,
    );
    assert.ok(isFirstPartyPackage(manifest.name), `Unexpected non-first-party supplied artifact ${manifest.name}`);
    assert.ok(!tarballs.has(manifest.name), `Duplicate supplied artifact for ${manifest.name}`);
    tarballs.set(manifest.name, { tarball, manifest });
  }
  const packageEntries = (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => (entry.name === "sqlbraid" ? "sqlbraid" : `@sqlbraid/${entry.name}`));
  for (const packageName of packageEntries) {
    assert.ok(tarballs.has(packageName), `Missing supplied first-party artifact for ${packageName}`);
  }
  assert.equal(tarballs.size, packageEntries.length, "supplied artifacts must cover every workspace package");
  console.info(`PASS loaded ${tarballs.size} supplied SQLBraid package artifacts`);
  return tarballs;
}

async function packPackages() {
  if (packInputDir) return suppliedPackages();

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
    assert.ok(
      manifest && typeof manifest.name === "string" && manifest.name.length > 0,
      `invalid package manifest for ${entry.name}`,
    );
    assert.ok(!tarballs.has(manifest.name), `duplicate package manifest for ${manifest.name}`);
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
  const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies"];
  const dependencies = Object.fromEntries(dependencyFields.map((field) => [field, { ...manifest[field] }]));
  const included = new Set();
  function include(packageName) {
    if (!isFirstPartyPackage(packageName) || included.has(packageName)) return;
    const packed = tarballs.get(packageName);
    assert.ok(packed, `missing packed dependency ${packageName}`);
    included.add(packageName);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(packed.manifest[field] ?? {})) include(dependency);
    }
  }

  for (const field of dependencyFields) {
    for (const packageName of Object.keys(dependencies[field])) {
      if (!isFirstPartyPackage(packageName)) continue;
      include(packageName);
      dependencies[field][packageName] = `file:${tarballs.get(packageName).tarball}`;
    }
  }
  for (const packageName of included) {
    if (dependencyFields.some((field) => Object.hasOwn(dependencies[field], packageName))) continue;
    dependencies.dependencies[packageName] = `file:${tarballs.get(packageName).tarball}`;
  }

  await writeFile(packageJsonPath, `${JSON.stringify({ ...manifest, ...dependencies }, null, 2)}\n`);
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

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function checkNextApp(base) {
  const names = async (path) => (await (await fetch(base + path)).json()).map((row) => row.name);
  // A missing `q` must not evaluate `filter.q!.trim()`. This needs the SQLBraid loader.
  assert.equal((await names("/api/products")).length, 5);
  assert.deepEqual(await names("/api/products?category=coffee&inStock=true&sort=price"), [
    "Espresso beans 1kg",
    "Hand grinder",
  ]);
  assert.deepEqual(await names("/api/products?q=mug"), ["Ceramic mug"]);
  assert.deepEqual(await names("/api/products?maxPrice=20&sort=price"), ["Filter paper", "Ceramic mug"]);
  const filter = (await (await fetch(`${base}/api/products?q=Filter`)).json())[0];
  assert.equal(typeof filter.priceCents, "string");
  const post = (body) =>
    fetch(`${base}/api/restock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const restocked = await post({ id: 2, amount: 5 });
  assert.equal(restocked.status, 200);
  assert.equal((await restocked.json()).stock, "5");
  assert.equal((await post({ id: 999, amount: 5 })).status, 404);
  assert.equal((await post({ id: 2, amount: -1 })).status, 400);
  const html = await (await fetch(`${base}/?category=kitchen&inStock=on`)).text();
  assert.ok(html.includes("Ceramic mug") && html.includes("Milk jug") && !html.includes("Hand grinder"));
}

async function nextExample(name, directory, bundler) {
  const next = join(directory, "node_modules/next/dist/bin/next");
  const environment = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
  await run(process.execPath, [next, "build", `--${bundler}`], directory, environment);
  const port = await freePort();
  const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (data) => (log += data));
  child.stderr.on("data", (data) => (log += data));
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fetch(`${base}/api/products`);
        break;
      } catch (error) {
        assert.ok(attempt < 60, `Next.js did not start:\n${log}`, { cause: error });
        await new Promise((done) => setTimeout(done, 500));
      }
    }
    await checkNextApp(base);
    console.info(`PASS ${name} Next.js ${bundler} build and server`);
  } finally {
    child.kill();
  }
}

let postgres;
let mysql;
try {
  const tarballs = await packPackages();
  const sqlite = await installExample("sqlite-quickstart", tarballs);
  const codegen = await installExample("codegen", tarballs);
  const postgresExample = await installExample("postgres", tarballs);
  const mysqlExample = await installExample("mysql", tarballs);
  const bookstore = await installExample("bookstore-api", tarballs);

  for (const path of ["website/src/content/docs/getting-started/sqlite.md", "README.md"]) {
    const quickstart = await readFile(join(root, path), "utf8");
    const source = [...quickstart.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .find((block) => block.includes("createNodeSqliteDatabase"));
    assert.ok(source, `${path} must contain a runnable SQLite quickstart`);
    await writeFile(join(sqlite, "src/docs-quickstart.ts"), source);
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
    import assert from "node:assert/strict";
    let rows;
    console.log = (value) => { rows = value; };
    await import("./src/docs-quickstart.ts");
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ id: "1", name: "Ada" }]);
  `,
      ],
      sqlite,
    );
    console.info(`PASS exact ${path} SQLite quickstart without compiler lowering`);
  }
  await compileAndRun("sqlite", sqlite);
  await runCodegen(codegen);

  for (const bundler of ["webpack", "turbopack"]) {
    const nextDirectory = await installExample("nextjs-webpack", tarballs);
    await nextExample("nextjs-webpack", nextDirectory, bundler);
    await rm(nextDirectory, { recursive: true, force: true });
  }

  postgres = await startPostgres();
  await compileAndRun("postgres", postgresExample, { SQLBRAID_POSTGRES_URL: postgres.url });
  const openTelemetry = await installExample("opentelemetry-slow-query", tarballs);
  await compileAndRun("opentelemetry-slow-query", openTelemetry, { SQLBRAID_POSTGRES_URL: postgres.url });

  await tsc(bookstore, ["--project", "tsconfig.json", "--noEmit", "--pretty", "false"]);
  const smoke = await run(process.execPath, ["src/smoke.ts"], bookstore, { SQLBRAID_POSTGRES_URL: postgres.url });
  process.stdout.write(smoke.stdout);
  console.info("PASS bookstore-api migrations, search, transaction and stream");

  mysql = await startMysql();
  await compileAndRun("mysql", mysqlExample, { SQLBRAID_MYSQL_URL: mysql.url });
} finally {
  await Promise.allSettled([postgres?.stop?.(), mysql?.stop?.()]);
  await rm(temp, { recursive: true, force: true });
}
