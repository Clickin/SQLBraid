import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { aggregateCertificationArtifacts, certifyTarget, validateCertificationArtifact } from "./runner.js";
import { executeCertificationCase } from "./cases.js";
import { createSyntheticTarget } from "./targets/synthetic.js";
import { REQUIRED_CERTIFICATION_TARGETS } from "./targets/inventory.js";
import { REQUIRED_CASE_IDS } from "./types.js";
import { runStreamingConformanceCase } from "../streaming-conformance.js";

describe("A4 certification harness", () => {
  test("runs every required public API case against a deterministic synthetic target", async () => {
    const artifact = await certifyTarget(createSyntheticTarget("candidate-a4"));

    validateCertificationArtifact(artifact, { sourceSha: "candidate-a4" });
    assert.equal(Object.keys(artifact.cases).length, REQUIRED_CASE_IDS.length);
    assert.equal(artifact.cases.CAP002.status, "pass");
    assert.equal(artifact.cases.STR006.status, "pass-unsupported");
    assert.equal(artifact.cases.STR006.code, "BRAID_CANCEL_UNSUPPORTED");
  });

  test("proves guarded empty results use the actual conditional unsupported boundary", async () => {
    const target = createSyntheticTarget("candidate-guarded-empty", true, { resultRowsGuarded: true, resultSetsUnsupported: true });
    const artifact = await certifyTarget(target);
    assert.equal(artifact.cases.CAP002.status, "pass");
    assert.equal(artifact.cases.QRY010.status, "pass");
    assert.equal(artifact.cases.QRY021.status, "pass");
    assert.equal(artifact.cases.QRY030.status, "pass");
    assert.deepEqual(artifact.expectedGuardedCases, target.expectedGuardedCases);
    assert.equal(artifact.cases.CALL004.status, "pass-unsupported");
    assert.equal(artifact.cases.CALL004.feature, "routine.result-sets");
    assert.equal(artifact.cases.CALL004.code, "BRAID_RESULT_SETS_UNSUPPORTED");
  });

  test("rejects incomplete or mismatched strict streaming evidence", async () => {
    const fixture = await createSyntheticTarget("candidate-a4-negative").createFixture();
    const stream = fixture.stream!;
    const run = (overrides: Partial<typeof stream>, id: "STR004" | "STR009") => runStreamingConformanceCase(
      id,
      () => ({ ...stream, ...overrides, close: undefined }),
    );
    await assert.rejects(() => run({ mappingQuery: undefined }, "STR004"), /mappingQuery/u);
    await assert.rejects(
      () => run({ mappingFailure: new Error("wrong mapping failure") }, "STR004"),
      (error: unknown) => error instanceof Error && error.name === "CertificationAssertionError",
    );
    await assert.rejects(() => run({ largeResultQuery: undefined }, "STR009"), /largeResultQuery/u);
    await assert.rejects(() => run({ largeResultCount: undefined }, "STR009"), /largeResultCount/u);
  });

  test("accepts native DML proofs but never bypasses an unsupported public API probe", async () => {
    const base = createSyntheticTarget("candidate-native-family");
    const baseFixture = await base.createFixture();
    let nativeProofs = 0;
    const nativeFixture = {
      ...baseFixture,
      representationUnsupported: {
        "dml.insert-returning": {
          prove: async () => {
            nativeProofs += 1;
            await baseFixture.db.one(baseFixture.queries.identity);
          },
        },
      },
    };
    const nativeTarget = {
      ...base,
      expectedCapabilities: {
        ...base.expectedCapabilities,
        "dml.insert-returning": { status: "unsupported" as const },
      },
    };
    const nativeResult = await executeCertificationCase(nativeTarget, nativeFixture, "CAP002", { stress: false });
    assert.equal(nativeResult.status, "pass");
    assert.equal(nativeProofs, 1);

    const apiFixture = {
      ...baseFixture,
      representationUnsupported: {
        "statement.stream": { prove: async () => undefined },
      },
    };
    const apiTarget = {
      ...base,
      expectedCapabilities: {
        ...base.expectedCapabilities,
        "statement.stream": { status: "unsupported" as const },
      },
    };
    const apiResult = await executeCertificationCase(apiTarget, apiFixture, "CAP002", { stress: false });
    assert.equal(apiResult.status, "fail");
    assert.match(apiResult.error ?? "", /missing unsupported API probe for statement\.stream/u);
    await baseFixture.close?.();
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
      expectedCapabilities: { ...artifact.expectedCapabilities, "statement.stream": { status: "unsupported", unsupportedCode: "BRAID_STREAM_UNSUPPORTED" } },
      declaredCapabilities: { ...artifact.declaredCapabilities, "statement.stream": { status: "unsupported" } },
      cases: { ...artifact.cases, STR001: { status: "pass-unsupported", name: "STR001", feature: "statement.stream", code: "BRAID_STREAM_UNSUPPORTED" } },
    } as typeof artifact;
    assert.doesNotThrow(() => validateCertificationArtifact(forged, { sourceSha: "candidate-a4" }));
    assert.throws(() => aggregateCertificationArtifacts([forged], { sourceSha: "candidate-a4", requiredTargets, requiredTargetContracts, requiredTargetOptionContracts }), /expected capability contract/u);
    const wrongCode = { ...artifact, cases: { ...artifact.cases, STR006: { ...artifact.cases.STR006, code: "BRAID_STREAM_UNSUPPORTED" } } } as typeof artifact;
    assert.throws(() => validateCertificationArtifact(wrongCode, { sourceSha: "candidate-a4" }), /unregistered unsupported/u);
    const wrongFeature = { ...artifact, cases: { ...artifact.cases, STR006: { ...artifact.cases.STR006, feature: "statement.stream" } } } as typeof artifact;
    assert.throws(() => validateCertificationArtifact(wrongFeature, { sourceSha: "candidate-a4" }), /supported capability/u);
  });

  test("keeps portability tuples and Bun SQLite in the required inventory", () => {
    assert.ok(REQUIRED_CERTIFICATION_TARGETS.includes("bun-sql-sqlite"));
    assert.ok(REQUIRED_CERTIFICATION_TARGETS.includes("postgres-pg-deno-2-9-3"));
    assert.ok(REQUIRED_CERTIFICATION_TARGETS.includes("sqlite-wasm-browser-3-53-4"));
  });
});
