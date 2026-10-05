import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { ConfigurationError, loadConfig, validateConfig } from "@sqlbraid/tooling";

const exec = promisify(execFile);
const cliEntry = resolve("packages/cli/dist/index.js");

async function fixture() {
  const directory = await mkdtemp(resolve("tests/.migrate-cli-"));
  const config = join(directory, "sqlbraid.config.ts");
  await writeFile(
    config,
    `
import { appendFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { defineConfig } from "@sqlbraid/cli/config";
import { dialect } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { createSqliteInspector } from "@sqlbraid/sqlite/inspector";
const databasePath: string = ${JSON.stringify(join(directory, "database.sqlite"))};
export default defineConfig({
  codegen: { targets: [] },
  migrations: {
    directory: "./migrations", dialect,
    options: { scope: "cli-test", table: "cli_migrations", appliedBy: "cli", schemaCheck: "hash" },
    database() {
      const native = new DatabaseSync(databasePath);
      return {
        db: createNodeSqliteDatabase(native), inspector: createSqliteInspector(native),
        async cleanup() { native.close(); await appendFile(${JSON.stringify(join(directory, "cleanup.log"))}, "closed\\n"); }
      };
    }
  }
});
`,
  );
  return {
    directory,
    config,
    run: (...args: string[]) => exec(process.execPath, [cliEntry, "migrate", ...args], { cwd: directory }),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

test("migration CLI new, JSON status, up, manifest, and snapshot use one typed config", async () => {
  const f = await fixture();
  try {
    const created = await f.run("new", "create_items", "--dialect", "sqlite");
    const migration = join(f.directory, "migrations/V001__create_items.sqlite.sql");
    assert.equal(created.stdout.trim(), migration);
    await assert.rejects(readFile(join(f.directory, "cleanup.log")), { code: "ENOENT" });
    await writeFile(migration, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n");
    const initial = JSON.parse((await f.run("status", "--json")).stdout);
    assert.equal(initial.status, "uninitialized");
    const native = new DatabaseSync(join(f.directory, "database.sqlite"));
    assert.deepEqual(native.prepare("SELECT name FROM sqlite_master WHERE name = 'cli_migrations'").all(), []);
    native.close();
    await f.run("up");
    const current = JSON.parse((await f.run("status", "--json")).stdout);
    assert.equal(current.status, "current");
    assert.equal(current.scope, "cli-test");
    assert.equal(current.history[0].applied_by, "cli");
    assert.equal(current.history[0].version, "001");
    assert.match((await f.run("status")).stdout, /current/iu);
    const generated = (await f.run("manifest")).stdout.trim();
    // Generated output is selected at runtime and intentionally loaded as a consumer would load it.
    const { default: manifest } = await import(pathToFileURL(generated).href);
    assert.equal(manifest.format, "sqlbraid-migrations");
    assert.match(await manifest.dialects.sqlite.versioned[0].load(), /CREATE TABLE items/u);
    const snapshotFile = (await f.run("snapshot")).stdout.trim();
    const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
    assert.equal(snapshot.format, "sqlbraid-metadata");
    assert.ok(Object.keys(snapshot.relations).some((key) => key.endsWith("items")));
    const changed = new DatabaseSync(join(f.directory, "database.sqlite"));
    changed.exec("ALTER TABLE items ADD COLUMN manual TEXT");
    changed.close();
    const drift = JSON.parse((await f.run("status", "--json")).stdout);
    assert.ok(drift.differences.some((item: { kind: string }) => item.kind === "schema-drift"));
    assert.equal((await readFile(join(f.directory, "cleanup.log"), "utf8")).trim().split("\n").length, 6);
  } finally {
    await f.remove();
  }
}, 30_000);

test("migration CLI baseline and repair preserve the database and clean up failed commands", async () => {
  const f = await fixture();
  try {
    await f.run("new", "existing");
    await writeFile(join(f.directory, "migrations/V001__existing.sql"), "CREATE TABLE existing (id INTEGER);\n");
    const native = new DatabaseSync(join(f.directory, "database.sqlite"));
    native.exec("CREATE TABLE existing (id INTEGER)");
    native.close();
    await f.run("baseline", "001");
    const report = JSON.parse((await f.run("status", "--json")).stdout);
    assert.equal(report.status, "current");
    assert.equal(report.history[0].kind, "baseline");
    const dirty = new DatabaseSync(join(f.directory, "database.sqlite"));
    dirty.exec("UPDATE cli_migrations SET status = 'failed'");
    dirty.close();
    assert.equal(JSON.parse((await f.run("status", "--json")).stdout).status, "incomplete");
    await f.run("repair");
    const repaired = new DatabaseSync(join(f.directory, "database.sqlite"));
    assert.deepEqual(repaired.prepare("SELECT * FROM cli_migrations WHERE status IN ('failed', 'running')").all(), []);
    assert.ok(repaired.prepare("SELECT name FROM sqlite_master WHERE name = 'existing'").get());
    repaired.close();
    await assert.rejects(f.run("up"));
    assert.equal((await readFile(join(f.directory, "cleanup.log"), "utf8")).trim().split("\n").length, 5);
  } finally {
    await f.remove();
  }
}, 30_000);

test("migration config remains executable only on the migration CLI path", async () => {
  const f = await fixture();
  try {
    const loaded = await loadConfig(f.config, f.directory);
    assert.deepEqual(loaded.config.codegen, { targets: [] });
    assert.equal(loaded.config.migrations, undefined);
    const result = await exec(process.execPath, [cliEntry, "codegen", "--json"], { cwd: f.directory });
    assert.deepEqual(JSON.parse(result.stdout), []);
    await assert.rejects(readFile(join(f.directory, "cleanup.log")), { code: "ENOENT" });
    await assert.rejects(f.run("new", "../escape"));
    await assert.rejects(f.run("status", "--dialect", "sqlite"));
    await assert.rejects(f.run("baseline"));
    await f.run("new", "first");
    await writeFile(join(f.directory, "migrations/V9007199254740993.2__large.sql"), "");
    const next = await f.run("new", "next");
    assert.match(next.stdout, /V9007199254740994__next\.sql/u);
    assert.equal((await readdir(join(f.directory, "migrations"))).length, 3);
    assert.throws(() => validateConfig({ migrations: { directory: ".", dialect: { id: "sqlite" } } }), /database/u);
  } finally {
    await f.remove();
  }
}, 30_000);

test("migration new picks the next version across nested migration directories", async () => {
  const f = await fixture();
  try {
    await f.run("new", "first");
    await mkdir(join(f.directory, "migrations/2026"), { recursive: true });
    await writeFile(join(f.directory, "migrations/2026/V007__nested.sql"), "");
    const next = await f.run("new", "next");
    assert.match(next.stdout, /V008__next\.sql/u);
  } finally {
    await f.remove();
  }
}, 30_000);

test("migration snapshot rewrites a broken snapshot file; other commands name it", async () => {
  const f = await fixture();
  try {
    await f.run("new", "create_items");
    await writeFile(join(f.directory, "migrations/V001__create_items.sql"), "CREATE TABLE items (id INTEGER);\n");
    const snapshotFile = join(f.directory, "migrations/schema.snapshot.json");
    await writeFile(snapshotFile, "{ not json");
    await assert.rejects(f.run("status"), (error: Error & { stderr?: string }) => {
      assert.match(String(error.stderr), /schema\.snapshot\.json/u);
      assert.match(String(error.stderr), /sqlbraid migrate snapshot/u);
      return true;
    });
    assert.equal((await f.run("snapshot")).stdout.trim(), snapshotFile);
    assert.equal(JSON.parse(await readFile(snapshotFile, "utf8")).format, "sqlbraid-metadata");
    await writeFile(
      snapshotFile,
      JSON.stringify({ format: "sqlbraid-metadata", formatVersion: 1, dialect: "postgres" }),
    );
    await f.run("snapshot");
    assert.equal(JSON.parse(await readFile(snapshotFile, "utf8")).dialect, "sqlite");
    await f.run("up");
    assert.equal(JSON.parse((await f.run("status", "--json")).stdout).status, "current");
  } finally {
    await f.remove();
  }
}, 30_000);

test("migration accept-schema records the inspected hash after explicit review", async () => {
  const f = await fixture();
  try {
    await f.run("new", "create_items");
    await writeFile(join(f.directory, "migrations/V001__create_items.sql"), "CREATE TABLE items (id INTEGER);\n");
    await f.run("up");
    const changed = new DatabaseSync(join(f.directory, "database.sqlite"));
    changed.exec("ALTER TABLE items ADD COLUMN manual TEXT");
    changed.close();
    assert.equal(JSON.parse((await f.run("status", "--json")).stdout).status, "mismatch");
    assert.match((await f.run("accept-schema")).stdout, /current/iu);
    assert.equal(JSON.parse((await f.run("status", "--json")).stdout).status, "current");
    assert.match((await f.run("--help")).stdout, /accept-schema/u);
  } finally {
    await f.remove();
  }
}, 30_000);

test("migration new rejects unknown dialects and follows symbolic links", async () => {
  const f = await fixture();
  const shared = await mkdtemp(resolve("tests/.migrate-cli-shared-"));
  try {
    await assert.rejects(f.run("new", "x", "--dialect", "email"));
    await mkdir(join(f.directory, "migrations"), { recursive: true });
    await writeFile(join(shared, "V041__shared.sql"), "");
    await symlink(shared, join(f.directory, "migrations/shared"), "dir");
    await symlink(join(shared, "V041__shared.sql"), join(f.directory, "migrations/V050__linked.sql"));
    assert.match((await f.run("new", "next")).stdout, /V051__next\.sql/u);
  } finally {
    await f.remove();
    await rm(shared, { recursive: true, force: true });
  }
}, 30_000);

test("packed migration loader imports TypeScript through the runtime and names a missing TypeScript runtime", async () => {
  const directory = await mkdtemp(resolve("tests/.migrate-ts-runtime-"));
  try {
    await mkdir(join(directory, "migrations"));
    await writeFile(join(directory, "migrations/V1__create.sql"), "CREATE TABLE t (id INTEGER);");
    await writeFile(
      join(directory, "migrations/V2__seed.ts"),
      "export default async (db: { values: number[] }): Promise<void> => { db.values.push(1); };",
    );
    const script = `const { loadMigrations } = await import(${JSON.stringify(pathToFileURL(resolve("packages/migrate/dist/node.js")).href)});
const manifest = await loadMigrations(${JSON.stringify(join(directory, "migrations"))}, { dialects: ["sqlite"] });
const [sql, typescript] = manifest.dialects.sqlite.versioned;
const result = { sql: await sql.load() };
try { const values = []; await (await typescript.load())({ values }); result.typescript = values; } catch (error) { result.typescript = error.message; }
console.log(JSON.stringify(result));`;
    await writeFile(join(directory, "probe.mjs"), script);
    const stripped = JSON.parse((await exec(process.execPath, [join(directory, "probe.mjs")])).stdout);
    assert.match(stripped.sql, /CREATE TABLE t/u);
    assert.deepEqual(stripped.typescript, [1]);
    const plain = JSON.parse(
      (await exec(process.execPath, ["--no-experimental-strip-types", join(directory, "probe.mjs")])).stdout,
    );
    assert.match(plain.sql, /CREATE TABLE t/u);
    assert.match(
      plain.typescript,
      /BRAID_MIGRATE_SOURCE: Cannot import TypeScript migration V2__seed\.ts: run with a runtime or loader that handles TypeScript, or use a generated manifest/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("the packed CLI runs codegen without @sqlbraid/migrate and names the missing optional peer", async () => {
  const f = await fixture();
  try {
    const hooks = `export async function resolve(specifier, context, next) {
  if (specifier === "@sqlbraid/migrate" || specifier.startsWith("@sqlbraid/migrate/"))
    throw Object.assign(new Error("Cannot find package '@sqlbraid/migrate'"), { code: "ERR_MODULE_NOT_FOUND" });
  return next(specifier, context);
}`;
    const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;
    const run = (...args: string[]) =>
      exec(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, cliEntry, ...args], {
        cwd: f.directory,
      });
    assert.deepEqual(JSON.parse((await run("codegen", "--json")).stdout), []);
    assert.match((await run("migrate", "--help")).stdout, /accept-schema/u);
    await assert.rejects(run("migrate", "status"), (error: Error & { code?: number; stderr?: string }) => {
      assert.equal(error.code, 2);
      assert.match(String(error.stderr), /Install @sqlbraid\/migrate/u);
      return true;
    });
  } finally {
    await f.remove();
  }
}, 30_000);

test("migration status --check exits 1 unless the report is current", async () => {
  const f = await fixture();
  try {
    await f.run("new", "create_items");
    await writeFile(join(f.directory, "migrations/V001__create_items.sql"), "CREATE TABLE items (id INTEGER);\n");
    assert.equal(JSON.parse((await f.run("status", "--json")).stdout).status, "uninitialized");
    await assert.rejects(f.run("status", "--check", "--json"), (error: Error & { code?: number; stdout?: string }) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(String(error.stdout)).status, "uninitialized");
      return true;
    });
    await f.run("up");
    assert.match((await f.run("status", "--check")).stdout, /current/iu);
    await writeFile(join(f.directory, "migrations/V002__more.sql"), "CREATE TABLE more (id INTEGER);\n");
    await assert.rejects(f.run("status", "--check"), { code: 1 });
    await f.run("up");
    await rm(join(f.directory, "migrations/V002__more.sql"));
    const ahead = await f.run("status", "--check", "--json");
    assert.equal(JSON.parse(ahead.stdout).status, "ahead");
    await assert.rejects(f.run("up", "--check"));
  } finally {
    await f.remove();
  }
}, 30_000);

function busyTimeoutConfig(busyTimeoutMs: number) {
  return {
    migrations: { directory: ".", dialect: { id: "sqlite" }, database: () => ({}), options: { busyTimeoutMs } },
  };
}

test("migration config validation rejects busyTimeoutMs values that the migrator rejects", () => {
  validateConfig(busyTimeoutConfig(0));
  validateConfig(busyTimeoutConfig(2_147_483_647));
  for (const value of [1500.5, 2_147_483_648])
    assert.throws(
      () => validateConfig(busyTimeoutConfig(value)),
      (error: unknown) => error instanceof ConfigurationError && /busyTimeoutMs/u.test(error.message),
    );
});
