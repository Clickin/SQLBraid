import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'vitest';
import type { OracleConnectionLike } from '@sqlbraid/oracle/oracledb';
import type { TediousConnectionLike } from '@sqlbraid/mssql/tedious';

const run = promisify(execFile);
const oracleTypeConsumer: OracleConnectionLike | undefined = undefined;
const mssqlTypeConsumer: TediousConnectionLike | undefined = undefined;
void [oracleTypeConsumer, mssqlTypeConsumer];

async function linkPackage(directory: string, name: string): Promise<void> {
  const packageDirectory = join(process.cwd(), 'packages', name);
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  const target = manifest.name.startsWith('@')
    ? join(directory, 'node_modules', ...manifest.name.split('/'))
    : join(directory, 'node_modules', manifest.name);
  await mkdir(dirname(target), { recursive: true });
  await symlink(packageDirectory, target, 'dir');
}

test('public package exports resolve in an external consumer directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlbraid-consumer-'));
  await mkdir(join(directory, 'node_modules', '@sqlbraid'), { recursive: true });
  const packages = await readdir(join(process.cwd(), 'packages'), { withFileTypes: true });
  for (const entry of packages) if (entry.isDirectory()) await linkPackage(directory, entry.name);
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
  const entry = join(directory, 'index.mjs');
  await writeFile(entry, [
    'import { sql as pg } from "@sqlbraid/postgres";',
    'import { createPgDatabase } from "@sqlbraid/postgres/pg";',
    'import { sql as mysql } from "@sqlbraid/mysql";',
    'import { createMysql2Database } from "@sqlbraid/mysql/mysql2";',
    'import { sql as sqlite } from "@sqlbraid/sqlite";',
    'import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";',
    'import { sql as oracle } from "@sqlbraid/oracle";',
    'import { sql as mssql } from "@sqlbraid/mssql";',
    'import { createPostgresInspector } from "@sqlbraid/postgres/inspector";',
    'import { createMysqlInspector } from "@sqlbraid/mysql/inspector";',
    'import { createSqliteInspector } from "@sqlbraid/sqlite/inspector";',
    'import { createOracleInspector } from "@sqlbraid/oracle/inspector";',
    'import { validateSnapshot } from "@sqlbraid/metadata";',
    'import { generateModels } from "@sqlbraid/codegen";',
    'import { typePolicy as postgresTypePolicy } from "@sqlbraid/postgres";',
    'import { createLanguageService, startStdioLanguageServer } from "@sqlbraid/language-server";',
    'if (pg`SELECT ${1}`.render().text !== "SELECT $1") throw new Error("postgres export failed");',
    'if (mysql`SELECT ${1}`.render().text !== "SELECT ?") throw new Error("mysql export failed");',
    'if (sqlite`SELECT ${1}`.render().text !== "SELECT ?") throw new Error("sqlite export failed");',
    'if (oracle`SELECT ${1}`.render().text !== "SELECT :1") throw new Error("oracle export failed");',
    'if (mssql`SELECT ${1}`.render().text !== "SELECT @p1") throw new Error("mssql export failed");',
    'if ([createPgDatabase, createMysql2Database, createNodeSqliteDatabase, createLanguageService, startStdioLanguageServer].some((value) => typeof value !== "function")) throw new Error("adapter export failed");',
    'if ([createPostgresInspector, createMysqlInspector, createSqliteInspector, createOracleInspector, validateSnapshot].some((value) => typeof value !== "function")) throw new Error("metadata tooling export failed");',
    'const generated = generateModels({ format: "sqlbraid-metadata", formatVersion: 1, dialect: "postgres", dialectVersion: "16", server: {}, namespaces: {}, types: { "pg_catalog.int8": { identity: "pg_catalog.int8", name: "int8", kind: "scalar" } }, relations: { "public.users": { identity: "public.users", name: "users", namespace: "public", kind: "table", columns: [{ name: "id", ordinal: 1, type: "pg_catalog.int8", nullable: false, identity: true }] } }, routines: {}, metadata: {} }, { typePolicy: postgresTypePolicy });',
    'if (generated.models[0]?.rowName !== "UsersRow" || !generated.source.includes("export interface UsersRow")) throw new Error("codegen export failed");',
  ].join('\n'));
  try {
    const result = await run(process.execPath, [entry], { cwd: directory });
    assert.equal(result.stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
