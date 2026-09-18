import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "vitest";
import type { OracleConnectionLike } from "@sqlbraid/oracle/oracledb";
import type { TediousConnectionLike } from "@sqlbraid/mssql/tedious";
import type { BetterSqlite3DatabaseLike } from "@sqlbraid/sqlite/better-sqlite3";
import type { LibsqlClientLike } from "@sqlbraid/sqlite/libsql";

const run = promisify(execFile);
const oracleTypeConsumer: OracleConnectionLike | undefined = undefined;
const mssqlTypeConsumer: TediousConnectionLike | undefined = undefined;
const betterSqlite3TypeConsumer: BetterSqlite3DatabaseLike | undefined = undefined;
const libsqlTypeConsumer: LibsqlClientLike | undefined = undefined;
void [oracleTypeConsumer, mssqlTypeConsumer, betterSqlite3TypeConsumer, libsqlTypeConsumer];

async function linkPackage(directory: string, name: string): Promise<void> {
  const packageDirectory = join(process.cwd(), "packages", name);
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const target = manifest.name.startsWith("@")
    ? join(directory, "node_modules", ...manifest.name.split("/"))
    : join(directory, "node_modules", manifest.name);
  await mkdir(dirname(target), { recursive: true });
  await symlink(packageDirectory, target, "dir");
}

test("public package exports resolve in an external consumer directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-consumer-"));
  await mkdir(join(directory, "node_modules", "@sqlbraid"), { recursive: true });
  const packages = await readdir(join(process.cwd(), "packages"), { withFileTypes: true });
  for (const entry of packages) if (entry.isDirectory()) await linkPackage(directory, entry.name);
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  const entry = join(directory, "index.mjs");
  await writeFile(
    entry,
    [
      'import { sql as pg } from "@sqlbraid/postgres";',
      'import { createPgDatabase } from "@sqlbraid/postgres/pg";',
      'import { createBunSqlDatabase } from "@sqlbraid/bun-sql";',
      'import { sql as mysql } from "@sqlbraid/mysql";',
      'import { createMysql2Database } from "@sqlbraid/mysql/mysql2";',
      'import { sql as sqlite } from "@sqlbraid/sqlite";',
      'import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";',
      'import { createBetterSqlite3Database } from "@sqlbraid/sqlite/better-sqlite3";',
      'import { createLibsqlDatabase } from "@sqlbraid/sqlite/libsql";',
      'import { createBetterSqlite3Database as facadeBetterSqlite3, sql as facadeBetterSqlite3Sql } from "sqlbraid/better-sqlite3";',
      'import { createLibsqlDatabase as facadeLibsql, sql as facadeLibsqlSql } from "sqlbraid/libsql";',
      'import { DatabaseSync } from "node:sqlite";',
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
      'for (const [name, tag] of [["postgres", pg], ["mysql", mysql], ["sqlite", sqlite], ["oracle", oracle], ["mssql", mssql]]) { const rendered = tag`SELECT ${1}`.render(); if (rendered.segments.join("") !== "SELECT " || rendered.parameters[0]?.value !== 1) throw new Error(`${name} export failed`); }',
      'if ([createPgDatabase, createMysql2Database, createNodeSqliteDatabase, createBetterSqlite3Database, createLibsqlDatabase, createBunSqlDatabase, createLanguageService, startStdioLanguageServer].some((value) => typeof value !== "function")) throw new Error("adapter export failed");',
      'if ([facadeBetterSqlite3, facadeLibsql, facadeBetterSqlite3Sql, facadeLibsqlSql].some((value) => typeof value !== "function")) throw new Error("SQLite facade export failed");',
      'if ([createPostgresInspector, createMysqlInspector, createSqliteInspector, createOracleInspector, validateSnapshot].some((value) => typeof value !== "function")) throw new Error("metadata tooling export failed");',
      'const native = new DatabaseSync(":memory:");',
      'try { const db = createNodeSqliteDatabase(native); const row = await db.one(sqlite.rows`SELECT CAST(\'9007199254740993\' AS INTEGER) AS value`); if (row.value !== "9007199254740993") throw new Error("exact INTEGER consumer output failed"); } finally { native.close(); }',
      'const generated = generateModels({ format: "sqlbraid-metadata", formatVersion: 1, dialect: "postgres", dialectVersion: "16", server: {}, namespaces: {}, types: { "pg_catalog.int8": { identity: "pg_catalog.int8", name: "int8", kind: "scalar" } }, relations: { "public.users": { identity: "public.users", name: "users", namespace: "public", kind: "table", columns: [{ name: "id", ordinal: 1, type: "pg_catalog.int8", nullable: false, identity: true }] } }, routines: {}, metadata: {} }, { typePolicy: postgresTypePolicy });',
      'if (generated.models[0]?.rowName !== "UsersRow" || !generated.source.includes("export interface UsersRow")) throw new Error("codegen export failed");',
    ].join("\n"),
  );
  try {
    await run(process.execPath, [entry], { cwd: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packed consumer types require explicit prepared factory modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-prepared-consumer-"));
  await mkdir(join(directory, "node_modules", "@sqlbraid"), { recursive: true });
  // oxlint-disable-next-line no-await-in-loop -- Link the consumer fixture serially so setup failures stop before later package work.
  for (const name of ["core", "template"]) await linkPackage(directory, name);
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["index.ts"],
    }),
  );
  await writeFile(
    join(directory, "index.ts"),
    [
      'import type { Database } from "@sqlbraid/core";',
      'import { sql } from "@sqlbraid/template";',
      "declare const db: Database;",
      'const zero = db.prepare("zero", () => sql.rows<{ readonly id: number }>`SELECT 1`, { input: "none" });',
      "zero.execute({ signal: new AbortController().signal });",
      'const input = db.prepare("input", (id: number) => sql.rows`SELECT ${id}`);',
      "input.execute(1, { signal: new AbortController().signal });",
      'const rest = db.prepare("rest", (...ids: number[]) => sql.rows`SELECT ${ids[0]}`, { input: "required" });',
      "rest.execute(1);",
      'const defaulted = db.prepare("defaulted", (id = 1) => sql.rows`SELECT ${id}`, { input: "required" });',
      "defaulted.execute(1);",
      "// @ts-expect-error Zero-input factories need the explicit options-only mode.",
      'db.prepare("unmarked-zero", () => sql.rows`SELECT 1`);',
      "// @ts-expect-error One-input factories still require their input before execution options.",
      "input.execute({ signal: new AbortController().signal });",
    ].join("\n"),
  );
  try {
    await run(
      process.execPath,
      [
        join(process.cwd(), "node_modules/typescript/bin/tsc"),
        "--project",
        join(directory, "tsconfig.json"),
        "--pretty",
        "false",
      ],
      { cwd: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
