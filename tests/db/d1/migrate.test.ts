import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build as viteBuild } from "vite";
import { Miniflare } from "miniflare";
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
      assert.ok(["BRAID_MIGRATE_BUSY", "BRAID_MIGRATE_DIRTY"].includes(evidence.contender), evidence.contender);
      assert.equal(evidence.claimStatus, "current");
      assert.equal(evidence.runs, 1);
    } finally {
      if (worker !== undefined) await worker.dispose();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  },
);
