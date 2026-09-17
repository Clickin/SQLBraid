#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { auditRuntime, runtimeAuditPackages, runtimePackages } from "./audit-runtime.mjs";
import { validateRuntimeCompatibility } from "../../scripts/validate-runtime-compatibility.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const targets = process.argv.slice(2);
if (!targets.length || targets.some((target) => !["node", "bun", "deno"].includes(target)))
  throw new Error("Usage: node tests/scripts/runtime-portability.mjs node|bun|deno [...]");
const revision = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== revision)
  throw new Error("Runtime evidence must describe the checked-out CI SHA.");
const workspace = JSON.parse(await readFile(join(root, "tests", "package.json"), "utf8"));
const runtimeCompatibility = await validateRuntimeCompatibility({ root });
const postgresTarget = JSON.parse(await readFile(join(root, "support/targets/postgres.json"), "utf8"));
const mysqlTarget = JSON.parse(await readFile(join(root, "support/targets/mysql.json"), "utf8"));
const sqliteTarget = JSON.parse(await readFile(join(root, "support/targets/sqlite.json"), "utf8"));
const temp = await realpath(await mkdtemp(join(tmpdir(), "sqlbraid-portability-")));
const consumer = join(temp, "consumer");
const containers = [];
const databaseUrls = { postgres: process.env.SQLBRAID_POSTGRES_URL, mysql: process.env.SQLBRAID_MYSQL_URL };
const existingMariaDbUrl =
  process.env.SQLBRAID_BUN_SQL_MARIADB_URL ?? process.env.SQLBRAID_MARIADB_URL ?? process.env.MARIADB_URL;
