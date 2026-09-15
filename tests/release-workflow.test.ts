import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parse } from "yaml";
import { allPlan, planChanges } from "../scripts/ci-plan.mjs";

interface Step { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { name?: string; if?: string; needs?: string | string[]; permissions?: Record<string, string>; env?: Record<string, string>; concurrency?: Record<string, unknown>; steps: Step[] }
interface Workflow {
  on: Record<string, { tags?: string[]; inputs?: Record<string, { default?: unknown; options?: string[]; description?: string }> } | null>;
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

const mutationJobs = ["release-stage", "release-draft"];

test("dispatch defaults to certification and version tags trigger all three validation workflows", () => {
  assert.deepEqual(release.on.workflow_dispatch?.inputs?.release_mode.options, ["certify", "pack-only", "stage"]);
  assert.equal(release.on.workflow_dispatch?.inputs?.release_mode.default, "certify");
  for (const workflow of [release, runtime, docs]) assert.ok(workflow.on.push?.tags?.includes("v*"));
  assert.equal(release.jobs["release-bootstrap"], undefined);
  assert.equal(release.jobs["release-publish"], undefined);
  assert.match(release.on.workflow_dispatch?.inputs?.release_mode.description ?? "", /\bstage\b/u);
});

test("main, PR, manual certification, and every version tag cannot reach a release mutation", () => {
  for (const [event, mode, ref] of [
    ["push", "certify", "refs/heads/main"], ["pull_request", "certify", "refs/pull/1/merge"],
    ["workflow_dispatch", "certify", "refs/heads/main"], ["workflow_dispatch", "pack-only", "refs/heads/main"],
    ...["v0.1.0-rc.0", "v0.1.0-rc.1", "v0.1.0"].map((tag) => ["push", "certify", `refs/tags/${tag}`]),
  ]) {
    const { results } = graph(release, event, mode, ref);
    for (const name of mutationJobs) assert.equal(results[name].result, "skipped", `${event}/${mode}/${ref}: ${name}`);
  }
  const dryRun = release.jobs["release-final"].steps.find((step) => step.run?.includes("--mode stage-dry-run"));
  assert.ok(dryRun);
  assert.equal(graph(release, "workflow_dispatch", "certify").stepRuns(dryRun), true);
  assert.equal(graph(release, "push", "certify", "refs/tags/v0.1.0").stepRuns(dryRun), true);
});

test("explicit staging reaches only the staging job and a successful stage authorizes the draft", () => {
  const mode = "stage";
  const { results } = graph(release, "workflow_dispatch", mode, "refs/tags/v0.1.0-rc.0");
  assert.equal(results["release-stage"].result, "success");
  assert.equal(results["release-draft"].result, "success");
  assert.equal(graph(release, "workflow_dispatch", mode, "refs/tags/v0.1.0-rc.0", "release-stage").results["release-draft"].result, "skipped");
  for (const lane of dependencies(release.jobs["release-final"])) {
    const failed = graph(release, "workflow_dispatch", mode, "refs/tags/v0.1.0-rc.0", lane).results;
    assert.equal(failed["release-stage"].result, "skipped", `staging escaped failed ${lane}`);
    assert.equal(failed["release-draft"].result, "skipped");
  }
});

test("full certification and mutation prerequisites include every release lane and pnpm stage dry-run", () => {
  const lanes = dependencies(release.jobs["release-final"]);
  for (const name of ["release-prep", "release-common", "release-db", "release-node24", "release-browser", "release-vscode", "release-pack", "release-docs", "release-examples", "release-benchmarks", "release-runtime", "release-bun-sql", "release-support-evidence", "release-target-evidence"]) assert.ok(lanes.includes(name), `missing ${name}`);
  const dryRun = release.jobs["release-final"].steps.find((step) => step.run?.includes("--mode stage-dry-run"));
  assert.ok(dryRun);
  for (const mode of ["certify", "stage"]) assert.equal(graph(release, "workflow_dispatch", mode, "refs/tags/v0.1.0-rc.0").stepRuns(dryRun), true);
  assert.equal(graph(release, "push", "certify", "refs/tags/v0.1.0-rc.0").stepRuns(dryRun), true);
  assert.equal(graph(release, "workflow_dispatch", "pack-only").stepRuns(dryRun), false);
  assert.ok(release.jobs["release-final"].steps.some((step) => step.run?.includes("--mode preflight")));
});

test("job capabilities isolate OIDC and release writes", () => {
  assert.deepEqual(release.permissions, { contents: "read" });
  assert.deepEqual(release.jobs["release-stage"].permissions, { contents: "read", actions: "read", "id-token": "write" });
  assert.deepEqual(release.jobs["release-draft"].permissions, { contents: "write" });
  for (const [name, job] of Object.entries(release.jobs)) {
    const permissions: Record<string, string> = job.permissions ?? release.permissions;
    if (name !== "release-stage") assert.notEqual(permissions["id-token"], "write");
    if (name !== "release-draft") assert.notEqual(permissions.contents, "write");
    for (const env of [release.env, job.env, ...job.steps.map((step) => step.env)]) {
      for (const [key, value] of Object.entries(env ?? {})) {
        assert.doesNotMatch(key, /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_BOOTSTRAP_TOKEN)$/u);
        assert.doesNotMatch(value, /secrets\./u);
      }
    }
  }
  const stage = release.jobs["release-stage"];
  assert.ok(stage.steps.every((step) => step.with?.["registry-url"] === undefined), "setup-node must not inject fallback token configuration");
  for (const job of Object.values(release.jobs)) {
    for (const step of job.steps) {
      assert.doesNotMatch(step.run ?? "", /\bnpm\s+(?:publish|install|i)\b/u, "release job must not publish or upgrade npm CLI");
    }
  }
});

test("staging is serialized, reuses the validated candidate, and preserves partial evidence", () => {
  const stage = release.jobs["release-stage"];
  assert.deepEqual(stage.concurrency, { group: "npm-stage-${{ github.ref }}", "cancel-in-progress": false });
  const download = stage.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download?.with?.name, "release-candidate-validated");
  assert.ok(stage.steps.some((step) => step.run?.includes("release-candidate-validated.tar.gz")));
  assert.ok(stage.steps.some((step) => step.run?.includes("--mode stage")));
  assert.ok(stage.steps.every((step) => !/\bpnpm\s+(?:run\s+)?(?:build|pack)\b/u.test(step.run ?? "")));
  const evidence = stage.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(evidence?.if, "always()");
  assert.match(String(evidence?.with?.path), /staged-publication\.json/u);
  assert.match(String(evidence?.with?.path), /release-manifest\.json/u);
});

