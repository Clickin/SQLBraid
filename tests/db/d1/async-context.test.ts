import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { build as viteBuild, type Rollup } from "vite";
import { test } from "vitest";

type Outcome = { readonly concurrent: string; readonly escape: string; readonly after: string };

// Wrangler resolves package conditions in this order.
const workersConditions = ["workerd", "worker", "browser", "import"];

async function bundleWorker(): Promise<string> {
  const root = resolve(import.meta.dirname, "../../..");
  const result = (await viteBuild({
    configFile: false,
    resolve: { conditions: workersConditions },
    build: {
      lib: {
        entry: resolve(root, "fixtures/cloudflare-d1/async-context-worker.mjs"),
        formats: ["es"],
        fileName: () => "worker.mjs",
      },
      write: false,
    },
    ssr: { noExternal: true },
    logLevel: "silent",
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const output = Array.isArray(result) ? result[0] : result;
  const chunk = output?.output[0];
  assert.ok(chunk !== undefined && chunk.type === "chunk");
  return chunk.code;
}

async function run(compatibilityFlags: string[]): Promise<Outcome> {
  const worker = new Miniflare({
    workers: [
      {
        compatibilityDate: "2026-07-30",
        compatibilityFlags,
        modules: [{ type: "ESModule", path: "worker.mjs", contents: await bundleWorker() }],
      },
    ],
  });
  try {
    const response = await worker.dispatchFetch("http://sqlbraid.test/");
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body) as Outcome;
  } finally {
    await worker.dispose();
  }
}

test("Workers with nodejs_compat separate a transaction from concurrent root work", async () => {
  assert.deepEqual(await run(["nodejs_compat"]), { concurrent: "ok", escape: "BRAID_TX_SCOPE", after: "ok" });
});

test("Workers without nodejs_compat load and keep the conservative scope check", async () => {
  assert.deepEqual(await run([]), { concurrent: "BRAID_TX_SCOPE", escape: "BRAID_TX_SCOPE", after: "ok" });
});
