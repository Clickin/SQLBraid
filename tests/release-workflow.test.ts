import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parse } from "yaml";
import { allPlan, planChanges } from "../scripts/ci-plan.mjs";

interface Step { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string | string[]; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] }
interface Workflow {
  on: Record<string, { tags?: string[]; inputs?: Record<string, { default?: unknown; options?: string[] }> } | null>;
  permissions: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}
const load = (name: string): Workflow => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
const release = load("release");
const runtime = load("runtime-portability");
const docs = load("docs-pages");
const dependencies = (job: Job) => typeof job.needs === "string" ? [job.needs] : job.needs ?? [];

function evaluate(expression: string | undefined, github: object, inputs: object, needs: object, env: object, success: boolean) {
  if (!expression) return success;
  const body = expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(/needs\.([\w-]+)/gu, (_, name: string) => `needs[${JSON.stringify(name)}]`);
  // These are repository-owned workflow expressions, not untrusted input. Match GitHub's implicit success gate.
  if (!/\b(?:always|success|failure|cancelled)\(/u.test(body) && !success) return false;
  return Boolean(Function("github", "inputs", "needs", "env", "success", "always", `return (${body});`)(github, inputs, needs, env, () => success, () => true));
}

function graph(workflow: Workflow, event: string, mode = "certify", ref = "refs/heads/main", failed?: string, deploy = false) {
  const results: Record<string, { result: string }> = {};
  const github = { event_name: event, ref };
  const inputs = { release_mode: event === "workflow_dispatch" ? mode : undefined, deploy };
  const env = { SQLBRAID_RELEASE_MODE: event === "workflow_dispatch" ? mode : "certify" };
  const pending = new Set(Object.keys(workflow.jobs));
  while (pending.size) {
    const available = [...pending].filter((name) => dependencies(workflow.jobs[name]).every((dependency) => dependency in results));
    assert.ok(available.length, "workflow DAG contains a cycle or unknown dependency");
    for (const name of available) {
      const job = workflow.jobs[name];
      const success = dependencies(job).every((dependency) => results[dependency].result === "success");
      const runs = evaluate(job.if, github, inputs, results, env, success);
      results[name] = { result: runs ? name === failed ? "failure" : "success" : "skipped" };
      pending.delete(name);
    }
  }
  return { results, stepRuns: (step: Step) => evaluate(step.if, github, inputs, results, env, true) };
}

const mutationJobs = ["release-bootstrap", "release-publish", "release-draft"];

test("dispatch defaults to certification and version tags trigger all three validation workflows", () => {
  assert.deepEqual(release.on.workflow_dispatch?.inputs?.release_mode.options, ["certify", "pack-only", "bootstrap-rc0", "publish"]);
  assert.equal(release.on.workflow_dispatch?.inputs?.release_mode.default, "certify");
  for (const workflow of [release, runtime, docs]) assert.ok(workflow.on.push?.tags?.includes("v*"));
});

test("main, PR, manual certification, and every version tag cannot reach a release mutation", () => {
  for (const [event, mode, ref] of [
    ["push", "certify", "refs/heads/main"], ["pull_request", "certify", "refs/pull/1/merge"],
    ["workflow_dispatch", "certify", "refs/heads/main"], ["workflow_dispatch", "pack-only", "refs/heads/main"],
    ...["v0.1.0-rc.0", "v0.1.0-rc.1", "v0.1.0"].map((tag) => ["push", "publish", `refs/tags/${tag}`]),
  ]) {
    const { results } = graph(release, event, mode, ref);
    for (const name of mutationJobs) assert.equal(results[name].result, "skipped", `${event}/${mode}/${ref}: ${name}`);
  }
});

test("explicit publication reaches only its own mutation job and a successful publication authorizes the draft", () => {
  for (const mode of ["bootstrap-rc0", "publish"]) {
    const active = mode === "publish" ? "release-publish" : "release-bootstrap";
    const other = mode === "publish" ? "release-bootstrap" : "release-publish";
    const { results } = graph(release, "workflow_dispatch", mode, "refs/tags/v0.1.0-rc.0");
    assert.equal(results[active].result, "success");
    assert.equal(results[other].result, "skipped");
    assert.equal(results["release-draft"].result, "success");
    assert.equal(graph(release, "workflow_dispatch", mode, "refs/tags/v0.1.0-rc.0", active).results["release-draft"].result, "skipped");
    for (const lane of dependencies(release.jobs["release-final"])) {
      const failed = graph(release, "workflow_dispatch", mode, "refs/tags/v0.1.0-rc.0", lane).results;
      assert.equal(failed[active].result, "skipped", `publication escaped failed ${lane}`);
      assert.equal(failed["release-draft"].result, "skipped");
    }
  }
});

test("full certification and mutation prerequisites include every release lane and pnpm dry-run", () => {
  const lanes = dependencies(release.jobs["release-final"]);
  for (const name of ["release-prep", "release-common", "release-db", "release-node24", "release-browser", "release-vscode", "release-pack", "release-docs", "release-examples", "release-benchmarks", "release-runtime", "release-bun-sql", "release-support-evidence", "release-target-evidence"]) assert.ok(lanes.includes(name), `missing ${name}`);
  const dryRun = release.jobs["release-final"].steps.find((step) => step.run?.includes("--mode publish-dry-run"));
  assert.ok(dryRun);
  for (const mode of ["certify", "bootstrap-rc0", "publish"]) assert.equal(graph(release, "workflow_dispatch", mode).stepRuns(dryRun), true);
  assert.equal(graph(release, "push", "certify", "refs/tags/v0.1.0-rc.0").stepRuns(dryRun), true);
  assert.equal(graph(release, "workflow_dispatch", "pack-only").stepRuns(dryRun), false);
});

test("job capabilities isolate OIDC, static bootstrap credentials, and release writes", () => {
  assert.deepEqual(release.permissions, { contents: "read" });
  assert.deepEqual(release.jobs["release-publish"].permissions, { contents: "read", actions: "read", "id-token": "write" });
  assert.deepEqual(release.jobs["release-bootstrap"].permissions, { contents: "read", actions: "read" });
  assert.deepEqual(release.jobs["release-draft"].permissions, { contents: "write" });
  for (const [name, job] of Object.entries(release.jobs)) {
    const permissions: Record<string, string> = job.permissions ?? release.permissions;
    if (name !== "release-publish") assert.notEqual(permissions["id-token"], "write");
    if (name !== "release-draft") assert.notEqual(permissions.contents, "write");
    for (const env of [release.env, job.env, ...job.steps.map((step) => step.env)]) {
      for (const [key, value] of Object.entries(env ?? {})) {
        if (/^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_BOOTSTRAP_TOKEN)$/u.test(key) || value.includes("secrets.")) assert.equal(name, "release-bootstrap");
      }
    }
  }
  const publish = release.jobs["release-publish"];
  assert.ok(publish.steps.every((step) => step.with?.["registry-url"] === undefined), "setup-node must not inject fallback token configuration");
  const bootstrapSecrets = release.jobs["release-bootstrap"].steps.filter((step) => Object.values(step.env ?? {}).some((value) => value.includes("secrets.NPM_BOOTSTRAP_TOKEN")));
  assert.equal(bootstrapSecrets.length, 1);
  assert.ok(bootstrapSecrets[0].run?.includes("--mode bootstrap-rc0"));
  for (const job of Object.values(release.jobs)) {
    for (const step of job.steps) {
      assert.doesNotMatch(step.run ?? "", /\bnpm\s+(?:publish|install|i)\b/u, "release job must not publish or upgrade npm CLI");
    }
  }
});

