import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build as viteBuild } from "vite";
import { Miniflare } from "miniflare";

const root = resolve(new URL("../..", import.meta.url).pathname);
const workerPath = resolve(root, "fixtures/cloudflare-d1/worker.mjs");
const outputDirectory = await mkdtemp(join(tmpdir(), "sqlbraid-d1-"));
const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
const artifactPath = process.env.SQLBRAID_CERT_ARTIFACT;
const stressValue = process.env.SQLBRAID_CERT_STRESS;
const certificationRequested = sourceSha !== undefined || artifactPath !== undefined || stressValue !== undefined;
if (certificationRequested && (sourceSha === undefined || artifactPath === undefined || !/^[0-9a-f]{40}$/iu.test(sourceSha))) {
  throw new Error("Certification mode requires a full 40-character SQLBRAID_CERT_SOURCE_SHA and SQLBRAID_CERT_ARTIFACT.");
}
if (stressValue !== undefined && !["0", "1", "false", "true"].includes(stressValue)) {
  throw new Error("SQLBRAID_CERT_STRESS must be 0, 1, false, or true.");
}
const certificationStress = stressValue === "1" || stressValue === "true";
function validateArtifact(path, sha) {
  return new Promise((resolveValidation, rejectValidation) => {
    const child = spawn(process.execPath, ["scripts/certification.mjs", "--validate", "--source-sha", sha, "--artifact", path], { cwd: root, stdio: "inherit" });
    child.once("error", rejectValidation);
    child.once("exit", (code) => code === 0 ? resolveValidation() : rejectValidation(new Error(`Certification artifact validation exited with ${code}.`)));
  });
}
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
  if (certificationRequested) {
    const certificationResponse = await worker.dispatchFetch(`http://sqlbraid.test/certification?sourceSha=${encodeURIComponent(sourceSha)}&stress=${certificationStress ? "1" : "0"}`);
    const certificationBody = await certificationResponse.text();
    assert.equal(certificationResponse.status, 200, certificationBody);
    const certification = JSON.parse(certificationBody);
    assert.equal(certification.artifact.target, "d1-cloudflare-workerd-2026-07-30");
    assert.equal(certification.artifact.sourceSha, sourceSha);
    const miniflarePackage = JSON.parse(await readFile(resolve(root, "node_modules/miniflare/package.json"), "utf8"));
    const artifact = {
      ...certification.artifact,
      provenance: {
        ...certification.artifact.provenance,
        measured: {
          ...certification.artifact.provenance.measured,
          driver: { ...certification.artifact.provenance.measured.driver, version: miniflarePackage.version },
          runtime: { id: "workerd", version: miniflarePackage.version },
        },
      },
    };
    const output = resolve(root, artifactPath);
    await mkdir(dirname(output), { recursive: true });
    const pending = `${output}.pending`;
    await writeFile(pending, `${JSON.stringify(artifact, null, 2)}\n`);
    await validateArtifact(pending, sourceSha);
    await rename(pending, output);
  }
  console.info(JSON.stringify({ check: "local D1 SQLBraid adapter", runtime: "workerd via Miniflare", rows: payload.rows.length }));
} finally {
  if (worker !== undefined) await worker.dispose();
  await rm(outputDirectory, { recursive: true, force: true });
}
