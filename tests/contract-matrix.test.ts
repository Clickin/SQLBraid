import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  loadContractMatrix,
  reportEvidence,
  validateMatrix,
  validateReports,
} from "../scripts/validate-contract-matrix.mjs";

const sourceSha = "a".repeat(40);
const model = await loadContractMatrix();

function executionFixture() {
  const assertions = model.cells.filter((cell) => cell.releaseBlocking).map((cell) => ({
    title: `[contract:${cell.transport}:${cell.scenario}:${cell.layer}]${cell.ownership === "any" ? "" : ` [ownership:${cell.ownership}]`} proves the observable contract`,
    fullName: "This field is deliberately not evidence",
    status: "passed",
    failureMessages: [],
  }));
  const report = {
    success: true,
    wasInterrupted: false,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numTotalTests: assertions.length,
    numPassedTests: assertions.length,
    testResults: [{ name: "synthetic-validator-fixture", status: "passed", assertionResults: assertions }],
  };
  const manifest = {
    format: "sqlbraid-contract-report",
    version: 1,
    sourceSha,
    report: "vitest.json",
    reportSha256: "",
    allowedLayers: ["integration", "boundary"],
    producer: { node: "v22.18.0", platform: "linux", arch: "x64" },
    expectedTargets: Object.values(model.matrix.transports).map((entry) => {
      const target = model.targets.get(entry.target)!;
      return {
        target: target.id,
        transport: target.driver.id === "bun-sql" ? `bun-sql-${target.database.product}` : target.driver.id,
        database: target.database,
        driver: target.driver,
        runtime: target.runtime,
      };
    }),
  };
  return { report, manifest, assertions };
}

interface SerializedFixture {
  readonly report: object;
  readonly manifest: object;
}

