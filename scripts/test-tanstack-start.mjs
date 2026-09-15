#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "tests", "fixtures", "tanstack-start-finance");
const script = fileURLToPath(import.meta.url);

async function reexecOnNode24() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major === 24 || process.env.SQLBRAID_FINANCE_NODE_BOOTSTRAPPED === "1") {
    if (major !== 24) {
      throw new Error("TanStack Start finance gate requires Node 24; SQLBRAID_FINANCE_NODE points to a non-Node-24 executable.");
    }
    return false;
  }
  const executable = process.env.SQLBRAID_FINANCE_NODE;
  if (!executable) {
    throw new Error(`TanStack Start finance gate requires Node 24 (found ${process.versions.node}); set SQLBRAID_FINANCE_NODE to an explicit Node 24 executable.`);
  }
  const child = spawn(executable, [script, ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, SQLBRAID_FINANCE_NODE_BOOTSTRAPPED: "1" },
    stdio: "inherit",
  });
  await new Promise((resolveChild, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Node 24 finance gate exited from ${signal}.`));
      else if (code !== 0) reject(new Error(`Node 24 finance gate exited with code ${code}.`));
      else resolveChild();
    });
  });
  return true;
}

async function packageManifest(directory) {
  return JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
}

function localPackageDirectory(name) {
  if (name === "sqlbraid") return join(root, "packages", "sqlbraid");
  if (!name.startsWith("@sqlbraid/")) return undefined;
  return join(root, "packages", name.slice("@sqlbraid/".length));
}

function dependencyEntries(manifest) {
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  }).filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"));
}

async function packSqlbraidPackages(app, packageDirectory) {
  const appManifest = await packageManifest(app);
  const names = new Set(
    Object.keys({ ...appManifest.dependencies, ...appManifest.devDependencies })
      .filter((name) => name.startsWith("@sqlbraid/")),
  );
  const manifests = new Map();
  for (const name of names) {
    const directory = localPackageDirectory(name);
    if (!directory) throw new Error(`No workspace package directory for ${name}.`);
    const manifest = await packageManifest(directory);
    manifests.set(name, manifest);
  }
  const pending = [...names];
  for (let index = 0; index < pending.length; index += 1) {
    const name = pending[index];
    for (const [dependency] of dependencyEntries(manifests.get(name))) {
      if (!dependency.startsWith("@sqlbraid/") || names.has(dependency)) continue;
      const directory = localPackageDirectory(dependency);
      if (!directory) throw new Error(`No workspace package directory for ${dependency}.`);
      names.add(dependency);
      manifests.set(dependency, await packageManifest(directory));
      pending.push(dependency);
    }
  }

  const tarballs = new Map();
  for (const name of names) {
    const directory = localPackageDirectory(name);
    const before = new Set((await readdir(packageDirectory)).filter((entry) => entry.endsWith(".tgz")));
    await execFile("pnpm", ["--dir", directory, "pack", "--pack-destination", packageDirectory], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    const added = (await readdir(packageDirectory)).filter((entry) => entry.endsWith(".tgz") && !before.has(entry));
    if (added.length !== 1) throw new Error(`Expected one tarball for ${name}, found ${added.length}.`);
    tarballs.set(name, join(packageDirectory, added[0]));
  }

  const localPath = (tarball) => {
    const path = relative(app, tarball).replaceAll("\\", "/");
    return path.startsWith(".") ? path : `./${path}`;
  };
  for (const [section, values] of [["dependencies", appManifest.dependencies], ["devDependencies", appManifest.devDependencies]]) {
    for (const name of Object.keys(values ?? {})) {
      const tarball = tarballs.get(name);
      if (tarball) values[name] = localPath(tarball);
    }
    appManifest[section] = values;
  }
  for (const [name, tarball] of tarballs) {
    if (appManifest.dependencies?.[name] || appManifest.devDependencies?.[name]) continue;
    appManifest.dependencies ??= {};
    appManifest.dependencies[name] = localPath(tarball);
  }
  await writeFile(join(app, "package.json"), `${JSON.stringify(appManifest, null, 2)}\n`);
  return tarballs;
}

async function run(command, args, cwd, env = {}) {
  const result = await execFile(command, args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 40 * 1024 * 1024,
  });
  return `${result.stdout}${result.stderr}`;
}

async function filesUnder(directory) {
  const output = [];
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    output.push(join(entry.parentPath, entry.name));
  }
  return output;
}

async function stopProcess(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveChild) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveChild();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveChild();
    });
  });
}

function startProcess(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.output = () => output;
  return child;
}

async function waitForHttp(url, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before ${url}: ${child.output()}`);
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok) return body;
      lastError = `${response.status}: ${body}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}\n${child.output()}`);
}