test("documentation tags and default dispatch validate without history or Pages mutation", () => {
  assert.deepEqual(docs.permissions, { contents: "read" });
  for (const event of ["push", "workflow_dispatch"]) {
    const { results } = graph(docs, event, "certify", "refs/tags/v0.1.0-rc.0");
    assert.equal(results.build.result, "success");
    assert.equal(results["publish-history"].result, "skipped");
    assert.equal(results.deploy.result, "skipped");
  }
  const authorized = graph(docs, "workflow_dispatch", "certify", "refs/heads/main", undefined, true).results;
  assert.equal(authorized["publish-history"].result, "success");
  assert.equal(authorized.deploy.result, "success");
  assert.equal(graph(docs, "workflow_dispatch", "certify", "refs/heads/main", "build", true).results.deploy.result, "skipped");
  assert.deepEqual(docs.jobs.build.permissions, { contents: "read" });
});

test("runtime manual and tag events retain full fail-open coverage", () => {
  assert.ok("workflow_dispatch" in runtime.on);
  assert.deepEqual(planChanges([], { eventName: "workflow_dispatch", baseKnown: false }), allPlan());
  assert.deepEqual(planChanges([], { eventName: "push", baseKnown: true }), allPlan());
  assert.notDeepEqual(planChanges(["README.md"], { eventName: "pull_request", baseKnown: true }), allPlan());
});
