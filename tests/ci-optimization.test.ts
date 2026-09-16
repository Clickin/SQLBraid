import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { mergeReports, mergeVitestResults } from "../scripts/merge-vitest-results.mjs";
import { planChanges, verifyPlan } from "../scripts/ci-plan.mjs";
import { validateRuntimeCompatibility } from "../scripts/validate-runtime-compatibility.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("runtime compatibility manifest validates exact floors and release cells", async () => {
  const result = await validateRuntimeCompatibility({ root });
  assert.deepEqual(result.cells, [
    "node-16-20-2-runtime",
    "node-16-20-2-better-sqlite3-9-6-0",
    "node-22-18-0-better-sqlite3-13-0-3",
    "node-16-20-2-libsql-0-18-0",
  ]);
  assert.deepEqual(result.blockingCells, result.cells);
});

test("CI planner fails open for unknown changes and selects driver-local lanes", () => {
  const postgres = planChanges(["packages/postgres/src/pg.ts"], { eventName: "pull_request", baseKnown: true });
  assert.equal(postgres.all, false);
  assert.equal(postgres.db, true);
  assert.deepEqual(postgres.db_matrix, ["postgres"]);
  assert.equal(postgres.common, true);
  assert.equal(postgres.packages, true);
  assert.equal(postgres.node24, true);
  assert.equal(postgres.packed, true);
  assert.equal(postgres.compatibility, true);
  assert.deepEqual(postgres.compatibility_matrix.length, 4);
  const sqlite = planChanges(["packages/sqlite/src/libsql.ts"], { eventName: "pull_request", baseKnown: true });
  assert.equal(sqlite.compatibility, true);
  assert.deepEqual(sqlite.compatibility_matrix.map(({ id }) => id), [
    "node-16-20-2-runtime",
    "node-16-20-2-better-sqlite3-9-6-0",
    "node-22-18-0-better-sqlite3-13-0-3",
    "node-16-20-2-libsql-0-18-0",
  ]);
  assert.equal(planChanges(["new/unknown-file.txt"], { eventName: "pull_request", baseKnown: true }).all, false);
  assert.equal(planChanges(["new/unknown-file.txt"], { eventName: "push", baseKnown: true }).all, true);
  assert.equal(planChanges([], { eventName: "pull_request", baseKnown: false }).all, true);
  const plan = planChanges(["website/index.md"], { eventName: "pull_request", baseKnown: true });
  verifyPlan(plan, {
    plan: "success",
    prepare: "success",
    common: "success",
    db: "skipped",
    web: "skipped",
    vscode: "skipped",
    packages: "skipped",
    node24: "skipped",
    packed: "skipped",
    compatibility: "skipped",
    bun_sql: "skipped",
    evidence: "skipped",
  });
  assert.throws(() => verifyPlan(plan, { plan: "success", prepare: "success", common: "skipped" }), /CI lane common/u);
});

function report(name: string, title: string, status: string = "passed") {
  return {
    success: true,
    testResults: [{ name, assertionResults: [{ status, title, fullName: title }] }],
  };
}

async function shard(rootDirectory: string, name: string, value: unknown) {
  const directory = join(rootDirectory, `ci-evidence-${name}`);
  await mkdir(join(directory, "observations"), { recursive: true });
  await writeFile(join(directory, "results.json"), `${JSON.stringify(value)}\n`);
  const success = value !== null && typeof value === "object" && "success" in value && value.success === true;
  await writeFile(join(directory, "status.json"), `${JSON.stringify({ success })}\n`);
  await writeFile(join(directory, "observations", `${name}.json`), `${JSON.stringify({ shard: name })}\n`);
}

test("Vitest shard merging rejects failed, missing, and conflicting inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-ci-merge-"));
  try {
    const passing = report("tests/a.test.ts", "a");
    assert.deepEqual(mergeReports([{ path: "a", report: passing }, { path: "b", report: passing }]).testResults, passing.testResults);
    assert.throws(() => mergeReports([{ path: "failed", report: { ...passing, success: false } }]), /Vitest shard failed/u);
    assert.throws(() => mergeReports([
      { path: "a", report: passing },
      { path: "b", report: report("tests/a.test.ts", "different") },
    ]), /Conflicting duplicate/u);
    await shard(directory, "postgres", passing);
    await assert.rejects(
      mergeVitestResults({
        artifactRoot: directory,
        expected: ["postgres", "mysql"],
        output: join(directory, "merged.json"),
        observationsOutput: join(directory, "merged-observations"),
      }),
      /Missing required evidence artifact: mysql/u,
    );
    await shard(directory, "mysql", { ...passing, success: false });
    await assert.rejects(
      mergeVitestResults({
        artifactRoot: directory,
        expected: ["postgres", "mysql"],
        output: join(directory, "merged.json"),
        observationsOutput: join(directory, "merged-observations"),
      }),
      /Evidence shard failed outside Vitest/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("support evidence preserves passed assertion matching and PostgreSQL target selection", async () => {
  const target = JSON.parse(await readFile(join(root, "support/targets/postgres.json"), "utf8"));
  const currentTarget = JSON.parse(await readFile(join(root, "support/targets/postgres-current.json"), "utf8"));
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-ci-evidence-"));
  try {
    const results = join(directory, "results.json");
    const evidence = join(directory, "evidence.json");
    const observations = join(directory, "observations");
    await mkdir(observations);
    await writeFile(results, JSON.stringify(report("tests/db/postgres/capabilities.test.ts", "postgres.sql.native-transparency")));
    await writeFile(join(observations, "postgres.json"), JSON.stringify({
      targetId: target.id,
      database: target.database,
      driver: target.driver,
      runtime: target.runtime,
      typePolicy: target.typePolicy,
    }));
    await run(process.execPath, ["scripts/support-evidence.mjs", results, evidence, observations], { cwd: root });
    const output = JSON.parse(await readFile(evidence, "utf8"));
    const selected = output.targets.find((entry: { id: string }) => entry.id === target.id);
    assert.ok(selected);
    assert.equal(selected.exactTupleObserved, true);
    assert.equal(output.targets.some((entry: { id: string }) => entry.id === currentTarget.id), false);

    await writeFile(join(observations, "postgres-current.json"), JSON.stringify({
      targetId: currentTarget.id,
      database: currentTarget.database,
      driver: currentTarget.driver,
      runtime: currentTarget.runtime,
      typePolicy: currentTarget.typePolicy,
    }));
    await run(process.execPath, ["scripts/support-evidence.mjs", results, evidence, observations], {
      cwd: root,
      env: { ...process.env, SQLBRAID_POSTGRES_TARGET: "postgres-current" },
    });
    const currentOutput = JSON.parse(await readFile(evidence, "utf8"));
    const current = currentOutput.targets.find((entry: { id: string }) => entry.id === currentTarget.id);
    assert.ok(current);
    assert.equal(current.exactTupleObserved, true);
    assert.equal(currentOutput.targets.some((entry: { id: string }) => entry.id === target.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

