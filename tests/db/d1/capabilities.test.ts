import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build as viteBuild } from "vite";
import { Miniflare } from "miniflare";
import { test } from "vitest";
import { exactJsonText } from "../fidelity.js";

type D1Payload = {
  readonly transparency: readonly { readonly marker: string; readonly enabled: string; readonly actual: string }[];
  readonly transparencySql: string;
  readonly transparencySegments: readonly string[];
  readonly generated: readonly { readonly value: string }[];
  readonly generatedSql: string;
  readonly generatedSegments: readonly string[];
  readonly inserted: { readonly kind: string; readonly rows: readonly { readonly id: string; readonly name: string; readonly payload: readonly number[] }[] };
  readonly mapped: readonly { readonly id: string; readonly name: string; readonly payload: readonly number[]; readonly profile: { readonly active: boolean }; readonly stamp: string; readonly uuid: string }[];
  readonly updated: readonly { readonly id: string; readonly name: string }[];
  readonly deleted: readonly { readonly id: string }[];
  readonly environment: { readonly database: { readonly product: string; readonly version?: string }; readonly driver: { readonly id: string }; readonly runtime: { readonly id: string } };
  readonly numeric: { readonly safe: string; readonly integralReal: { readonly value: string }; readonly unsafeCode: string };
  readonly json: { readonly payload: string; readonly enabled: string };
  readonly bulk: { readonly inputCount: number; readonly affectedRows: number };
  readonly streamCode: string;
  readonly transactionCode: string;
};

let payloadPromise: Promise<D1Payload> | undefined;

async function runFixture(): Promise<D1Payload> {
  const root = resolve(import.meta.dirname, "../../..");
  const workerPath = resolve(root, "fixtures/cloudflare-d1/worker.mjs");
  const outputDirectory = await mkdtemp(join(tmpdir(), "sqlbraid-d1-capabilities-"));
  let worker: Miniflare | undefined;
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
    const response = await worker.dispatchFetch("http://sqlbraid.test/capabilities");
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body) as D1Payload;
  } finally {
    if (worker !== undefined) await worker.dispose();
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

function fixture(): Promise<D1Payload> {
  return payloadPromise ??= runFixture();
}

test("d1.sql.native-transparency", async () => {
  const payload = await fixture();
  assert.equal(payload.environment.database.product, "sqlite");
  assert.equal(payload.environment.database.version, undefined);
  assert.equal(payload.environment.driver.id, "cloudflare-d1");
  assert.deepEqual(payload.transparencySegments, ["\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract('{\"enabled\":true}', '$.enabled') AS enabled,\n             ", " AS actual\n    "]);
  assert.equal(payload.transparencySql, "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract('{\"enabled\":true}', '$.enabled') AS enabled,\n             ?1 AS actual\n    ");
  assert.deepEqual(payload.transparency, [{ marker: "literal $1 :1 @p1 ?", enabled: "1", actual: "7" }]);
});

test("d1.sql.generated-structure", async () => {
  const payload = await fixture();
  assert.deepEqual(payload.generatedSegments, ['SELECT "value" FROM (SELECT ', " AS value)"]);
  assert.equal(payload.generatedSql, 'SELECT "value" FROM (SELECT ?1 AS value)');
  assert.deepEqual(payload.generated, [{ value: "8" }]);
});

test("d1.numeric.exact-integer", async () => {
  const payload = await fixture();
  assert.equal(payload.numeric.safe, "9007199254740991");
  assert.deepEqual(payload.numeric.integralReal, { value: "1" });
  assert.equal(payload.numeric.unsafeCode, "BRAID_INTEGER_UNSAFE");
});

test("d1.data.json-text", async () => {
  const payload = await fixture();
  assert.equal(payload.json.payload, exactJsonText);
  assert.equal(payload.json.enabled, "1");
});

test("d1.execution.bulk", async () => {
  const payload = await fixture();
  assert.deepEqual(payload.bulk, { inputCount: 2, affectedRows: 2 });
  assert.equal(payload.streamCode, "BRAID_STREAM_UNSUPPORTED");
  assert.equal(payload.transactionCode, "BRAID_TX_UNSUPPORTED");
});

test("d1.data.mapping-returning", async () => {
  const payload = await fixture();
  assert.deepEqual(payload.inserted, { kind: "rows", rows: [{ id: "1", name: "Ada", payload: [1, 2, 3] }] });
  assert.deepEqual(payload.mapped, [{
    id: "1", name: "ADA", payload: [1, 2, 3], profile: { active: true },
    stamp: "2026-09-14T00:00:00.123456Z", uuid: "123e4567-e89b-12d3-a456-426614174000",
  }]);
  assert.deepEqual(payload.updated, [{ id: "1", name: "Updated" }]);
  assert.deepEqual(payload.deleted, [{ id: "1" }]);
});