if (existingMariaDbUrl) databaseUrls.mariadb = existingMariaDbUrl;
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
    throw new Error(
      redact(`${command} failed (${error.code ?? error.signal}):\n${error.stdout ?? ""}\n${error.stderr ?? ""}`),
    );
  }
}
try {
  if (process.env.SQLBRAID_USE_PREBUILT_DIST !== "true") await run("pnpm", ["run", "build:packages"]);
  await auditRuntime(join(root, "packages"), "src", { packages: runtimeAuditPackages });
  await mkdir(consumer);
  const dependencies = {
    pg: workspace.devDependencies.pg,
    "pg-cursor": workspace.devDependencies["pg-cursor"],
    mysql2: workspace.devDependencies.mysql2,
  };
  for (const name of runtimePackages) {
    await run("pnpm", ["--dir", join(root, "packages", name), "pack", "--pack-destination", temp]);
    const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
    const tarball = (await readdir(temp)).find((file) => file === `sqlbraid-${name}-${manifest.version}.tgz`);
    if (!tarball) throw new Error(`Missing packed ${name}`);
    if (name === "bun-sql") {
      if (manifest.engines?.bun !== ">=1.3.14") throw new Error(`Bun floor changed: ${name}`);
    } else if (manifest.engines?.node !== runtimeCompatibility.manifest.packageEngines[manifest.name]) {
      throw new Error(`Node floor changed: ${name}`);
    }
    dependencies[manifest.name] = `file:${join(temp, tarball)}`;
  }
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "sqlbraid-runtime-consumer", private: true, type: "module", dependencies }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
  const installedPackages = await readdir(join(consumer, "node_modules/@sqlbraid"));
  if (
    ["metadata", "codegen", "tooling", "compiler", "vite", "cli", "language-server", "vscode", "opentelemetry"].some(
      (name) => installedPackages.includes(name),
    )
  ) {
    throw new Error("Runtime-only installation pulled in development tooling or optional integrations");
  }
  const topLevelPackages = await readdir(join(consumer, "node_modules"));
  if (topLevelPackages.includes("sqlbraid")) {
    throw new Error("Runtime-only installation pulled in the canonical facade package");
  }
  if (["oracledb", "tedious", "mariadb"].some((name) => topLevelPackages.includes(name))) {
    throw new Error("Portable runtime installation pulled in a Node-only database driver");
  }
  console.info("PASS runtime-only npm install without metadata, codegen, tooling, CLI, LSP or editor");
  const core = JSON.parse(await readFile(join(consumer, "node_modules/@sqlbraid/core/package.json"), "utf8"));
  if (!core.dependencies?.["@standard-schema/spec"])
    throw new Error("Standard Schema is not a regular packed dependency");
  await readFile(join(consumer, "node_modules/@standard-schema/spec/package.json"));
  await auditRuntime(join(consumer, "node_modules/@sqlbraid"), "dist", { packages: runtimePackages });
  await writeFile(
    join(consumer, "types.ts"),
    [
      'import type { ExecutionEvent } from "@sqlbraid/core";',
      'import { sql } from "@sqlbraid/template";',
      'import { createDatabase } from "@sqlbraid/runtime";',
      'import { createPgDatabase } from "@sqlbraid/postgres/pg";',
      'import { createMysql2Database } from "@sqlbraid/mysql/mysql2";',
      'import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";',
      'import { createBunSqlDatabase } from "@sqlbraid/bun-sql";',
      'import { sql as oracle, oracleParameter } from "@sqlbraid/oracle";',
      'import { sql as mssql, mssqlParameter } from "@sqlbraid/mssql";',
      "declare const event: ExecutionEvent;",
      'if (event.type === "query:result") { const ms: number = event.durationMs; void ms; }',
      "const oracleHint = oracleParameter.number();",
      "const mssqlHint = mssqlParameter.nvarchar(40);",
      "void [sql, createDatabase, createPgDatabase, createMysql2Database, createNodeSqliteDatabase, createBunSqlDatabase, oracle, mssql, oracleHint, mssqlHint];",
    ].join("\n"),
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      files: ["types.ts"],
    }),
  );
  await run(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")],
    consumer,
  );
  for (const script of ["runtime-smoke.mjs", "runtime-driver-smoke.mjs"])
    await copyFile(join(root, "tests", "scripts", script), join(consumer, script));
  await copyFile(join(root, "tests", "db", "deno", "packed-runtime.test.mjs"), join(consumer, "deno-runtime.test.mjs"));
  await copyFile(join(root, "tests", "scripts", "bun-sql-matrix.mjs"), join(consumer, "bun-sql-matrix.mjs"));
  await mkdir(join(consumer, "support", "targets"), { recursive: true });
  for (const dialect of ["postgres", "mysql", "mariadb", "sqlite"]) {
    await copyFile(
      join(root, "support", "targets", `${dialect}.json`),
      join(consumer, "support", "targets", `${dialect}.json`),
    );
  }
  await writeFile(join(consumer, "deno.json"), JSON.stringify({ nodeModulesDir: "manual" }));
  if (!databaseUrls.postgres) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const target = JSON.parse(await readFile(join(root, "support/targets/postgres.json"), "utf8"));
    const container = await new PostgreSqlContainer(target.reproducibility.image).start();
    containers.push(container);
    databaseUrls.postgres = container.getConnectionUri();
  }
  if (!databaseUrls.mysql) {
    const { MySqlContainer } = await import("@testcontainers/mysql");
    const target = JSON.parse(await readFile(join(root, "support/targets/mysql.json"), "utf8"));
    const container = await new MySqlContainer(target.reproducibility.image).start();
    containers.push(container);
    databaseUrls.mysql = container.getConnectionUri();
  }
  if (targets.includes("bun") && !databaseUrls.mariadb) {
    const { GenericContainer, Wait } = await import("testcontainers");
    const target = JSON.parse(await readFile(join(root, "support/targets/mariadb.json"), "utf8"));
    const container = await new GenericContainer(target.reproducibility.image)
      .withEnvironment({
        MARIADB_DATABASE: "sqlbraid",
        MARIADB_USER: "sqlbraid",
        MARIADB_PASSWORD: "sqlbraid",
        MARIADB_ROOT_PASSWORD: "root-sqlbraid",
      })
      .withExposedPorts(3306)
      .withWaitStrategy(Wait.forSuccessfulCommand("healthcheck.sh --connect --innodb_initialized"))
      .start();
    containers.push(container);
    databaseUrls.mariadb = `mysql://sqlbraid:sqlbraid@127.0.0.1:${container.getMappedPort(3306)}/sqlbraid`;
  }
  await writeFile(
    join(consumer, "entry.mjs"),
    `import assert from "node:assert/strict";
import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runRuntimeSmoke } from "./runtime-smoke.mjs";
import { runPostgresSmoke, runMysqlSmoke, runSqliteSmoke } from "./runtime-driver-smoke.mjs";
import { sql as oracle } from "@sqlbraid/oracle";
import { sql as mssql } from "@sqlbraid/mssql";
const observations = join(process.cwd(), "runtime-observations");
await mkdir(observations, { recursive: true });
const installedDriverVersions = {
  pg: JSON.parse(await readFile(join(process.cwd(), "node_modules", "pg", "package.json"), "utf8")).version,
  mysql2: JSON.parse(await readFile(join(process.cwd(), "node_modules", "mysql2", "package.json"), "utf8")).version,
};
assert.equal(installedDriverVersions.pg, process.env.SQLBRAID_PG_VERSION);
assert.equal(installedDriverVersions.mysql2, process.env.SQLBRAID_MYSQL2_VERSION);
function normalizedDatabaseVersion(result) {
  const raw = String(result.database.version);
  if (result.driver.id === "pg") {
    const match = /^PostgreSQL\\s+(\\d+(?:\\.\\d+){1,2})/u.exec(raw);
    assert.ok(match, \`Unable to parse PostgreSQL version probe: \${raw}\`);
    assert.equal(match[1], process.env.SQLBRAID_POSTGRES_VERSION);
    return { version: match[1], versionRaw: raw };
  }
  if (result.driver.id === "mysql2") {
    const match = /^(\\d+(?:\\.\\d+){2})/u.exec(raw);
    assert.ok(match, \`Unable to parse MySQL version probe: \${raw}\`);
    assert.equal(match[1], process.env.SQLBRAID_MYSQL_VERSION);
    return { version: match[1], versionRaw: raw };
  }
  return { version: raw, versionRaw: raw };
}
async function record(name, result) {
  if (!result?.database || !result?.driver || !result?.runtime || !result?.typePolicy) return;
  const driverVersion = result.driver.id === "pg"
    ? installedDriverVersions.pg
    : result.driver.id === "mysql2"
      ? installedDriverVersions.mysql2
      : result.runtime.version;
  const database = {
    ...result.database,
    ...normalizedDatabaseVersion(result),
    ...(result.driver.id === "pg" ? { edition: process.env.SQLBRAID_POSTGRES_EDITION } : {}),
    ...(result.driver.id === "mysql2" ? { edition: process.env.SQLBRAID_MYSQL_EDITION } : {}),
    ...(result.driver.id === "node-sqlite"
      ? { edition: result.runtime.id === "deno" ? "Deno bundled SQLite" : process.env.SQLBRAID_SQLITE_EDITION }
      : {}),
  };
  const driver = { ...result.driver, ...(driverVersion ? { version: driverVersion } : {}) };
  const targetId = process.env.SQLBRAID_SUPPORT_TARGET_ID
    ?? [database.product, driver.id, result.runtime.id, result.runtime.version?.replaceAll(".", "-")].filter(Boolean).join("-");
  await writeFile(join(observations, name + ".json"), JSON.stringify({
    targetId,
    database,
    driver,
    runtime: result.runtime,
    typePolicy: result.typePolicy,
    checks: [
      ...(result.checks ?? []),
      ...(result.driver.id === "node-sqlite"
        ? ["session-pinned", "prepared-input", "transaction-options-unsupported", "cancellation-unsupported", "representation-profile"]
        : ["session-pinned", "prepared-input", "transaction-options", "cancellation-capability", "representation-profile"]),
    ],
  }));
}
console.info(JSON.stringify({versions:process.versions}));
if (process.env.SQLBRAID_RUNTIME_TARGET === "deno") assert.equal(process.versions.deno, "2.9.3");
if (process.env.SQLBRAID_RUNTIME_TARGET === "bun") assert.equal(process.versions.bun, "1.3.14");
if (process.env.SQLBRAID_RUNTIME_TARGET === "node") assert.equal(process.versions.node, "22.18.0");
assert.deepEqual(oracle\`SELECT \${1}\`.render().segments, ["SELECT ", ""]);
assert.deepEqual(mssql\`SELECT \${1}\`.render().segments, ["SELECT ", ""]);
await runRuntimeSmoke();
console.info("PASS packed portable core/template/runtime and five dialect roots including ALS");
const postgres = await runPostgresSmoke(process.env.SQLBRAID_POSTGRES_URL);
assert.equal(postgres.profile, "pg-lossless-text");
await record("postgres-" + (postgres.runtime?.id ?? "unknown"), postgres);
console.info("PASS pg direct/pool session/prepare/transaction-options/cancellation/profile and pg-cursor streaming", JSON.stringify(postgres));
const mysql = await runMysqlSmoke(process.env.SQLBRAID_MYSQL_URL);
assert.equal(mysql.profile, "mysql2-lossless-text");
await record("mysql-" + (mysql.runtime?.id ?? "unknown"), mysql);
console.info("PASS mysql2 direct/pool session/prepare/transaction-options/cancellation/profile and prepared Execute streaming", JSON.stringify(mysql));
const sqlite = await runSqliteSmoke();
console.info("SQLite capability/result:", JSON.stringify(sqlite));
if (!process.versions.bun) {
  assert.equal(sqlite.supported, true, "Node and pinned Deno SQLite are required release gates");
  assert.equal(sqlite.profile, "sqlite-exact-string");
  await record("sqlite-" + (sqlite.runtime?.id ?? "unknown"), sqlite);
}
`,
  );
  const env = {
    ...process.env,
    SQLBRAID_POSTGRES_URL: databaseUrls.postgres,
    SQLBRAID_MYSQL_URL: databaseUrls.mysql,
    SQLBRAID_PG_VERSION: workspace.devDependencies.pg,
    SQLBRAID_MYSQL2_VERSION: workspace.devDependencies.mysql2,
    SQLBRAID_POSTGRES_VERSION: postgresTarget.database.version,
    SQLBRAID_POSTGRES_EDITION: postgresTarget.database.edition,
    SQLBRAID_MYSQL_VERSION: mysqlTarget.database.version,
    SQLBRAID_MYSQL_EDITION: mysqlTarget.database.edition,
    SQLBRAID_SQLITE_EDITION: sqliteTarget.database.edition,
    SQLBRAID_BUN_SQL_POSTGRES_URL: databaseUrls.postgres,
    SQLBRAID_BUN_SQL_MYSQL_URL: databaseUrls.mysql,
    ...(databaseUrls.mariadb ? { SQLBRAID_BUN_SQL_MARIADB_URL: databaseUrls.mariadb } : {}),
  };
  for (const target of targets) {
    console.info(
      `Runtime matrix: ${target}; pg ${dependencies.pg}; mysql2 ${dependencies.mysql2}; PostgreSQL 16.4 / MySQL 8.4.2 test services`,
    );
    const args =
      target === "deno"
        ? [
            "run",
            "--no-prompt",
            "--allow-read=" + consumer,
            "--allow-write=" + consumer,
            "--allow-env=SQLBRAID_*,PG*,NODE_*,USER,USERNAME,TZ",
            "--allow-net=" +
              Object.values(databaseUrls)
                .map((url) => new URL(url).host)
                .join(","),
            "entry.mjs",
          ]
        : ["entry.mjs"];
    if (target === "bun") {
      await run("bun", ["bun-sql-matrix.mjs"], consumer, {
        ...env,
        SQLBRAID_RUNTIME_TARGET: target,
        SQLBRAID_SUPPORT_EVIDENCE_DIR: join(consumer, "runtime-observations"),
      });
    }
    if (target === "deno") {
      const denoObservationDirectory = join(consumer, "runtime-observations");
      await run(
        "deno",
        [
          "test",
          "--no-prompt",
          "--allow-read=" + consumer,
          "--allow-write=" + consumer,
          "--allow-env=SQLBRAID_*,PG*,NODE_*,USER,USERNAME,TZ",
          "--allow-net=" +
            Object.values(databaseUrls)
              .map((url) => new URL(url).host)
              .join(","),
          "deno-runtime.test.mjs",
        ],
        consumer,
        {
          ...env,
          SQLBRAID_RUNTIME_TARGET: target,
          SQLBRAID_DENO_OBSERVATIONS_DIR: denoObservationDirectory,
        },
      );
      const denoTestIds = ["deno-postgres.data.profile", "deno-mysql.data.profile", "deno-sqlite.data.profile"];
      const denoObservations = await Promise.all(
        denoTestIds.map(async (testId) =>
          JSON.parse(await readFile(join(denoObservationDirectory, `${testId}.json`), "utf8")),
        ),
      );
      await writeFile(
        join(denoObservationDirectory, "deno-runtime-tests.json"),
        `${JSON.stringify(
          {
            format: "sqlbraid-runtime-tests",
            version: 1,
            commit: revision,
            run: process.env.GITHUB_RUN_ID ?? null,
            runtime: denoObservations[0]?.runtime ?? { id: "deno", version: "2.9.3" },
            testIds: denoTestIds,
            observations: denoObservations,
          },
          null,
          2,
        )}\n`,
      );
    }
    await run(target === "node" ? process.execPath : target, args, consumer, {
      ...env,
      SQLBRAID_RUNTIME_TARGET: target,
    });
    const evidenceDir = process.env.SQLBRAID_SUPPORT_EVIDENCE_DIR;
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      for (const file of await readdir(join(consumer, "runtime-observations"))) {
        await copyFile(join(consumer, "runtime-observations", file), join(evidenceDir, `${target}-${file}`));
      }
    }
  }
} finally {
  await Promise.all(containers.map((container) => container.stop()));
  await rm(temp, { recursive: true, force: true });
}
