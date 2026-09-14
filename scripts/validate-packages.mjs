#!/usr/bin/env node
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runtimePackages } from "./audit-runtime.mjs";
import ts from "typescript";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages");
const packageNames = (await readdir(packageRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const workspace = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedVersion = workspace.version;
const MAX_TARBALL_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const temp = await mkdtemp(join(tmpdir(), "sqlbraid-pack-check-"));
const consumer = join(temp, "consumer");
const packInputDir = process.env.SQLBRAID_PACK_INPUT_DIR ? resolve(process.env.SQLBRAID_PACK_INPUT_DIR) : undefined;
const requiredPackageNames = new Set([
  "cli", "codegen", "compiler", "core", "language-server", "mariadb", "metadata", "mssql", "mysql",
  "operations", "oracle", "postgres", "runtime", "sqlbraid", "sqlite", "template", "tooling", "vite",
]);
const packedContainers = [];

async function run(command, args, cwd = root) {
  await execFile(command, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function collectPackagePaths(value, paths = []) {
  if (typeof value === "string" && value.startsWith("./")) paths.push(value.slice(2));
  else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectPackagePaths(nested, paths);
  }
  return paths;
}

try {
  for (const name of requiredPackageNames) if (!packageNames.includes(name)) throw new Error(`Missing required package ${name}.`);
  const inputTarballs = new Map();
  if (packInputDir) {
    await rm(join(packInputDir, "pack-check-success.json"), { force: true });
    const release = JSON.parse(await readFile(join(packInputDir, "release-manifest.json"), "utf8"));
    const { stdout: head } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
    assert.equal(release.commit, head.trim(), "Supplied release must belong to the checked-out commit.");
    assert.equal(release.version, expectedVersion);
    assert.equal(release.packages.length, packageNames.length);
    const inputFiles = (await readdir(packInputDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
      .map((entry) => join(packInputDir, entry.name));
    for (const tarball of inputFiles) {
      const { stdout } = await execFile("tar", ["-xOf", tarball, "package/package.json"]);
      const manifest = JSON.parse(stdout);
      if (inputTarballs.has(manifest.name)) throw new Error(`Duplicate supplied tarball for ${manifest.name}.`);
      const recorded = release.packages.find((entry) => entry.name === manifest.name);
      assert.ok(recorded && join(packInputDir, recorded.file) === tarball, `Unrecorded release artifact: ${manifest.name}`);
      assert.equal(await sha256(tarball), recorded.sha256, `Changed release artifact: ${manifest.name}`);
      inputTarballs.set(manifest.name, tarball);
    }
    assert.equal(inputTarballs.size, packageNames.length);
  }
  const tarballs = [];
  for (const packageName of packageNames) {
    const sourceManifest = JSON.parse(await readFile(join(packageRoot, packageName, "package.json"), "utf8"));
    const expectedPackageName = packageName === "sqlbraid" ? "sqlbraid" : `@sqlbraid/${packageName}`;
    if (sourceManifest.version !== expectedVersion) throw new Error(`Package ${sourceManifest.name} is not synchronized to workspace version ${expectedVersion}.`);
    let tarball;
    if (packInputDir) {
      tarball = inputTarballs.get(sourceManifest.name);
      if (!tarball) throw new Error(`Release artifact directory is missing ${sourceManifest.name}.`);
    } else {
      const before = new Set(await readdir(temp));
      await run("pnpm", ["--dir", join(packageRoot, packageName), "pack", "--pack-destination", temp]);
      const added = (await readdir(temp)).filter((entry) => entry.endsWith(".tgz") && !before.has(entry));
      if (added.length !== 1) throw new Error(`Expected one tarball for ${packageName}, found ${added.length}.`);
      tarball = join(temp, added[0]);
    }
    tarballs.push(tarball);
    if ((await stat(tarball)).size > MAX_TARBALL_BYTES) throw new Error(`Tarball for ${packageName} exceeds ${MAX_TARBALL_BYTES} bytes.`);
    const { stdout: manifestText } = await execFile("tar", ["-xOf", tarball, "package/package.json"]);
    const manifest = JSON.parse(manifestText);
    const expectedManifest = structuredClone(sourceManifest);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
      for (const [name, version] of Object.entries(expectedManifest[field] ?? {})) {
        if (!version.startsWith("workspace:")) continue;
        const range = version.slice("workspace:".length);
        expectedManifest[field][name] = range === "*" ? expectedVersion
          : range === "^" || range === "~" ? `${range}${expectedVersion}` : range;
      }
    }
    assert.deepEqual(manifest, expectedManifest, `${manifest.name} packed manifest must match current source.`);
    if (JSON.stringify(manifest).includes("workspace:")) throw new Error(`Workspace dependency protocol leaked into ${manifest.name} metadata.`);

    if (manifest.version !== expectedVersion) throw new Error(`Packed ${manifest.name} is not synchronized to workspace version ${expectedVersion}.`);
    if (manifest.license !== "MIT") throw new Error(`Packed ${manifest.name} is missing the MIT license.`);
    if (!manifest.description || !manifest.repository?.url || !manifest.repository?.directory || !manifest.homepage || !manifest.bugs?.url || !Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
      throw new Error(`Packed ${manifest.name} is missing public package metadata.`);
    }
    if (manifest.name !== expectedPackageName ||
        manifest.repository.type !== "git" ||
        manifest.repository.url !== "git+https://github.com/Clickin/SQLBraid.git" ||
        manifest.repository.directory !== `packages/${packageName}` ||
        manifest.bugs.url !== "https://github.com/Clickin/SQLBraid/issues" ||
        manifest.homepage !== "https://github.com/Clickin/SQLBraid#readme") {
      throw new Error(`Packed ${manifest.name} has incorrect repository metadata.`);
    }
    const unpacked = join(temp, `unpacked-${packageName}`);
    await mkdir(unpacked);
    await run("tar", ["-xzf", tarball, "-C", unpacked]);
    const packageDir = join(unpacked, "package");
    const packageFiles = await readdir(packageDir, { recursive: true, withFileTypes: true });
    const fileNames = new Set();
    for (const file of packageFiles) {
      if (!file.isFile()) continue;
      const name = relative(packageDir, join(file.parentPath, file.name)).replaceAll("\\", "/");
      fileNames.add(name);
      if (name !== "package.json" && name !== "README.md" && name !== "LICENSE" && !name.startsWith("dist/")) {
        throw new Error(`Unexpected file in ${manifest.name} tarball: ${name}`);
      }
      if (/(^|\/)(?:test|tests|fixture|fixtures|__tests__)(?:[-_.\/]|$)/iu.test(name) || /(^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|secret))$/iu.test(name)) {
        throw new Error(`Test, fixture, or secret file in ${manifest.name} tarball: ${name}`);
      }
      if ((await stat(join(packageDir, name))).size > MAX_FILE_BYTES) throw new Error(`File ${manifest.name}/${name} exceeds ${MAX_FILE_BYTES} bytes.`);
      const text = await readFile(join(packageDir, name), "utf8");
      if (name.startsWith("dist/") || name === "README.md") {
        assert.equal(text, await readFile(join(packageRoot, packageName, name), "utf8"), `${manifest.name}/${name} differs from the current build.`);
      }
      if (/\.(?:js|ts)$/u.test(name)) {
        for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
          const specifier = imported.fileName;
          if (specifier.startsWith(".") || specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
          if (specifier.startsWith("#") && Object.hasOwn(manifest.imports ?? {}, specifier)) continue;
          const dependency = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
          if (dependency === manifest.name) continue;
          assert.ok(manifest.dependencies?.[dependency] || manifest.peerDependencies?.[dependency] || manifest.optionalDependencies?.[dependency],
            `${manifest.name}/${name} imports undeclared production dependency ${dependency}.`);
        }
      }
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:npm_|gh[pousr]_)[A-Za-z0-9]{30,}/u.test(text)) {
        throw new Error(`Credential-like content in ${manifest.name}/${name}.`);
      }
      for (const needle of [root, `${root}/packages`, "dist/packages"]) {
        if (text.includes(needle)) throw new Error(`Monorepo path leaked into ${manifest.name}/${name}: ${needle}`);
      }
    }
    for (const required of ["LICENSE", "README.md"]) if (!fileNames.has(required)) throw new Error(`Packed ${manifest.name} is missing package/${required}.`);
    if (await readFile(join(packageDir, "LICENSE"), "utf8") !== await readFile(join(root, "LICENSE"), "utf8")) {
      throw new Error(`Packed ${manifest.name} license differs from the root license.`);
    }
    for (const packagePath of [...collectPackagePaths(manifest.exports), ...collectPackagePaths(manifest.imports), ...collectPackagePaths(manifest.bin)]) {
      if (!fileNames.has(packagePath)) throw new Error(`Packed ${manifest.name} references missing ${packagePath}.`);
    }
    if (manifest.engines?.node !== ">=22.18.0") throw new Error(`Unexpected Node engine for ${manifest.name}: ${manifest.engines?.node ?? "missing"}`);
    for (const validator of ["valibot", "zod", "arktype"]) {
      if (manifest.dependencies?.[validator] || manifest.peerDependencies?.[validator] || manifest.optionalDependencies?.[validator]) {
        throw new Error(`Concrete validator ${validator} is a production dependency of ${manifest.name}.`);
      }
    }
    if (manifest.name === "@sqlbraid/core" && !manifest.dependencies?.["@standard-schema/spec"]) {
      throw new Error("Core public Standard Schema types require a regular spec dependency.");
    }
    if (manifest.name === "@sqlbraid/codegen") {
      const dependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
      if (dependencyNames.length !== 2 || dependencyNames[0] !== "@sqlbraid/core" || dependencyNames[1] !== "@sqlbraid/metadata" || Object.keys(manifest.peerDependencies ?? {}).length || Object.keys(manifest.optionalDependencies ?? {}).length) {
        throw new Error("Codegen must have only core and metadata production dependencies.");
      }
    }
    if (manifest.name === "@sqlbraid/tooling") {
      for (const dependency of ["@sqlbraid/runtime", "@sqlbraid/cli", "@sqlbraid/language-server", "@sqlbraid/postgres", "@sqlbraid/mysql", "@sqlbraid/sqlite", "pg", "mysql2", "vscode"]) {
        if (manifest.dependencies?.[dependency] || manifest.optionalDependencies?.[dependency] || manifest.peerDependencies?.[dependency]) {
          throw new Error(`Shared tooling cannot depend on ${dependency}.`);
        }
      }
    }
    if (manifest.name === "sqlbraid") {
      const dependencyNames = Object.keys(manifest.dependencies ?? {});
      if (dependencyNames.length !== 1 || dependencyNames[0] !== "@sqlbraid/cli"
        || Object.keys(manifest.peerDependencies ?? {}).length
        || Object.keys(manifest.optionalDependencies ?? {}).length) {
        throw new Error("The unscoped sqlbraid package must depend only on @sqlbraid/cli and pull no drivers.");
      }
    }
    for (const tooling of ["@sqlbraid/metadata", "@sqlbraid/codegen", "@sqlbraid/tooling", "@sqlbraid/compiler", "@sqlbraid/vite", "@sqlbraid/cli", "@sqlbraid/language-server", "@sqlbraid/vscode", "vite", "react", "@tanstack/react-start"]) {
      if (runtimePackages.includes(packageName) && (manifest.dependencies?.[tooling] || manifest.optionalDependencies?.[tooling])) {
        throw new Error(`${tooling} is a runtime dependency of ${manifest.name}.`);
      }
    }
    await run("pnpm", ["exec", "publint", "run", tarball, "--strict"]);
    await run("pnpm", ["exec", "attw", tarball, "--profile", "esm-only", "--no-emoji"]);
  }
  if (packInputDir && inputTarballs.size !== packageNames.length) throw new Error(`Release artifact directory contains ${inputTarballs.size} tarballs; expected ${packageNames.length}.`);

  const dependencies = Object.fromEntries(await Promise.all(tarballs.map(async (tarball) => {
    const { stdout } = await execFile("tar", ["-xOf", tarball, "package/package.json"]);
    return [JSON.parse(stdout).name, `file:${tarball}`];
  })));
  const boundaryConsumer = join(temp, "boundary-consumer");
  await mkdir(boundaryConsumer);
  const runtimeDependencies = Object.fromEntries(runtimePackages.map((name) => [`@sqlbraid/${name}`, dependencies[`@sqlbraid/${name}`]]));
  await writeFile(join(boundaryConsumer, "package.json"), JSON.stringify({
    name: "sqlbraid-boundary-consumer", private: true, type: "module",
    dependencies: { ...runtimeDependencies, pg: workspace.devDependencies.pg, mysql2: workspace.devDependencies.mysql2 },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], boundaryConsumer);
  const runtimeInstalledPackages = await readdir(join(boundaryConsumer, "node_modules/@sqlbraid"));
  if (["metadata", "codegen", "tooling", "compiler", "vite", "cli", "language-server", "vscode"].some((name) => runtimeInstalledPackages.includes(name))) throw new Error("Runtime consumer installed development tooling transitively.");
  const runtimeTopLevelPackages = await readdir(join(boundaryConsumer, "node_modules"));
  if (runtimeTopLevelPackages.includes("sqlbraid")) throw new Error("Runtime consumer installed the unscoped CLI package transitively.");
  if (["oracledb", "tedious", "mariadb"].some((name) => runtimeTopLevelPackages.includes(name))) throw new Error("Runtime consumer installed a Node-only database driver.");
  await writeFile(join(boundaryConsumer, "runtime.mjs"), [
    'import assert from "node:assert/strict";',
    'import { sql } from "@sqlbraid/postgres";',
    'import { createPgDatabase } from "@sqlbraid/postgres/pg";',
    'import { sql as oracle } from "@sqlbraid/oracle";',
    'import { sql as mssql } from "@sqlbraid/mssql";',
    'assert.deepEqual(sql`SELECT ${1}`.render().segments, ["SELECT ", ""]);',
    'assert.equal(typeof createPgDatabase, "function");',
    'assert.deepEqual(oracle`SELECT ${1}`.render().segments, ["SELECT ", ""]);',
    'assert.deepEqual(mssql`SELECT ${1}`.render().segments, ["SELECT ", ""]);',
    'for (const dialect of ["postgres", "mysql", "mariadb", "sqlite", "oracle", "mssql"]) {',
    '  const root = await import(`@sqlbraid/${dialect}`);',
    '  assert.ok(!Object.keys(root).some((key) => /Inspector/.test(key)));',
    '}',
  ].join("\n"));
  await run(process.execPath, ["runtime.mjs"], boundaryConsumer);
  console.info("PASS packed runtime-only npm consumer without metadata, codegen, tooling, CLI, LSP or editor");
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", dependencies["@sqlbraid/metadata"], dependencies["@sqlbraid/codegen"]], boundaryConsumer);
  const metadataImports = [
    'import { createPostgresInspector } from "@sqlbraid/postgres/inspector";',
    'import { createMysqlInspector } from "@sqlbraid/mysql/inspector";',
    'import { createMariaDbInspector } from "@sqlbraid/mariadb/inspector";',
    'import { createSqliteInspector } from "@sqlbraid/sqlite/inspector";',
    'import { createOracleInspector } from "@sqlbraid/oracle/inspector";',
  ];
  await writeFile(join(boundaryConsumer, "metadata.mjs"), [
    ...metadataImports,
    'import assert from "node:assert/strict";',
    'import { DatabaseSync } from "node:sqlite";',
    'import { validateSnapshot, parseSnapshotJson, hashSnapshot } from "@sqlbraid/metadata";',
    'const db = new DatabaseSync(":memory:");',
    'try {',
    '  db.exec("CREATE TABLE example (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");',
    '  const metadata = await createSqliteInspector(db).inspect();',
    '  validateSnapshot(metadata);',
    '  assert.equal(hashSnapshot(parseSnapshotJson(JSON.stringify(metadata))), hashSnapshot(metadata));',
    '} finally { db.close(); }',
    'assert.equal(typeof createPostgresInspector, "function");',
    'assert.equal(typeof createMysqlInspector, "function");',
    'assert.equal(typeof createOracleInspector, "function");',
  ].join("\n"));
  await run(process.execPath, ["metadata.mjs"], boundaryConsumer);
  await writeFile(join(boundaryConsumer, "codegen.mjs"), [
    'import assert from "node:assert/strict";',
    'import { writeFile } from "node:fs/promises";',
    'import { generateModels } from "@sqlbraid/codegen";',
    'import { typePolicy } from "@sqlbraid/postgres";',
    'const metadata = {',
    '  format: "sqlbraid-metadata", formatVersion: 1, dialect: "postgres", dialectVersion: "16",',
    '  server: {}, namespaces: {},',
    '  types: {',
    '    "pg_catalog.int8": { identity: "pg_catalog.int8", name: "int8", kind: "scalar" },',
    '    "pg_catalog.text": { identity: "pg_catalog.text", name: "text", kind: "scalar" },',
    '  },',
    '  relations: {',
    '    "public.users": { identity: "public.users", name: "users", namespace: "public", kind: "table", columns: [',
    '      { name: "id", ordinal: 1, type: "pg_catalog.int8", nullable: false, identity: true },',
    '      { name: "name", ordinal: 2, type: "pg_catalog.text", nullable: false },',
    '    ] },',
    '  },',
    '  routines: {}, metadata: {},',
    '};',
    'const generated = generateModels(metadata, { typePolicy });',
    'assert.equal(generated.diagnostics.filter(({ severity }) => severity === "error").length, 0);',
    'assert.deepEqual(generated.models[0], { relationIdentity: "public.users", modelName: "Users", rowName: "UsersRow", insertName: "UsersInsert", updateName: "UsersUpdate" });',
    'assert.match(generated.source, /export interface UsersRow/);',
    'assert.match(generated.source, /export interface UsersInsert/);',
    'assert.match(generated.source, /export interface UsersUpdate/);',
    'await writeFile("generated.ts", generated.source);',
  ].join("\n"));
  await run(process.execPath, ["codegen.mjs"], boundaryConsumer);
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2024", "--module", "NodeNext", "--moduleResolution", "NodeNext", "generated.ts"], boundaryConsumer);
  console.info("PASS packed codegen tooling consumer: PostgreSQL policy generation and TypeScript");
  await writeFile(join(boundaryConsumer, "metadata.ts"), [
    ...metadataImports,
    'import { generateModels, type CodegenResult } from "@sqlbraid/codegen";',
    'import { typePolicy as postgresTypePolicy } from "@sqlbraid/postgres";',
    'import type { MetadataSnapshot, MetadataInspector } from "@sqlbraid/metadata";',
    'import type { PgClientLike } from "@sqlbraid/postgres/pg";',
    'import type { Mysql2ConnectionLike } from "@sqlbraid/mysql/mysql2";',
    'import type { MariaDbConnectionLike } from "@sqlbraid/mariadb/mariadb";',
    'import type { SqliteDatabaseLike } from "@sqlbraid/sqlite/node-sqlite";',
    'declare const pg: PgClientLike, mysql: Mysql2ConnectionLike, maria: MariaDbConnectionLike, sqlite: SqliteDatabaseLike;',
    'const inspectors: MetadataInspector[] = [createPostgresInspector(pg), createMysqlInspector(mysql), createMariaDbInspector(maria), createSqliteInspector(sqlite)];',
    'const results: Promise<MetadataSnapshot>[] = inspectors.map((inspector) => inspector.inspect());',
    'declare const metadata: MetadataSnapshot;',
    'const generated: CodegenResult = generateModels(metadata, { typePolicy: postgresTypePolicy });',
    'const source: string = generated.source;',
    'void source;',
    'void results;',
  ].join("\n"));
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2024", "--module", "NodeNext", "--moduleResolution", "NodeNext", "metadata.ts"], boundaryConsumer);
  console.info("PASS packed metadata tooling consumer: inspector subpaths, SQLite inspection, TypeScript");
  await writeFile(join(temp, "consumer-package.json"), JSON.stringify({ name: "sqlbraid-packed-consumer", private: true, type: "module", dependencies }, null, 2));
  await mkdir(consumer);
  await copyFile(join(temp, "consumer-package.json"), join(consumer, "package.json"));
  await mkdir(join(consumer, "packages/core/src"), { recursive: true });
  await mkdir(join(consumer, "packages/postgres/src"), { recursive: true });
  await writeFile(join(consumer, "packages/core/src/index.ts"), "export const sql = 1;\n");
  await writeFile(join(consumer, "packages/postgres/src/index.ts"), "export const sql = 2;\n");
  await run("npm", ["install", "--ignore-scripts"], consumer);
  const cliConsumer = join(temp, "cli-consumer");
  await mkdir(cliConsumer);
  await writeFile(join(cliConsumer, "package.json"), JSON.stringify({
    name: "sqlbraid-cli-consumer", private: true, type: "module",
    dependencies: { sqlbraid: dependencies.sqlbraid },
    overrides: Object.fromEntries(Object.entries(dependencies).filter(([name]) => name !== "sqlbraid")),
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], cliConsumer);
  const unscopedManifest = JSON.parse(await readFile(join(cliConsumer, "node_modules/sqlbraid/package.json"), "utf8"));
  if (Object.keys(unscopedManifest.dependencies ?? {}).some((name) => /(?:oracledb|tedious|pg|mysql2)/u.test(name))) {
    throw new Error("Unscoped sqlbraid pulls in a database driver.");
  }
  const packedTopLevelPackages = await readdir(join(cliConsumer, "node_modules"));
  if (["oracledb", "tedious", "pg", "mysql2"].some((name) => packedTopLevelPackages.includes(name))) {
    throw new Error("Installing the unscoped sqlbraid package pulled in a database driver.");
  }

  const entry = join(consumer, "index.mjs");
  await writeFile(entry, [
    'import { defineConfig } from "@sqlbraid/cli/config";',
    'import { createPooledDatabase } from "@sqlbraid/runtime";',
    'import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";',
    'import { createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";',
    'if ([createPooledDatabase, createPgPoolDatabase, createMysql2PoolDatabase].some((value) => typeof value !== "function")) throw new Error("packed pool exports failed");',
    'import { sql as pg } from "@sqlbraid/postgres";',
    'import { createPgDatabase } from "@sqlbraid/postgres/pg";',
    'import { sql as mysql } from "@sqlbraid/mysql";',
    'import { createMysql2Database } from "@sqlbraid/mysql/mysql2";',
    'import { sql as mariadb } from "@sqlbraid/mariadb";',
    'import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";',
    'import { sql as sqlite } from "@sqlbraid/sqlite";',
    'import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";',
    'import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";',
    'import { createD1Database } from "@sqlbraid/sqlite/d1";',
    'import { sql as oracle } from "@sqlbraid/oracle";',
    'import { sql as mssql } from "@sqlbraid/mssql";',
    'import { createLanguageService, startStdioLanguageServer } from "@sqlbraid/language-server";',
    'for (const [name, tag] of [["postgres", pg], ["mysql", mysql], ["mariadb", mariadb], ["sqlite", sqlite], ["oracle", oracle], ["mssql", mssql]]) { const rendered = tag`SELECT ${1}`.render(); if (rendered.segments.join("") !== "SELECT " || rendered.parameters[0]?.value !== 1) throw new Error(`${name} root failed`); }',
    'if ([createPgDatabase, createMysql2Database, createMariaDbDatabase, createNodeSqliteDatabase, createSqliteWasmDatabase, createD1Database, createLanguageService, startStdioLanguageServer].some((value) => typeof value !== "function")) throw new Error("packed subpath failed");',
    'if (defineConfig({})?.codegen !== undefined) throw new Error("packed config helper failed");',
  ].join("\n"));
  await run(process.execPath, [entry], consumer);

  await writeFile(join(cliConsumer, "sqlbraid.config.mjs"), [
    'import { defineConfig } from "@sqlbraid/cli/config";',
    'const typePolicy = { id: "packed", hash: "packed-v1", mappings: [{ databaseType: "int4", inputType: "number", outputType: "number", nullable: false }] };',
    'export default defineConfig({ codegen: { targets: [{ name: "packed", metadata: "./packed-metadata.json", outFile: "./packed-generated.ts", typePolicy }] } });',
  ].join("\n"));
  await writeFile(join(cliConsumer, "packed-metadata.json"), JSON.stringify({
    format: "sqlbraid-metadata", formatVersion: 1, dialect: "postgres", dialectVersion: "16",
    server: {}, namespaces: {}, types: {},
    relations: {
      "public.users": {
        identity: "public.users", name: "users", namespace: "public", kind: "table",
        columns: [{ name: "id", ordinal: 0, type: "int4", nullable: false }],
      },
    },
    routines: {}, metadata: {},
  }));
  const cliProbe = await execFile(process.execPath, [join(cliConsumer, "node_modules/sqlbraid/dist/index.js"), "codegen", "--json"], { cwd: cliConsumer, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(JSON.parse(cliProbe.stdout)[0].status, "written");
  const cliCheck = await execFile("npx", ["--no-install", "sqlbraid", "codegen", "--check", "--json"], { cwd: cliConsumer, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(JSON.parse(cliCheck.stdout)[0].status, "unchanged");
  console.info("PASS isolated unscoped CLI install and npx codegen --check without drivers");

  // First prove packed runtime imports need no concrete validator, then test optional interop.
  await run("npm", [
    "install",
    "--ignore-scripts",
    `valibot@${workspace.devDependencies.valibot}`,
    `zod@${workspace.devDependencies.zod}`,
    `pg@${workspace.devDependencies.pg}`,
    `@types/pg@${workspace.devDependencies["@types/pg"]}`,
    `mysql2@${workspace.devDependencies.mysql2}`,
    `oracledb@${JSON.parse(await readFile(join(packageRoot, "oracle", "package.json"), "utf8")).devDependencies.oracledb}`,
    `tedious@${JSON.parse(await readFile(join(packageRoot, "mssql", "package.json"), "utf8")).devDependencies.tedious}`,
  ], consumer);
  const packedDatabaseEnv = { ...process.env };
  packedDatabaseEnv.SQLBRAID_ORACLE_URL ??= packedDatabaseEnv.SQLBRAID_ORACLE_CONNECTION_STRING ?? packedDatabaseEnv.ORACLE_URL;
  if (!packedDatabaseEnv.SQLBRAID_MSSQL_URL && packedDatabaseEnv.SQLBRAID_MSSQL_SERVER) {
    const user = packedDatabaseEnv.SQLBRAID_MSSQL_USER ?? "sa";
    const password = packedDatabaseEnv.SQLBRAID_MSSQL_PASSWORD ?? "Sqlbraid_Test13!";
    const database = packedDatabaseEnv.SQLBRAID_MSSQL_DATABASE ?? "master";
    packedDatabaseEnv.SQLBRAID_MSSQL_URL = `mssql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${packedDatabaseEnv.SQLBRAID_MSSQL_SERVER}:${packedDatabaseEnv.SQLBRAID_MSSQL_PORT ?? "1433"}/${database}`;
  }
  if (!packedDatabaseEnv.SQLBRAID_ORACLE_URL || !packedDatabaseEnv.SQLBRAID_MSSQL_URL) {
    const { GenericContainer, Wait } = await import("testcontainers");
    if (!packedDatabaseEnv.SQLBRAID_ORACLE_URL) {
      const container = await new GenericContainer("gvenzl/oracle-free:23.9-slim-faststart")
        .withEnvironment({ ORACLE_PASSWORD: "SqlbraidTest13", APP_USER: "sqlbraid", APP_USER_PASSWORD: "SqlbraidTest13" })
        .withExposedPorts(1521)
        .withWaitStrategy(Wait.forLogMessage(/DATABASE IS READY TO USE/iu))
        .withStartupTimeout(600_000)
        .start();
      packedContainers.push(container);
      packedDatabaseEnv.SQLBRAID_ORACLE_URL = `${container.getHost()}:${container.getMappedPort(1521)}/FREEPDB1`;
      packedDatabaseEnv.SQLBRAID_ORACLE_USER = "sqlbraid";
      packedDatabaseEnv.SQLBRAID_ORACLE_PASSWORD = "SqlbraidTest13";
    }
    if (!packedDatabaseEnv.SQLBRAID_MSSQL_URL) {
      const container = await new GenericContainer("mcr.microsoft.com/mssql/server:2022-CU18-ubuntu-22.04")
        .withEnvironment({ ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: "Sqlbraid_Test13!", MSSQL_PID: "Developer" })
        .withExposedPorts(1433)
        .withWaitStrategy(Wait.forLogMessage("SQL Server is now ready for client connections."))
        .withStartupTimeout(600_000)
        .start();
      packedContainers.push(container);
      packedDatabaseEnv.SQLBRAID_MSSQL_URL = `sqlserver://sa:${encodeURIComponent("Sqlbraid_Test13!")}`
        + `@${container.getHost()}:${container.getMappedPort(1433)}`;
      packedDatabaseEnv.SQLBRAID_MSSQL_USER = "sa";
      packedDatabaseEnv.SQLBRAID_MSSQL_PASSWORD = "Sqlbraid_Test13!";
    }
  }
  await copyFile(join(root, "scripts/runtime-packed-five-db.mjs"), join(consumer, "runtime-packed-five-db.mjs"));
  await execFile(process.execPath, ["runtime-packed-five-db.mjs"], {
    cwd: consumer,
    env: packedDatabaseEnv,
    maxBuffer: 20 * 1024 * 1024,
  });
  console.info("PASS packed Oracle/MSSQL adapter, pool and inspector smoke");

  const types = join(consumer, "types.ts");
  await writeFile(types, [
    'import { createWorkspace, type ToolingWorkspace, type SqlBraidLanguageService } from "@sqlbraid/tooling";',
    'import { defineConfig, type SqlBraidConfig } from "@sqlbraid/cli/config";',
    'const toolingWorkspace: ToolingWorkspace = createWorkspace({ rootPath: process.cwd() });',
    'const semanticService: Promise<SqlBraidLanguageService> = toolingWorkspace.service();',
    'const toolingConfig: SqlBraidConfig = defineConfig({});',
    'void [semanticService, toolingConfig];',
    'import type { ConnectionProvider, ConnectionLease, ExecutionObserver, ExecutionEvent } from "@sqlbraid/core";',
    'import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";',
    'import { createPgPoolDatabase, type PgPoolLike } from "@sqlbraid/postgres/pg";',
    'import { createMysql2PoolDatabase, type Mysql2PoolLike } from "@sqlbraid/mysql/mysql2";',
    'import { createOracledbDatabase, createOracledbPoolDatabase, type OracleConnectionLike, type OraclePoolLike } from "@sqlbraid/oracle/oracledb";',
    'import { createTediousDatabase, createTediousPoolDatabase, type TediousConnectionLike, type TediousPoolLike } from "@sqlbraid/mssql/tedious";',
    'import { createMssqlInspector } from "@sqlbraid/mssql/inspector";',
    'import type { Client as PgClient, Pool as PgPool, PoolClient } from "pg";',
    'import type { Connection as MysqlConnection, Pool as MysqlPool, PoolConnection as MysqlPoolConnection } from "mysql2/promise";',
    'declare const lease: ConnectionLease;',
    'const provider: ConnectionProvider = { statementBinding: lease.statementBinding, acquire: async () => lease };',
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
    'declare const oracleConnection: OracleConnectionLike, oraclePool: OraclePoolLike;',
    'declare const tediousConnection: TediousConnectionLike, tediousPool: TediousPoolLike;',
    'createOracledbDatabase(oracleConnection, { observers: [observer] });',
    'createOracledbPoolDatabase(oraclePool, { observers: [observer] });',
    'createTediousDatabase(tediousConnection, { observers: [observer] });',
    'createTediousPoolDatabase(tediousPool, { observers: [observer] });',
    'void createMssqlInspector(tediousConnection);',
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
    'void [queries, rows, command, unknown, validated, batch, DatabaseResultKindError, DatabaseResultValidationError, createPgDatabase, createMysql2Database, createNodeSqliteDatabase, createOracledbDatabase, createTediousDatabase, createVirtualOverlay, createLanguageService];',
  ].join("\n"));
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2024", "--module", "NodeNext", "--moduleResolution", "NodeNext", types], consumer);

  const cliFile = join(consumer, "cli-query.ts");
  await writeFile(cliFile, 'import { sql as templateSql } from "@sqlbraid/template"; import { sql as postgresSql } from "@sqlbraid/postgres"; const queries = [templateSql`SELECT 1`, postgresSql`SELECT 1`]; void queries;\n');
  await run(join(consumer, "node_modules/.bin/sqlbraid"), ["check", "--file", cliFile], consumer);

  await copyFile(join(root, "scripts/agent-tooling-consumer.mjs"), join(consumer, "agent-tooling-consumer.mjs"));
  const agentConsumer = await execFile(process.execPath, ["agent-tooling-consumer.mjs"], { cwd: consumer, maxBuffer: 1024 * 1024 });
  process.stdout.write(agentConsumer.stdout);

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
  const extensionRoot = join(root, "extensions/vscode");
  const extension = join(temp, "vscode");
  const extensionManifest = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8"));
  const vsixOutput = resolve(process.env.SQLBRAID_VSIX_OUTPUT ?? join(root, "sqlbraid.vsix"));
  const extensionDependencies = Object.fromEntries(Object.entries(extensionManifest.dependencies).map(([name, version]) => [name, version.replace(/^workspace:/u, "")]));
  const bundledNames = new Set();
  async function includeTooling(name) {
    if (bundledNames.has(name)) return;
    bundledNames.add(name);
    const manifest = JSON.parse(await readFile(join(packageRoot, name.slice("@sqlbraid/".length), "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) if (dependency.startsWith("@sqlbraid/")) await includeTooling(dependency);
  }
  for (const name of Object.keys(extensionDependencies)) if (name.startsWith("@sqlbraid/")) await includeTooling(name);
  await mkdir(extension);
  await cp(join(extensionRoot, "dist"), join(extension, "dist"), { recursive: true });
  await copyFile(join(extensionRoot, "README.md"), join(extension, "README.md"));
  await copyFile(join(root, "LICENSE"), join(extension, "LICENSE"));
  await writeFile(join(extension, "package.json"), JSON.stringify({
    ...extensionManifest,
    devDependencies: {},
    dependencies: { ...extensionDependencies, ...Object.fromEntries([...bundledNames].map((name) => [name, dependencies[name]])) },
  }));
  await run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], extension);
  await writeFile(join(extension, "package.json"), JSON.stringify({ ...extensionManifest, devDependencies: {}, dependencies: extensionDependencies }));
  await rm(join(extension, "package-lock.json"), { force: true });
  const packagedVsix = join(temp, "sqlbraid.vsix");
  await run(join(root, "node_modules/.bin/vsce"), ["package", "--no-yarn", "--out", packagedVsix], extension);
  const { stdout: vsixFiles } = await execFile("unzip", ["-Z1", packagedVsix]);
  for (const file of [
    "readme.md",
    extensionManifest.main.replace(/^\.\//u, ""),
    "node_modules/@sqlbraid/language-server/dist/cli.js",
    "node_modules/@sqlbraid/cli/dist/index.js",
  ]) {
    if (!vsixFiles.split("\n").includes(`extension/${file}`)) throw new Error(`VSIX omits ${file}.`);
  }
  const licensePath = vsixFiles.split("\n").find((file) => /^extension\/license(?:\.(?:txt|md))?$/iu.test(file));
  assert.ok(licensePath, "VSIX must include its license document.");
  const { stdout: vsixLicense } = await execFile("unzip", ["-p", packagedVsix, licensePath]);
  assert.equal(vsixLicense, await readFile(join(root, "LICENSE"), "utf8"), "VSIX must ship the same MIT license as npm.");
  await mkdir(dirname(vsixOutput), { recursive: true });
  await copyFile(packagedVsix, vsixOutput);
  const previousVsix = process.env.SQLBRAID_VSIX_PATH;
  process.env.SQLBRAID_VSIX_PATH = vsixOutput;
  try {
    await run("pnpm", ["--dir", extensionRoot, "run", "compile-tests"]);
    await run(process.execPath, [join(root, "scripts/test-vscode.mjs")]);
  } finally {
    if (previousVsix === undefined) delete process.env.SQLBRAID_VSIX_PATH;
    else process.env.SQLBRAID_VSIX_PATH = previousVsix;
  }
  if (packInputDir) {
    const { stdout: commit } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
    await writeFile(join(packInputDir, "pack-check-success.json"), `${JSON.stringify({
      version: expectedVersion,
      commit: commit.trim(),
      packages: await Promise.all(tarballs.map(async (tarball) => {
        const { stdout } = await execFile("tar", ["-xOf", tarball, "package/package.json"]);
        return { name: JSON.parse(stdout).name, sha256: await sha256(tarball) };
      })),
    }, null, 2)}\n`);
  }
  console.info(`PASS packaged VSIX includes README/LICENSE and passed the clean-profile host gate: ${vsixOutput}`);
  console.info("PASS VSIX bundles the matching CLI and standard language server.");
  console.info(`Validated ${tarballs.length} packed packages with ESM, types, subpaths, CLI, engine metadata, tooling/editor consumers and leakage checks.`);
} finally {
  await Promise.all(packedContainers.map((container) => container.stop()));
  await rm(temp, { recursive: true, force: true });
}
