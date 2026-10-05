import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { createLibsqlDatabase } from "@sqlbraid/sqlite/libsql";
import { dialect, sql } from "@sqlbraid/sqlite";
import { createMigrator } from "@sqlbraid/migrate";
import { generateManifestModule, loadMigrations } from "@sqlbraid/migrate/node";
import { createSchemaDrift } from "@sqlbraid/migrate/drift";

const directory = await mkdtemp(join(process.cwd(), "migration-smoke-"));
const client = createClient({ url: `file:${join(directory, "database.sqlite")}`, intMode: "string" });
try {
  const sources = join(directory, "migrations");
  await mkdir(sources);
  await writeFile(join(sources, "V001__create.sql"), "CREATE TABLE users (name TEXT NOT NULL);\n");
  await writeFile(join(sources, "V002__seed.sql"), "INSERT INTO users (name) VALUES ('Alice');\n");
  const db = createLibsqlDatabase(client, { intMode: "string" });
  const loaded = await loadMigrations(sources, { dialects: ["sqlite"] });
  const outfile = join(directory, "manifest.mjs");
  await writeFile(outfile, await generateManifestModule(sources, { dialects: ["sqlite"] }));
  const { default: manifest } = await import(pathToFileURL(outfile).href);
  assert.equal(manifest.dialects.sqlite.hash, loaded.dialects.sqlite.hash);
  const drift = createSchemaDrift({
    inspector: {
      dialect: "sqlite",
      async inspect() {
        const [table] = await db.all(sql.rows`SELECT sql AS definition FROM sqlite_master WHERE name = ${"users"}`);
        return {
          format: "sqlbraid-metadata",
          formatVersion: 1,
          dialect: "sqlite",
          dialectVersion: "3",
          server: {},
          namespaces: {},
          types: {},
          routines: {},
          metadata: { completeness: "partial" },
          relations: table
            ? { users: { identity: "users", name: "users", kind: "table", columns: [], definition: table.definition } }
            : {},
        };
      },
    },
  });
  const migrator = createMigrator({ manifest, dialect, drift });
  assert.equal((await migrator.startup(db, { mode: "report" })).status, "uninitialized");
  assert.equal((await migrator.startup(db, { mode: "apply" })).status, "current");
  assert.equal((await migrator.startup(db, { mode: "verify" })).status, "current");
  await migrator.startup(db, { mode: "apply" });
  assert.deepEqual(await db.all(sql.rows`SELECT name FROM users`), [{ name: "Alice" }]);
  assert.equal((await migrator.startup(db, { mode: "report" })).history.length, 2);
  assert.equal((await migrator.startup(db, { schema: "hash" })).status, "current");
  await db.execute(sql.command`ALTER TABLE users ADD COLUMN email TEXT`);
  await assert.rejects(migrator.startup(db, { schema: "hash" }), { code: "BRAID_MIGRATE_SCHEMA_DRIFT" });
  console.info(
    "PASS packed migrations: SQL files + generated manifest apply, startup verify, exactly-once history, schema drift",
  );
} finally {
  client.close();
  await rm(directory, { recursive: true, force: true });
}
