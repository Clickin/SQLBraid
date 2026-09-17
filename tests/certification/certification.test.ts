import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { aggregateCertificationArtifacts, certifyTarget, validateCertificationArtifact } from "./runner.js";
import { createSyntheticTarget } from "./targets/synthetic.js";
import { REQUIRED_CERTIFICATION_TARGETS } from "./targets/inventory.js";

describe("A4 certification harness", () => {
  test("runs every required public API case against a deterministic synthetic target", async () => {
    const artifact = await certifyTarget(createSyntheticTarget("candidate-a4"));

    validateCertificationArtifact(artifact, { sourceSha: "candidate-a4" });
    assert.equal(Object.keys(artifact.cases).length, 84);
    assert.equal(artifact.cases.CAP002.status, "pass");
    assert.equal(artifact.cases.STR006.status, "pass-unsupported");
    assert.equal(artifact.cases.STR006.code, "BRAID_CANCEL_UNSUPPORTED");
  });

  test("proves exact SHA, target, case, and skip/declaration aggregation gates", async () => {
    const artifact = await certifyTarget(createSyntheticTarget("candidate-a4"));
    const target = createSyntheticTarget("candidate-a4");
    const requiredTargets = [target.id];
    const requiredTargetContracts = { [target.id]: target.expectedCapabilities };
    const requiredTargetOptionContracts = { [target.id]: target.expectedTransactionOptions };
    const aggregate = aggregateCertificationArtifacts([artifact], { sourceSha: "candidate-a4", requiredTargets, requiredTargetContracts, requiredTargetOptionContracts });
    assert.deepEqual(Object.keys(aggregate.targets), requiredTargets);
    assert.throws(() => aggregateCertificationArtifacts([artifact], { sourceSha: "wrong", requiredTargets, requiredTargetContracts, requiredTargetOptionContracts }), /source SHA/u);
    assert.throws(() => aggregateCertificationArtifacts([artifact], { sourceSha: "candidate-a4", requiredTargets: ["missing"], requiredTargetContracts, requiredTargetOptionContracts }), /target set/u);

    const skipped = { ...artifact, cases: { ...artifact.cases, QRY001: { status: "skip", name: "QRY001" } } } as unknown as typeof artifact;
    assert.throws(() => validateCertificationArtifact(skipped, { sourceSha: "candidate-a4" }), /may not be skipped/u);
    const missing = { ...artifact, cases: Object.fromEntries(Object.entries(artifact.cases).filter(([id]) => id !== "QRY001")) } as unknown as typeof artifact;
    assert.throws(() => validateCertificationArtifact(missing, { sourceSha: "candidate-a4" }), /incomplete/u);
    const mismatched = { ...artifact, declaredCapabilities: { ...artifact.declaredCapabilities, "statement.stream": { status: "unsupported" } } } as typeof artifact;
    assert.throws(() => validateCertificationArtifact(mismatched, { sourceSha: "candidate-a4" }), /declaration mismatch/u);
    const forged = {
      ...artifact,
      expectedCapabilities: { ...artifact.expectedCapabilities, "statement.cancel": { status: "guaranteed" } },
      declaredCapabilities: { ...artifact.declaredCapabilities, "statement.cancel": { status: "guaranteed" } },
    } as typeof artifact;
    assert.throws(() => validateCertificationArtifact(forged, { sourceSha: "candidate-a4" }), /supported capability/u);
    const wrongCode = { ...artifact, cases: { ...artifact.cases, STR006: { ...artifact.cases.STR006, code: "BRAID_STREAM_UNSUPPORTED" } } } as typeof artifact;
    assert.throws(() => validateCertificationArtifact(wrongCode, { sourceSha: "candidate-a4" }), /unexpected unsupported code/u);
    const wrongFeature = { ...artifact, cases: { ...artifact.cases, STR006: { ...artifact.cases.STR006, feature: "statement.stream" } } } as typeof artifact;
    assert.throws(() => validateCertificationArtifact(wrongFeature, { sourceSha: "candidate-a4" }), /supported capability/u);
  });

  test("keeps portability tuples and Bun SQLite in the required inventory", () => {
    assert.ok(REQUIRED_CERTIFICATION_TARGETS.includes("bun-sql-sqlite"));
    assert.ok(REQUIRED_CERTIFICATION_TARGETS.includes("postgres-pg-deno-2-9-3"));
    assert.ok(REQUIRED_CERTIFICATION_TARGETS.includes("sqlite-wasm-browser-3-53-4"));
  });
});
