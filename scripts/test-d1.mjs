import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build as viteBuild } from "vite";
import { Miniflare } from "miniflare";

const root = resolve(new URL("..", import.meta.url).pathname);
const workerPath = resolve(root, "fixtures/cloudflare-d1/worker.mjs");
const outputDirectory = await mkdtemp(join(tmpdir(), "sqlbraid-d1-"));
let worker;
try {
  await viteBuild({
    resolve: { conditions: ["workerd", "browser", "import"] },
    build: {
      lib: { entry: workerPath, formats: ["es"], fileName: () => "worker.mjs" },
      outDir: outputDirectory,
      emptyOutDir: true,
      rollupOptions: { external: ["node:async_hooks"] },
    },
    ssr: { noExternal: true },
    logLevel: "silent",
  });
  worker = new Miniflare({
    workers: [{
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      modulesRoot: outputDirectory,
      modules: [{ type: "ESModule", path: join(outputDirectory, "worker.mjs") }],
      d1Databases: ["DB"],
    }],
  });
  const response = await worker.dispatchFetch("http://sqlbraid.test/conformance");
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const payload = JSON.parse(body);
  assert.equal(payload.inserted.kind, "rows");
  assert.deepEqual(payload.inserted.rows[0].payload, [1, 2, 3]);
  assert.equal(payload.bulk.inputCount, 2);
  assert.equal(payload.bulkConformance.executionMode, "remote-batch");
  assert.equal(payload.bulkConformance.nativeBatchCalls, payload.bulkConformance.bulkOperationCount);
  assert.equal(payload.rows.length, 3);
  assert.deepEqual(payload.sessionRows, [{ name: "Session" }]);
  assert.deepEqual(payload.rows[0].payload, [1, 2, 3]);
  assert.equal(payload.streamCode, "BRAID_STREAM_UNSUPPORTED");
  assert.equal(payload.transactionCode, "BRAID_TX_UNSUPPORTED");
  console.info(JSON.stringify({ check: "local D1 SQLBraid adapter", runtime: "workerd via Miniflare", rows: payload.rows.length }));
} finally {
  if (worker !== undefined) await worker.dispose();
  await rm(outputDirectory, { recursive: true, force: true });
}
