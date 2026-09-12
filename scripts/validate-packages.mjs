#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages");
const packageNames = (await readdir(packageRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const temp = await mkdtemp(join(tmpdir(), "sqlbraid-pack-check-"));
const consumer = join(temp, "consumer");

async function run(command, args, cwd = root) {
  await execFile(command, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}

try {
  const tarballs = [];
  for (const packageName of packageNames) {
    const before = new Set(await readdir(temp));
    await run("pnpm", ["--dir", join(packageRoot, packageName), "pack", "--pack-destination", temp]);
    const added = (await readdir(temp)).filter((entry) => entry.endsWith(".tgz") && !before.has(entry));
    if (added.length !== 1) throw new Error(`Expected one tarball for ${packageName}, found ${added.length}.`);
    const tarball = join(temp, added[0]);
    tarballs.push(tarball);
    const { stdout: manifestText } = await execFile("tar", ["-xOf", tarball, "package/package.json"]);
    const manifest = JSON.parse(manifestText);
    if (manifest.engines?.node !== ">=22.18.0") throw new Error(`Unexpected Node engine for ${manifest.name}: ${manifest.engines?.node ?? "missing"}`);
    for (const validator of ["valibot", "zod", "arktype"]) {
      if (manifest.dependencies?.[validator] || manifest.peerDependencies?.[validator] || manifest.optionalDependencies?.[validator]) {
        throw new Error(`Concrete validator ${validator} is a production dependency of ${manifest.name}.`);
      }
    }
    if (manifest.name === "@sqlbraid/core" && !manifest.dependencies?.["@standard-schema/spec"]) {
      throw new Error("Core public Standard Schema types require a regular spec dependency.");
    }
    await run("pnpm", ["exec", "publint", "run", tarball, "--strict"]);
    await run("pnpm", ["exec", "attw", tarball, "--profile", "esm-only", "--no-emoji"]);
  }

  const dependencies = Object.fromEntries(await Promise.all(tarballs.map(async (tarball) => {
    const { stdout } = await execFile("tar", ["-xOf", tarball, "package/package.json"]);
    return [JSON.parse(stdout).name, `file:${tarball}`];
  })));
  await writeFile(join(temp, "consumer-package.json"), JSON.stringify({ name: "sqlbraid-packed-consumer", private: true, type: "module", dependencies }, null, 2));
  await mkdir(consumer);
  await copyFile(join(temp, "consumer-package.json"), join(consumer, "package.json"));
  await mkdir(join(consumer, "packages/core/src"), { recursive: true });
  await mkdir(join(consumer, "packages/postgres/src"), { recursive: true });
  await writeFile(join(consumer, "packages/core/src/index.ts"), "export const sql = 1;\n");
  await writeFile(join(consumer, "packages/postgres/src/index.ts"), "export const sql = 2;\n");
  await run("npm", ["install", "--ignore-scripts"], consumer);

  const entry = join(consumer, "index.mjs");
  await writeFile(entry, [
    'import { createPooledDatabase } from "@sqlbraid/runtime";',
    'import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";',
    'import { createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";',
    'if ([createPooledDatabase, createPgPoolDatabase, createMysql2PoolDatabase].some((value) => typeof value !== "function")) throw new Error("packed pool exports failed");',
    'import { sql as pg } from "@sqlbraid/postgres";',
    'import { createPgDatabase } from "@sqlbraid/postgres/pg";',
    'import { sql as mysql } from "@sqlbraid/mysql";',
    'import { createMysql2Database } from "@sqlbraid/mysql/mysql2";',
    'import { sql as sqlite } from "@sqlbraid/sqlite";',
    'import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";',
    'import { createLanguageService, startStdioLanguageServer } from "@sqlbraid/language-server";',
    'if (pg`SELECT ${1}`.render().text !== "SELECT $1") throw new Error("packed postgres root failed");',
    'if (mysql`SELECT ${1}`.render().text !== "SELECT ?") throw new Error("packed mysql root failed");',
    'if (sqlite`SELECT ${1}`.render().text !== "SELECT ?") throw new Error("packed sqlite root failed");',
    'if ([createPgDatabase, createMysql2Database, createNodeSqliteDatabase, createLanguageService, startStdioLanguageServer].some((value) => typeof value !== "function")) throw new Error("packed subpath failed");',
  ].join("\n"));
  await run(process.execPath, [entry], consumer);

  // First prove packed runtime imports need no concrete validator, then test optional interop.
  const workspace = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await run("npm", [
    "install",
    "--ignore-scripts",
    `valibot@${workspace.devDependencies.valibot}`,
    `zod@${workspace.devDependencies.zod}`,
    `pg@${workspace.devDependencies.pg}`,
    `@types/pg@${workspace.devDependencies["@types/pg"]}`,
    `mysql2@${workspace.devDependencies.mysql2}`,
  ], consumer);

  const types = join(consumer, "types.ts");
  await writeFile(types, [
    'import type { ConnectionProvider, ConnectionLease, ExecutionObserver, ExecutionEvent } from "@sqlbraid/core";',
    'import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";',
    'import { createPgPoolDatabase, type PgPoolLike } from "@sqlbraid/postgres/pg";',
    'import { createMysql2PoolDatabase, type Mysql2PoolLike } from "@sqlbraid/mysql/mysql2";',
    'import type { Client as PgClient, Pool as PgPool, PoolClient } from "pg";',
    'import type { Connection as MysqlConnection, Pool as MysqlPool, PoolConnection as MysqlPoolConnection } from "mysql2/promise";',
    'declare const lease: ConnectionLease;',
    'const provider: ConnectionProvider = { acquire: async () => lease };',
    'const observer: ExecutionObserver = { onEvent(event: ExecutionEvent) {',
    '  // @ts-expect-error execution events are readonly',
    '  event.type = "invalid";',
    '} };',
    'const pooled = createPooledDatabase(provider, { observers: [observer] });',
    'const direct = createDatabase(lease, { observers: [observer] });',
    'declare const pgPoolLike: PgPoolLike;',
    'declare const mysqlPoolLike: Mysql2PoolLike;',
    'createPgPoolDatabase(pgPoolLike, { observers: [observer] });',
    'createMysql2PoolDatabase(mysqlPoolLike, { observers: [observer] });',
    'declare const pgClient: PgClient;',
    'declare const pgPoolClient: PoolClient;',
    'declare const pgPool: PgPool;',
    'createPgDatabase(pgClient);',
    'createPgDatabase(pgPoolClient);',
    'createPgPoolDatabase(pgPool);',
    '// @ts-expect-error direct PostgreSQL adapter rejects a pool',
    'createPgDatabase(pgPool);',
    'declare const mysqlConnection: MysqlConnection;',
    'declare const mysqlPoolConnection: MysqlPoolConnection;',
    'declare const mysqlPool: MysqlPool;',
    'createMysql2Database(mysqlConnection);',
    'createMysql2Database(mysqlPoolConnection);',
    'createMysql2PoolDatabase(mysqlPool);',
    '// @ts-expect-error direct mysql2 adapter rejects a pool',
    'createMysql2Database(mysqlPool);',
    'pooled.tx(async (tx) => tx.execute(pg.rows<{id: number}>`SELECT 1 AS id`));',
    '// @ts-expect-error pre-release transaction alias was removed',
    'direct.transaction(async () => undefined);',
    'import { sql as pg } from "@sqlbraid/postgres";',
    'import { createPgDatabase } from "@sqlbraid/postgres/pg";',
    'import { sql as mysql } from "@sqlbraid/mysql";',
    'import { createMysql2Database } from "@sqlbraid/mysql/mysql2";',
    'import { sql as sqlite } from "@sqlbraid/sqlite";',
    'import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";',
    'import { createVirtualOverlay } from "@sqlbraid/compiler";',
    'import { createLanguageService } from "@sqlbraid/language-server";',
    'import type { Database, StandardSchemaV1, RowsExecutionResult, CommandExecutionResult, QueryExecutionResult, RowQuery } from "@sqlbraid/core";',
    'import * as v from "valibot";',
    'import * as z from "zod";',
    'import { DatabaseResultKindError, DatabaseResultValidationError } from "@sqlbraid/runtime";',
    'declare const db: Database;',
    'const rowQuery = pg.rows<{id: number}>`SELECT 1 AS id`;',
    'const schema = { "~standard": { version: 1, vendor: "consumer", validate: (_: unknown) => ({ value: { id: 1 } }) } } satisfies StandardSchemaV1<unknown, {id: number}>;',
    'const V = v.object({ id: v.number() });',
    'const Z = z.object({ id: z.number().transform(String) });',
    'const a = pg.rows(V)`SELECT 1 AS id`;',
    'const b = pg.rows(Z)`SELECT 1 AS id`;',
    'const inferredV: RowQuery<{id: number}> = a;',
    'const inferredZ: RowQuery<{id: string}> = b;',
    '// @ts-expect-error schema output is string, not raw numeric input',
    'const wrongOutput: RowQuery<{id: number}> = b;',
    'const mappedRows: Promise<RowsExecutionResult<{id: string}>> = db.execute(b);',
    'const rows: Promise<RowsExecutionResult<{id: number}>> = db.execute(rowQuery);',
    'const command: Promise<CommandExecutionResult> = db.execute(pg.command`UPDATE users SET id = 1`);',
    'const unknown: Promise<QueryExecutionResult<unknown>> = db.execute(pg`SELECT 1`);',
    'const validated: Promise<readonly {id: number}[]> = db.all(rowQuery, { schema });',
    'const batch: Promise<readonly [RowsExecutionResult<{id: number}>, CommandExecutionResult]> = db.batch([rowQuery, pg.command`DELETE FROM users`]);',
    '// @ts-expect-error routine calls require db.call',
    'db.execute(pg.call`CALL routine()`);',
    '// @ts-expect-error routine calls cannot enter ordinary batches',
    'db.batch([pg.call`CALL routine()`]);',
    '// @ts-expect-error schema output cannot widen the declared row contract',
    'db.all(rowQuery, { schema: { "~standard": { version: 1, vendor: "bad", validate: () => ({ value: { id: "bad" } }) } } });',
    'const queries = [pg`SELECT ${1}`, mysql`SELECT ${1}`, sqlite`SELECT ${1}`];',
    'void [queries, rows, command, unknown, validated, batch, DatabaseResultKindError, DatabaseResultValidationError, createPgDatabase, createMysql2Database, createNodeSqliteDatabase, createVirtualOverlay, createLanguageService];',
  ].join("\n"));
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2024", "--module", "NodeNext", "--moduleResolution", "NodeNext", types], consumer);

  const cliFile = join(consumer, "cli-query.ts");
  await writeFile(cliFile, 'import { sql as templateSql } from "@sqlbraid/template"; import { sql as postgresSql } from "@sqlbraid/postgres"; const queries = [templateSql`SELECT 1`, postgresSql`SELECT 1`]; void queries;\n');
  await run(join(consumer, "node_modules/.bin/sqlbraid"), ["check", "--file", cliFile], consumer);

  const server = execFile(join(consumer, "node_modules/.bin/sqlbraid-language-server"), [], { cwd: consumer, timeout: 10_000 });
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  server.child.stdin.end(`Content-Length: ${Buffer.byteLength(initialize)}\r\n\r\n${initialize}`);
  const { stdout: serverOutput } = await server;
  const initialized = JSON.parse(serverOutput.slice(serverOutput.indexOf("\r\n\r\n") + 4));
  if (initialized.id !== 1 || initialized.result?.capabilities?.hoverProvider !== true) throw new Error("Packed language server did not initialize.");

  const forbidden = [root, `${root}/packages`, "dist/packages"];
  const installedRoot = join(consumer, "node_modules/@sqlbraid");
  const installedPackages = await readdir(installedRoot, { withFileTypes: true });
  for (const packageEntry of installedPackages) {
    const packageDir = join(installedRoot, packageEntry.name);
    const files = await readdir(packageDir, { recursive: true, withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const text = await readFile(join(file.parentPath, file.name), "utf8");
      for (const needle of forbidden) if (text.includes(needle)) throw new Error(`Monorepo path leaked into ${packageEntry.name}/${file.name}: ${needle}`);
    }
  }
  console.info(`Validated ${tarballs.length} packed packages with ESM, types, subpaths, CLI, engine metadata, and leakage checks.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
