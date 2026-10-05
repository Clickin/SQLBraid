import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build as viteBuild } from "vite";
import { Miniflare } from "miniflare";
import { generateManifestModule } from "@sqlbraid/migrate/node";
import { docsClaim } from "../docs-claims.js";

docsClaim(
  "packages/migrate/README.md",
  "D1 applies without transactions, retries failed once checks, caches current checks, and claims concurrent attempts",
  async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sqlbraid-d1-migrate-"));
    let worker: Miniflare | undefined;
    try {
      await viteBuild({
        resolve: { conditions: ["workerd", "browser", "import"] },
        build: {
          lib: {
            entry: resolve(import.meta.dirname, "../../fixtures/cloudflare-d1/migrate.mjs"),
            formats: ["es"],
            fileName: () => "worker.mjs",
          },
          outDir: outputDirectory,
          emptyOutDir: true,
          rollupOptions: { external: ["node:async_hooks"] },
        },
        ssr: { noExternal: true },
        logLevel: "silent",
      });
      worker = new Miniflare({
        workers: [
          {
            compatibilityDate: "2026-07-30",
            compatibilityFlags: ["nodejs_compat"],
            modulesRoot: outputDirectory,
            modules: [{ type: "ESModule", path: join(outputDirectory, "worker.mjs") }],
            d1Databases: ["DB"],
          },
        ],
      });
      const response = await worker.dispatchFetch("http://sqlbraid.test/migrate");
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const evidence = JSON.parse(body);
      assert.equal(evidence.initial, "BRAID_MIGRATE_UNINITIALIZED");
      assert.equal(evidence.applied, "current");
      assert.equal(evidence.verified, "current");
      assert.equal(evidence.verifyQueries, 1);
      assert.equal(evidence.cached, "current");
      assert.equal(evidence.cachedQueries, 0);
      assert.deepEqual(evidence.rows, [{ value: "applied" }, { value: "semi;colon" }]);
      assert.notEqual(evidence.failed, "no-error");
      assert.deepEqual(evidence.failedRows, [{ status: "failed" }]);
      assert.deepEqual(evidence.partial, []);
      assert.equal(evidence.dirty, "BRAID_MIGRATE_DIRTY");
      assert.equal(evidence.contender, "current");
      assert.equal(evidence.claimStatus, "current");
      assert.equal(evidence.runs, 1);
    } finally {
      if (worker !== undefined) await worker.dispose();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  },
);

docsClaim(
  "packages/migrate/README.md",
  "A generated SQL manifest bundles into a Worker and applies on D1",
  async () => {
    const project = await mkdtemp(resolve(import.meta.dirname, "../../.d1-manifest-"));
    const outputDirectory = join(project, "out");
    let worker: Miniflare | undefined;
    try {
      await mkdir(join(project, "migrations"));
      await writeFile(join(project, "migrations/V1__create.sql"), "CREATE TABLE items (value TEXT);\n");
      await writeFile(join(project, "migrations/V2__seed.sql"), "INSERT INTO items (value) VALUES ('seeded');\n");
      await mkdir(join(project, "src"));
      await writeFile(
        join(project, "src/manifest.mjs"),
        await generateManifestModule(join(project, "migrations"), { dialects: ["sqlite"] }),
      );
      await writeFile(
        join(project, "src/worker.mjs"),
        `import { createD1Database } from "@sqlbraid/sqlite/d1";
import { dialect, sql } from "@sqlbraid/sqlite";
import { createMigrator } from "@sqlbraid/migrate";
import manifest from "./manifest.mjs";
export default {
  async fetch(_request, env) {
    const db = createD1Database(env.DB);
    const status = (await createMigrator({ dialect, manifest }).startup(db, { mode: "apply" })).status;
    return Response.json({ status, rows: await db.all(sql.rows\`SELECT value FROM items\`) });
  },
};
`,
      );
      await viteBuild({
        configFile: false,
        root: project,
        resolve: { conditions: ["workerd", "browser", "import"] },
        build: {
          lib: { entry: join(project, "src/worker.mjs"), formats: ["es"], fileName: () => "worker.mjs" },
          outDir: outputDirectory,
          emptyOutDir: true,
          rollupOptions: { external: ["node:async_hooks"], output: { codeSplitting: false } },
        },
        ssr: { noExternal: true },
        logLevel: "silent",
      });
      worker = new Miniflare({
        workers: [
          {
            compatibilityDate: "2026-07-30",
            compatibilityFlags: ["nodejs_compat"],
            modulesRoot: outputDirectory,
            modules: [{ type: "ESModule", path: join(outputDirectory, "worker.mjs") }],
            d1Databases: ["DB"],
          },
        ],
      });
      const response = await worker.dispatchFetch("http://sqlbraid.test/migrate");
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.deepEqual(JSON.parse(body), { status: "current", rows: [{ value: "seeded" }] });
    } finally {
      if (worker !== undefined) await worker.dispose();
      await rm(project, { recursive: true, force: true });
    }
  },
);
