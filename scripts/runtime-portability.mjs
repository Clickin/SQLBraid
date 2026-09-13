#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { auditRuntime, runtimePackages } from "./audit-runtime.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = process.argv.slice(2);
if (!targets.length || targets.some((target) => !["node", "bun", "deno"].includes(target))) throw new Error("Usage: node scripts/runtime-portability.mjs node|bun|deno [...]");
const workspace = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temp = await mkdtemp(join(tmpdir(), "sqlbraid-portability-"));
const consumer = join(temp, "consumer");
const containers = [];
const databaseUrls = { postgres: process.env.SQLBRAID_POSTGRES_URL, mysql: process.env.SQLBRAID_MYSQL_URL };
function redact(text) {
  for (const url of Object.values(databaseUrls)) if (url) text = text.replaceAll(url, "<REDACTED>");
  return text;
}
async function run(command, args, cwd = root, env = process.env) {
  try {
    const result = await execFile(command, args, { cwd, env, timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
    if (result.stdout.trim()) console.info(redact(result.stdout.trim()));
    if (result.stderr.trim()) console.error(redact(result.stderr.trim()));
    return result;
  } catch (error) {
    throw new Error(redact(`${command} failed (${error.code ?? error.signal}):\n${error.stdout ?? ""}\n${error.stderr ?? ""}`));
  }
}
try {
  await run("pnpm", ["run", "build"]);
  await auditRuntime(join(root, "packages"), "src");
  await mkdir(consumer);
  const dependencies = { pg: workspace.devDependencies.pg, mysql2: workspace.devDependencies.mysql2 };
  for (const name of runtimePackages) {
    await run("pnpm", ["--dir", join(root, "packages", name), "pack", "--pack-destination", temp]);
    const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
    const tarball = (await readdir(temp)).find((file) => file === `sqlbraid-${name}-${manifest.version}.tgz`);
    if (!tarball) throw new Error(`Missing packed ${name}`);
    if (manifest.engines?.node !== ">=22.18.0") throw new Error(`Node floor changed: ${name}`);
    dependencies[manifest.name] = `file:${join(temp, tarball)}`;
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "sqlbraid-runtime-consumer", private: true, type: "module", dependencies }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
  const installedPackages = await readdir(join(consumer, "node_modules/@sqlbraid"));
  if (["metadata", "codegen", "tooling", "cli", "language-server", "vscode"].some((name) => installedPackages.includes(name))) {
    throw new Error("Runtime-only installation pulled in development tooling");
  }
  console.info("PASS runtime-only npm install without metadata, codegen, tooling, CLI, LSP or editor");
  const core = JSON.parse(await readFile(join(consumer, "node_modules/@sqlbraid/core/package.json"), "utf8"));
  if (!core.dependencies?.["@standard-schema/spec"]) throw new Error("Standard Schema is not a regular packed dependency");
  await readFile(join(consumer, "node_modules/@standard-schema/spec/package.json"));
  await auditRuntime(join(consumer, "node_modules/@sqlbraid"), "dist");
  await writeFile(join(consumer, "types.ts"), [
    'import type { ExecutionEvent } from "@sqlbraid/core";',
    'import { sql } from "@sqlbraid/template";',
    'import { createDatabase } from "@sqlbraid/runtime";',
    'import { createPgDatabase } from "@sqlbraid/postgres/pg";',
    'import { createMysql2Database } from "@sqlbraid/mysql/mysql2";',
    'import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";',
    'declare const event: ExecutionEvent;',
    'if (event.type === "query:result") { const ms: number = event.durationMs; void ms; }',
    'void [sql, createDatabase, createPgDatabase, createMysql2Database, createNodeSqliteDatabase];',
  ].join("\n"));
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext" }, files: ["types.ts"] }));
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")], consumer);
  for (const script of ["runtime-smoke.mjs", "runtime-driver-smoke.mjs"]) await copyFile(join(root, "scripts", script), join(consumer, script));
  await writeFile(join(consumer, "deno.json"), JSON.stringify({ nodeModulesDir: "manual" }));
  if (!databaseUrls.postgres) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:16.4-alpine").start();
    containers.push(container);
    databaseUrls.postgres = container.getConnectionUri();
  }
  if (!databaseUrls.mysql) {
    const { MySqlContainer } = await import("@testcontainers/mysql");
    const container = await new MySqlContainer("mysql:8.4.2").start();
    containers.push(container);
    databaseUrls.mysql = container.getConnectionUri();
  }
  await writeFile(join(consumer, "entry.mjs"), `import assert from "node:assert/strict";
import process from "node:process";
import { runRuntimeSmoke } from "./runtime-smoke.mjs";
import { runPostgresSmoke, runMysqlSmoke, runSqliteSmoke } from "./runtime-driver-smoke.mjs";
console.info(JSON.stringify({versions:process.versions}));
await runRuntimeSmoke();
console.info("PASS packed core/template/runtime including ALS");
await runPostgresSmoke(process.env.SQLBRAID_POSTGRES_URL);
console.info("PASS pg direct/pool");
await runMysqlSmoke(process.env.SQLBRAID_MYSQL_URL);
console.info("PASS mysql2 direct/pool");
const sqlite = await runSqliteSmoke();
console.info("SQLite capability/result:", JSON.stringify(sqlite));
if (!process.versions.bun) assert.equal(sqlite.supported, true, "Node and pinned Deno SQLite are required release gates");
`);
  const env = { ...process.env, SQLBRAID_POSTGRES_URL: databaseUrls.postgres, SQLBRAID_MYSQL_URL: databaseUrls.mysql };
  for (const target of targets) {
    console.info(`Runtime matrix: ${target}; pg ${dependencies.pg}; mysql2 ${dependencies.mysql2}; PostgreSQL 16.4 / MySQL 8.4.2 test services`);
    const args = target === "deno" ? ["run", "--no-prompt", "--allow-read=" + consumer, "--allow-env=SQLBRAID_POSTGRES_URL,SQLBRAID_MYSQL_URL,PG*,NODE_*,USER,USERNAME,TZ", "--allow-net=" + Object.values(databaseUrls).map((url) => new URL(url).host).join(","), "entry.mjs"] : ["entry.mjs"];
    await run(target === "node" ? process.execPath : target, args, consumer, env);
  }
} finally {
  await Promise.all(containers.map((container) => container.stop()));
  await rm(temp, { recursive: true, force: true });
}
