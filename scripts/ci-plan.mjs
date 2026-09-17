#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const databases = ["postgres", "mysql", "mariadb", "oracle", "mssql", "sqlite"];
const compatibilityManifest = JSON.parse(
  readFileSync(new URL("../support/runtime-compatibility.json", import.meta.url), "utf8"),
);
const compatibilityMatrix = compatibilityManifest.cells.map((cell) => ({
  id: cell.id,
  node: cell.runtime.version,
  driver: cell.driver?.package ?? null,
  driver_version: cell.driver?.version ?? null,
}));
const allPatterns = [
  /^packages\/(?:core|template|runtime|operations)\//u,
  /^(?:shared|vitest\.config\.ts|tsconfig[^/]*|tsdown\.config\.ts|pnpm-workspace\.yaml|pnpm-lock\.yaml|package\.json)\b/u,
  /^tests\/(?!db\/(?:postgres|mysql|mariadb|oracle|mssql|sqlite|bun-sql|d1|wasm)\/)/u,
  /^(?:support|\.github\/workflows)\//u,
  /^(?:scripts\/(?:certification|ci-plan|merge-vitest-results|runtime-portability|runtime-compatibility-smoke|validate-runtime-compatibility|validate-runtime-floor)\.mjs)$/u,
  /^vitest\.certification\.config\.ts$/u,
  /^\.meta\//u,
];
const databasePatterns = Object.fromEntries(
  databases.map((database) => [
    database,
    [
      new RegExp(`^packages/${database === "sqlite" ? "sqlite" : database}/`, "u"),
      new RegExp(`^tests/db/${database}/`, "u"),
    ],
  ]),
);

if (import.meta.main) main(process.argv.slice(2));

function allPlan() {
  return {
    all: true,
    common: true,
    db: true,
    web: true,
    vscode: true,
    packages: true,
    node24: true,
    packed: true,
    compatibility: true,
    compatibility_matrix: compatibilityMatrix,
    bun_sql: true,
    evidence: true,
    db_matrix: databases,
    evidence_shards: [...databases, "web", "bun-sql"],
  };
}

function emptyPlan() {
  return {
    all: false,
    common: false,
    db: false,
    web: false,
    vscode: false,
    packages: false,
    node24: false,
    packed: false,
    compatibility: false,
    compatibility_matrix: [],
    bun_sql: false,
    evidence: false,
    db_matrix: [],
    evidence_shards: [],
  };
}

function planChanges(files, { eventName = "pull_request", baseKnown = true } = {}) {
  if (
    eventName !== "pull_request" ||
    !baseKnown ||
    files.some((file) => allPatterns.some((pattern) => pattern.test(file)))
  )
    return allPlan();
  const plan = emptyPlan();
  for (const file of files) {
    let matchedDatabase = false;
    let sqliteChanged = false;
    for (const database of databases) {
      if (databasePatterns[database].some((pattern) => pattern.test(file))) {
        plan[database] = true;
        matchedDatabase = true;
        sqliteChanged ||= database === "sqlite";
      }
    }
    if (matchedDatabase) {
      plan.common = true;
      plan.packages = true;
      plan.node24 = true;
      plan.packed = true;
      plan.compatibility = true;
      if (sqliteChanged) plan.web = true;
      continue;
    }
    if (file.startsWith("packages/bun-sql/") || file.startsWith("tests/db/bun-sql/") || /bun-sql-matrix/u.test(file)) {
      plan.bun_sql = true;
      plan.common = true;
      plan.packages = true;
      plan.packed = true;
      plan.compatibility = true;
      continue;
    }
    if (
      /^(?:tests\/scripts\/test-browser\.mjs|tests\/scripts\/test-d1\.mjs|tests\/db\/(?:d1|wasm)\/|packages\/sqlite\/)/u.test(
        file,
      )
    ) {
      plan.web = true;
      plan.common = true;
      plan.packages = true;
      plan.node24 = true;
      plan.packed = true;
      plan.compatibility = true;
      continue;
    }
    if (/^(?:extensions\/vscode\/|scripts\/test-vscode\.mjs)/u.test(file)) {
      plan.vscode = true;
      plan.packages = true;
      continue;
    }
    if (/^(?:website\/|docs\/)/u.test(file)) {
      plan.common = true;
      continue;
    }
    plan.common = true;
    plan.packages = true;
    plan.node24 = true;
    plan.packed = true;
    plan.compatibility = true;
  }
  if (plan.compatibility) plan.compatibility_matrix = compatibilityMatrix;
  plan.db_matrix = databases.filter((database) => plan[database]);
  plan.db = plan.db_matrix.length > 0;
  plan.evidence = plan.db || plan.web || plan.bun_sql;
  plan.evidence_shards = [...plan.db_matrix, ...(plan.web ? ["web"] : []), ...(plan.bun_sql ? ["bun-sql"] : [])];
  return plan;
}

function outputPlan(plan, outputPath) {
  const lines = [
    `plan=${JSON.stringify(plan)}`,
    ...Object.entries(plan).map(
      ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    ),
  ];
  return outputPath ? writeFileSync(outputPath, `${lines.join("\n")}\n`) : lines.join("\n");
}

function gitFiles(base, head) {
  return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function verifyPlan(plan, results) {
  assert.equal(results.plan, "success", `CI planner result was ${results.plan}.`);
  const expected = {
    prepare: "success",
    common: plan.common ? "success" : "skipped",
    db: plan.db ? "success" : "skipped",
    web: plan.web ? "success" : "skipped",
    vscode: plan.vscode ? "success" : "skipped",
    packages: plan.packages ? "success" : "skipped",
    node24: plan.node24 ? "success" : "skipped",
    packed: plan.packed ? "success" : "skipped",
    compatibility: plan.compatibility ? "success" : "skipped",
    bun_sql: plan.bun_sql ? "success" : "skipped",
    evidence: plan.evidence ? "success" : "skipped",
  };
  for (const [lane, expectedResult] of Object.entries(expected)) {
    assert.equal(results[lane], expectedResult, `CI lane ${lane}: expected ${expectedResult}, got ${results[lane]}.`);
  }
}

function parseArgs(argv) {
  const args = Object.fromEntries(
    argv.map((arg, index) => (arg.startsWith("--") ? [arg.slice(2), argv[index + 1]] : [])).filter(([key]) => key),
  );
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.verify) {
    verifyPlan(JSON.parse(args.verify), JSON.parse(args.results));
    console.info("CI plan and selected lane results are valid.");
    return;
  }
  const eventName = process.env.GITHUB_EVENT_NAME ?? "pull_request";
  const base = process.env.CI_BASE_SHA;
  const head = process.env.GITHUB_SHA;
  let files = [];
  let baseKnown = Boolean(base && head);
  if (baseKnown && eventName === "pull_request") {
    try {
      files = gitFiles(base, head);
    } catch {
      baseKnown = false;
    }
  }
  const plan = planChanges(files, { eventName, baseKnown });
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    outputPlan(plan, output);
  } else {
    console.log(JSON.stringify(plan));
  }
}

export { allPlan, emptyPlan, planChanges, verifyPlan };
