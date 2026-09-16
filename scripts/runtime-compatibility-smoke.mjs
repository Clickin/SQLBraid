#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compatibility = JSON.parse(readFileSync(join(root, "support/runtime-compatibility.json"), "utf8"));
const cellId = process.env.SQLBRAID_COMPAT_CELL;
const cell = compatibility.cells.find(({ id }) => id === cellId);
if (!cell) throw new Error(`Unknown SQLBraid runtime compatibility cell: ${cellId ?? "unset"}`);
if (process.versions.node !== cell.runtime.version) {
  throw new Error(`Expected Node ${cell.runtime.version}; found ${process.versions.node}.`);
}

const packageDirectory = resolve(process.env.SQLBRAID_COMPAT_PACKAGE_DIR ?? join(root, ".compatibility-packages"));
const consumer = resolve(process.env.SQLBRAID_COMPAT_CONSUMER ?? mkdtempSync(join(tmpdir(), "sqlbraid-runtime-compat-")));
const tarballs = new Map();
for (const file of readdirSync(packageDirectory)) {
  if (!file.endsWith(".tgz")) continue;
  const path = join(packageDirectory, file);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
  if (tarballs.has(manifest.name)) throw new Error(`Duplicate packed artifact for ${manifest.name}.`);
  tarballs.set(manifest.name, path);
}
const dependencies = {};
for (const packageName of cell.packages) {
  const tarball = tarballs.get(packageName);
  if (!tarball) throw new Error(`${cell.id} is missing packed artifact ${packageName}.`);
  dependencies[packageName] = `file:${tarball}`;
}
if (cell.driver) dependencies[cell.driver.package] = cell.driver.version;
writeFileSync(join(consumer, "package.json"), JSON.stringify({
  name: `sqlbraid-runtime-compat-${cell.id}`,
  private: true,
  type: "module",
  dependencies,
}, null, 2));
execFileSync("npm", ["install", "--engine-strict", "--no-audit", "--no-fund"], {
  cwd: consumer,
  stdio: "inherit",
  env: { ...process.env, npm_config_engine_strict: "true" },
});

const { sql } = await import("@sqlbraid/sqlite");
const rendered = sql`SELECT ${1} AS value`.render();
assert.deepEqual(rendered.segments, ["SELECT ", " AS value"]);
assert.equal(rendered.parameters[0].value, 1);
const facade = await import("sqlbraid");
assert.equal(typeof facade.createDatabase, "function");

if (cell.driver?.package === "better-sqlite3") await smokeBetterSqlite3();
if (cell.driver?.package === "@libsql/client") await smokeLibsql();
console.info(`PASS packed SQLBraid compatibility consumer: ${cell.id}`);

async function smokeBetterSqlite3() {
  const loaded = await import("better-sqlite3");
  const BetterSqlite3 = loaded.default ?? loaded;
  const { createBetterSqlite3Database } = await import("@sqlbraid/sqlite/better-sqlite3");
  const native = new BetterSqlite3(":memory:");
  const db = createBetterSqlite3Database(native);
  try {
    await db.execute(sql.command`CREATE TABLE values_table (id INTEGER PRIMARY KEY, exact INTEGER NOT NULL, real_value REAL NOT NULL)`);
    await db.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"9223372036854775807"}, ${1.5})`);
    assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [{ exact: "9223372036854775807", real_value: 1.5 }]);
    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"7"}, ${2.5})`);
        throw new Error("compatibility rollback");
      }),
      /compatibility rollback/u,
    );
    assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [{ exact: "9223372036854775807", real_value: 1.5 }]);
  } finally {
    native.close();
  }
}

async function smokeLibsql() {
  const loaded = await import("@libsql/client");
  const createClient = loaded.createClient ?? loaded.default?.createClient;
  if (typeof createClient !== "function") throw new Error("@libsql/client does not export createClient.");
  const { createLibsqlDatabase } = await import("@sqlbraid/sqlite/libsql");
  const client = createClient({ url: `file:${join(consumer, "compatibility.db")}`, intMode: "string" });
  const db = createLibsqlDatabase(client, { intMode: "string" });
  await db.execute(sql.command`CREATE TABLE values_table (id INTEGER PRIMARY KEY, exact INTEGER NOT NULL, real_value REAL NOT NULL)`);
  await db.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"9223372036854775807"}, ${1.5})`);
  assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [{ exact: "9223372036854775807", real_value: 1.5 }]);
  await assert.rejects(
    db.tx(async (tx) => {
      await tx.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"7"}, ${2.5})`);
      throw new Error("compatibility rollback");
    }),
    /compatibility rollback/u,
  );
  assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [{ exact: "9223372036854775807", real_value: 1.5 }]);
  client.close?.();
}