async function fetchTransformed(base, path, child, expected = "", timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before transforming ${path}: ${child.output()}`);
    try {
      const response = await fetch(new URL(path, base));
      const body = await response.text();
      if (response.ok && body.length > 0 && body.includes(expected)) return body;
      lastError = `${response.status}: ${body}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for Vite transform ${path}: ${lastError}\n${child.output()}`);
}

async function sourceMapFor(code, base, sourcePath, child) {
  const marker = code.match(/sourceMappingURL=([^\s]+)/u)?.[1];
  if (!marker) throw new Error(`Vite transform for ${sourcePath} did not return a source map.`);
  if (marker.startsWith("data:")) {
    const comma = marker.indexOf(",");
    const payload = marker.slice(comma + 1);
    return JSON.parse(marker.includes(";base64,")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload));
  }
  const response = await fetch(new URL(marker, base));
  if (!response.ok) throw new Error(`Unable to fetch source map for ${sourcePath}: ${response.status}`);
  return response.json();
}

function assertUnicodeSourceMap(map, sourcePath) {
  assert.equal(map.version, 3, `source map for ${sourcePath} was not a v3 map`);
  assert.ok(typeof map.mappings === "string" && map.mappings.length > 0, `source map for ${sourcePath} was empty`);
  assert.ok(Array.isArray(map.sources) && map.sources.some((source) => source.endsWith(sourcePath)), `source map did not point to ${sourcePath}`);
  assert.ok(Array.isArray(map.sourcesContent) && map.sourcesContent.some((source) => source?.includes("재무 거래") && source.includes("고객")), `source map for ${sourcePath} lost Korean source content`);
}

async function assertClientBundleSafe(app) {
  const publicDirectory = join(app, ".output", "public");
  const files = await filesUnder(publicDirectory);
  const assets = files.filter((file) => /\.(?:js|mjs|map)$/u.test(file));
  assert.ok(assets.length > 0, "TanStack Start production build emitted no client assets.");
  const clientText = (await Promise.all(assets.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(clientText, /node:sqlite|@sqlbraid\/sqlite\/node-sqlite|DatabaseSync|createNodeSqliteDatabase|(?:^|[/@"'])(?:pg|mysql2|oracledb|tedious)(?:[/@"'])/iu, "SQLite or a database driver leaked into the client bundle.");
}

async function main() {
  if (await reexecOnNode24()) return;
  const temp = await mkdtemp(join(tmpdir(), "sqlbraid-tanstack-start-"));
  const app = join(temp, "app");
  const packageDirectory = join(temp, "packages");
  await cp(fixture, app, { recursive: true });
  await mkdir(packageDirectory, { recursive: true });
  let dev;
  let production;
  let keep = process.env.SQLBRAID_KEEP_FINANCE === "1";
  const port = 48_000 + Math.floor(Math.random() * 1_000);
  const productionPort = port + 1;
  const transformBase = `http://127.0.0.1:${port}/`;
  try {
    const sourceFiles = await filesUnder(app);
    const sourceText = (await Promise.all(sourceFiles.filter((file) => /\.(?:ts|tsx|js|jsx|json)$/u.test(file)).map((file) => readFile(file, "utf8")))).join("\n");
    assert.doesNotMatch(sourceText, /(?:packages\/|workspace:|file:\.\.?\/(?:packages|src))/u, "Finance fixture contains a workspace-source import.");
    await packSqlbraidPackages(app, packageDirectory);
    await run("npm", ["install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], app);

    dev = startProcess(process.execPath, [join(app, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port)], app, { PORT: String(port) });
    const devHtml = await waitForHttp(transformBase, dev);
    assert.match(devHtml, /김하늘/u);
    assert.match(devHtml, /9007199254740993/u);

    const transformedTs = await fetchTransformed(transformBase, "/src/queries.ts", dev);
    assert.match(transformedTs, /재무 거래/u);
    assert.match(transformedTs, /capture/u);
    assertUnicodeSourceMap(await sourceMapFor(transformedTs, transformBase, "queries.ts", dev), "queries.ts");
    const transformedTsx = await fetchTransformed(transformBase, "/src/FinanceTable.tsx", dev);
    assert.match(transformedTsx, /재무 거래/u);
    assert.match(transformedTsx, /capture/u);
    assertUnicodeSourceMap(await sourceMapFor(transformedTsx, transformBase, "FinanceTable.tsx", dev), "FinanceTable.tsx");
    const transformedJs = await fetchTransformed(transformBase, "/src/query-preview.js", dev);
    assert.match(transformedJs, /재무 거래/u);
    assert.match(transformedJs, /capture/u);
    assert.doesNotMatch(transformedJs, /\b(?:index|thunk)\s*:\s*/u);
    assertUnicodeSourceMap(await sourceMapFor(transformedJs, transformBase, "query-preview.js", dev), "query-preview.js");

    const originalTsxPath = join(app, "src", "FinanceTable.tsx");
    const originalTsx = await readFile(originalTsxPath, "utf8");
    const hmrMarker = "SQLBraid finance preview";
    const hmrReplacement = `${hmrMarker} HMR-RETRANSFORMED`;
    assert.ok(originalTsx.includes(hmrMarker));
    const devPid = dev.pid;
    await writeFile(originalTsxPath, originalTsx.replace(hmrMarker, hmrReplacement));
    const retransformed = await fetchTransformed(transformBase, "/src/FinanceTable.tsx", dev, hmrReplacement);
    assert.match(retransformed, /HMR-RETRANSFORMED/u);
    assert.equal(dev.pid, devPid, "HMR check required restarting the Vite process.");
    await writeFile(originalTsxPath, originalTsx);
    await stopProcess(dev);
    dev = undefined;

    await run("npm", ["run", "build"], app);
    await assertClientBundleSafe(app);
    const serverEntry = join(app, ".output", "server", "index.mjs");
    await readFile(serverEntry);
    production = startProcess(process.execPath, [serverEntry], app, { PORT: String(productionPort), HOST: "127.0.0.1" });
    const productionHtml = await waitForHttp(`http://127.0.0.1:${productionPort}/`, production);
    assert.match(productionHtml, /김하늘/u);
    assert.match(productionHtml, /9007199254740993/u);
    assert.match(productionHtml, /정산 완료/u);
    assert.match(productionHtml, /data-js-query-preview/u);
    console.info(JSON.stringify({
      gate: "tanstack-start-finance",
      node: process.versions.node,
      vite: "8.3.0",
      tanstackStart: "1.168.53",
      checks: ["packed-install", "exact-integer-string", "dev-transform", "source-map-unicode", "hmr", "production-ssr", "client-bundle-boundary"],
    }));
  } catch (error) {
    keep = true;
    throw error;
  } finally {
    await stopProcess(dev);
    await stopProcess(production);
    if (keep) console.error(`SQLBRAID_KEEP_FINANCE retained fixture at ${app}`);
    else await rm(temp, { recursive: true, force: true });
  }
}

await main();