async function withReport(fixture: SerializedFixture, run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-contract-evidence-"));
  try {
    const bytes = `${JSON.stringify(fixture.report)}\n`;
    const manifest = {
      ...fixture.manifest,
      reportSha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await writeFile(join(directory, "vitest.json"), bytes);
    await writeFile(join(directory, "vitest.json.contract.json"), JSON.stringify(manifest));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("contract matrix discovers every support transport/profile and retains capability-backed N/A reasons", () => {
  const required = model.cells.filter((cell) => cell.releaseBlocking);
  assert.ok(required.some((cell) => cell.transport === "pg" && cell.ownership === "direct"));
  assert.ok(required.some((cell) => cell.transport === "pg" && cell.ownership === "pooled"));
  assert.equal(required.some((cell) => cell.transport === "cloudflare-d1" && cell.scenario.startsWith("transaction.")), false);
  assert.ok(model.exclusions.some((cell) => cell.transport === "node-oracledb" &&
    cell.scenario === "transaction.savepoint-release-failure" && cell.requirement === "native:savepoint-release"));
});

test("contract matrix rejects removed scenarios, transports, wrong layers and invented exclusions", () => {
  const missingTransport = structuredClone(model.input);
  delete missingTransport.matrix.transports.pg;
  assert.throws(() => validateMatrix(missingTransport), /transport\/profile roster/u);

  const removedScenario = structuredClone(model.input);
  removedScenario.catalog.scenarios.pop();
  assert.throws(() => validateMatrix(removedScenario), /scenario catalog mapping/u);

  const missingMapping = structuredClone(model.input);
  delete missingMapping.matrix.transports.pg.scenarios["transaction.commit-confirmed"];
  assert.throws(() => validateMatrix(missingMapping), /pg scenarios/u);

  const forgedExclusion = structuredClone(model.input);
  forgedExclusion.matrix.transports.pg.scenarios["transaction.commit-confirmed"] = {
    notApplicable: { requirement: "capability:transaction", reason: "No test is available" },
  };
  assert.throws(() => validateMatrix(forgedExclusion), /contradictory N\/A/u);

  const forgedReason = structuredClone(model.input);
  forgedReason.matrix.transports["node-oracledb"].scenarios["transaction.savepoint-release-failure"].notApplicable.reason = "not implemented yet";
  assert.throws(() => validateMatrix(forgedReason), /N\/A reason/u);

  const wrongLayer = structuredClone(model.input);
  wrongLayer.matrix.transports.pg.scenarios["transaction.commit-confirmed"].evidence = ["boundary"];
  assert.throws(() => validateMatrix(wrongLayer), /wrong layer/u);
});

test("new support driver or profile cannot silently inherit another transport's evidence", () => {
  const newDriver = structuredClone(model.input);
  const target = structuredClone(newDriver.targets.find((entry) => entry.driver.id === "pg")!);
  target.id = "new-driver-target";
  target.driver.id = "new-driver";
  target.driver.profile = "new-driver-profile";
  newDriver.profiles.profiles["new-driver-profile"] = { driverId: "new-driver" };
  newDriver.targets.push(target);
  assert.throws(() => validateMatrix(newDriver), /transport\/profile roster/u);

  const newProfile = structuredClone(model.input);
  const profileTarget = structuredClone(newProfile.targets.find((entry) => entry.driver.id === "pg")!);
  profileTarget.id = "pg-native-target";
  profileTarget.driver.profile = "pg-native";
  newProfile.targets.push(profileTarget);
  assert.throws(() => validateMatrix(newProfile), /transport\/profile roster/u);

  const contradictoryCapability = structuredClone(model.input);
  contradictoryCapability.matrix.transports.pg.capabilityEvidence["transaction"] = {
    status: "unsupported", reason: "skip it", source: "packages/postgres/src/pg.ts",
  };
  assert.throws(() => validateMatrix(contradictoryCapability), /contradicts or duplicates support/u);
});

test("complete individual passed assertions satisfy the mandatory execution gate", async () => {
  const fixture = executionFixture();
  await withReport(fixture, async (directory) => {
    const result = await validateReports(directory, sourceSha, model);
    assert.equal(result.required, model.cells.filter((cell) => cell.releaseBlocking).length);
    assert.equal(result.passed, result.required);
  });
});

test("one passed assertion can supply every leading contract prefix it actually carries", async () => {
  const fixture = executionFixture();
  const commit = fixture.assertions.find((assertion) =>
    assertion.title.includes("[contract:pg:transaction.commit-confirmed:integration]") &&
    assertion.title.includes("[ownership:direct]"))!;
  const callback = fixture.assertions.findIndex((assertion) =>
    assertion.title.includes("[contract:pg:transaction.callback-rollback:integration]") &&
    assertion.title.includes("[ownership:direct]"));
  commit.title = "[contract:pg:transaction.commit-confirmed:integration] " +
    "[contract:pg:transaction.callback-rollback:integration] [ownership:direct] exercises both outcomes";
  fixture.assertions.splice(callback, 1);
  fixture.report.numTotalTests -= 1;
  fixture.report.numPassedTests -= 1;
  await withReport(fixture, async (directory) => {
    const result = await validateReports(directory, sourceSha, model);
    assert.equal(result.passed, result.required);
  });
});

test("a green report missing one required assertion or ownership path cannot pass", async () => {
  const fixture = executionFixture();
  fixture.assertions.shift();
  fixture.report.numTotalTests -= 1;
  fixture.report.numPassedTests -= 1;
  await withReport(fixture, async (directory) => {
    await assert.rejects(validateReports(directory, sourceSha, model), /missing passed execution evidence/u);
  });
  const anotherOwner = executionFixture();
  const direct = anotherOwner.assertions.find((assertion) => assertion.title.includes("[ownership:direct]"))!;
  direct.title = direct.title.replace("[ownership:direct]", "[ownership:pooled]");
  await withReport(anotherOwner, async (directory) => {
    await assert.rejects(validateReports(directory, sourceSha, model), /missing passed execution evidence/u);
  });
});

test("suite/fullName labels and hand-authored scenario summaries are not execution evidence", async () => {
  const fixture = executionFixture();
  const assertion = fixture.assertions[0]!;
  assertion.fullName = assertion.title;
  assertion.title = "ordinary passing assertion";
  await withReport(fixture, async (directory) => {
    await assert.rejects(validateReports(directory, sourceSha, model), /missing passed execution evidence/u);
  });
  assert.throws(() => reportEvidence({ success: true, scenarios: ["transaction.commit-confirmed"] }, fixture.manifest, model, sourceSha), /Vitest JSON execution/u);
});

test.each(["pending", "skipped", "todo", "failed"])("%s assertions never supply passed contract evidence", (status) => {
  const fixture = executionFixture();
  fixture.assertions[0]!.status = status;
  assert.throws(() => reportEvidence(fixture.report, fixture.manifest, model, sourceSha), /did not pass|failed or invalid/u);
});

test("unknown scenarios, transports, malformed tags and missing ownership reject instead of being ignored", () => {
  for (const title of [
    "[contract:pg:transaction.removed:integration] [ownership:direct]",
    "[contract:removed-driver:transaction.commit-confirmed:integration] [ownership:direct]",
    "[contract:pg:transaction.commit-confirmed:unit] [ownership:direct]",
    "[contract:pg:transaction.commit-confirmed:integration]",
  ]) {
    const fixture = executionFixture();
    fixture.assertions[0]!.title = title;
    assert.throws(() => reportEvidence(fixture.report, fixture.manifest, model, sourceSha), /unknown|malformed|missing ownership/u);
  }
});

test("wrong scenario layers, report layers, source revisions and profiles reject", () => {
  const wrongScenarioLayer = executionFixture();
  wrongScenarioLayer.assertions[0]!.title = "[contract:pg:transaction.commit-confirmed:boundary] [ownership:direct]";
  assert.throws(() => reportEvidence(wrongScenarioLayer.report, wrongScenarioLayer.manifest, model, sourceSha), /wrong evidence layer/u);

  const wrongReportLayer = executionFixture();
  wrongReportLayer.manifest.allowedLayers = ["boundary"];
  assert.throws(() => reportEvidence(wrongReportLayer.report, wrongReportLayer.manifest, model, sourceSha), /wrong provenance layer/u);

  const stale = executionFixture();
  stale.manifest.sourceSha = "b".repeat(40);
  assert.throws(() => reportEvidence(stale.report, stale.manifest, model, sourceSha), /stale report source SHA/u);

  const forgedProfile = structuredClone(executionFixture());
  forgedProfile.manifest.expectedTargets[0]!.driver.profile = "pg-native";
  assert.throws(() => reportEvidence(forgedProfile.report, forgedProfile.manifest, model, sourceSha), /forged or stale target\/profile/u);

  const wrongRuntime = executionFixture();
  wrongRuntime.manifest.producer.node = "v24.21.0";
  assert.throws(() => reportEvidence(wrongRuntime.report, wrongRuntime.manifest, model, sourceSha), /does not match canonical/u);
});

test("noncanonical database-version evidence cannot fill the canonical transport cells", async () => {
  const fixture = executionFixture();
  const pg = fixture.manifest.expectedTargets.findIndex((target) => target.transport === "pg");
  const current = model.targets.get("postgres-current")!;
  fixture.manifest.expectedTargets[pg] = {
    target: current.id, transport: "pg", database: current.database, driver: current.driver, runtime: current.runtime,
  };
  await withReport(fixture, async (directory) => {
    await assert.rejects(validateReports(directory, sourceSha, model), /missing passed execution evidence/u);
  });
});

test("missing provenance, tampered report bytes and truncated passing totals cannot pass", async () => {
  const fixture = executionFixture();
  await withReport(fixture, async (directory) => {
    await writeFile(join(directory, "vitest.json"), `${JSON.stringify(fixture.report)} \n`);
    await assert.rejects(validateReports(directory, sourceSha, model), /digest\/name mismatch/u);
    await rm(join(directory, "vitest.json.contract.json"));
    await assert.rejects(validateReports(directory, sourceSha, model), /no execution report provenance/u);
  });
  const incomplete = executionFixture();
  incomplete.assertions.pop();
  assert.throws(() => reportEvidence(incomplete.report, incomplete.manifest, model, sourceSha), /contradictory Vitest assertion totals/u);
});