test("staging has no approval or direct publication path and draft release remains pending", () => {
  const stage = release.jobs["release-stage"];
  const stageRun = stage.steps.map((step) => step.run ?? "").join("\n");
  assert.match(stageRun, /--mode stage\b/u);
  assert.doesNotMatch(stageRun, /--mode (?:publish|bootstrap|publish-dry-run)\b/u);
  assert.doesNotMatch(stageRun, /\bnpm\s+publish\b/u);
  assert.ok(!stage.steps.some((step) => /(?:approve|promote)/iu.test(`${step.name ?? ""}\n${step.run ?? ""}`)));
  const draft = release.jobs["release-draft"];
  assert.match(draft.name ?? "", /draft.*approval pending/iu);
  assert.match(draft.steps.find((step) => step.run?.includes("gh release create"))?.run ?? "", /--draft/u);
  assert.match(draft.steps.find((step) => step.run?.includes("gh release create"))?.run ?? "", /approval pending/iu);
  assert.match(draft.if ?? "", /needs\.release-stage\.result == 'success'/u);
});

test("preparation enforces an exact version tag for staging", () => {
  const determine = release.jobs["release-prep"].steps.find((step) => step.name === "Determine release version");
  assert.ok(determine);
  assert.match(determine.run ?? "", /GITHUB_EVENT_NAME.*workflow_dispatch.*SQLBRAID_RELEASE_MODE.*stage/isu);
  assert.match(determine.run ?? "", /GITHUB_REF_TYPE.*tag/u);
  assert.match(determine.run ?? "", /tag_version.*manifest_version/u);
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
