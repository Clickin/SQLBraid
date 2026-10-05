import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parse } from "yaml";
import { allPlan, planChanges } from "../scripts/ci-plan.mjs";
import { releasePrereleaseArg } from "../scripts/release.mjs";

interface Step {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  steps: Step[];
}
interface Workflow {
  on: Record<
    string,
    {
      tags?: string[];
      paths?: string[];
      inputs?: Record<string, { default?: unknown; options?: string[]; description?: string; type?: string }>;
    } | null
  >;
  permissions: Record<string, string>;
  env?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<string, Job>;
}
const load = (name: string): Workflow =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
const release = load("release");
const vscode = load("vscode-release");
const runtime = load("runtime-portability");
const docs = load("docs-pages");
const dependencies = (job: Job) => (typeof job.needs === "string" ? [job.needs] : (job.needs ?? []));

function evaluate(
  expression: string | undefined,
  github: object,
  inputs: object,
  needs: object,
  env: object,
  success: boolean,
) {
  if (!expression) return success;
  const body = expression
    .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(/needs\.([\w-]+)/gu, (_, name: string) => `needs[${JSON.stringify(name)}]`);
  // These are repository-owned workflow expressions, not untrusted input. Match GitHub's implicit success gate.
  if (!/\b(?:always|success|failure|cancelled)\(/u.test(body) && !success) return false;
  return Boolean(
    Function(
      "github",
      "inputs",
      "needs",
      "env",
      "success",
      "always",
      `return (${body});`,
    )(
      github,
      inputs,
      needs,
      env,
      () => success,
      () => true,
    ),
  );
}

function graph(
  workflow: Workflow,
  event: string,
  mode = "certify",
  ref = "refs/heads/main",
  failed?: string,
  deploy = false,
) {
  const results: Record<string, { result: string }> = {};
  const github = { event_name: event, ref, ref_type: ref.startsWith("refs/tags/") ? "tag" : "branch" };
  const inputs = {
    release_mode: event === "workflow_dispatch" ? mode : undefined,
    release_package:
      event === "workflow_dispatch" ? release.on.workflow_dispatch?.inputs?.release_package?.default : undefined,
    deploy,
  };
  const env = {
    SQLBRAID_RELEASE_MODE: event === "workflow_dispatch" ? mode : "certify",
    SQLBRAID_RELEASE_PACKAGE: release.env?.SQLBRAID_RELEASE_PACKAGE,
  };
  const pending = new Set(Object.keys(workflow.jobs));
  while (pending.size) {
    const available = [...pending].filter((name) =>
      dependencies(workflow.jobs[name]).every((dependency) => dependency in results),
    );
    assert.ok(available.length, "workflow DAG contains a cycle or unknown dependency");
    for (const name of available) {
      const job = workflow.jobs[name];
      const success = dependencies(job).every((dependency) => results[dependency].result === "success");
      const runs = evaluate(job.if, github, inputs, results, env, success);
      results[name] = { result: runs ? (name === failed ? "failure" : "success") : "skipped" };
      pending.delete(name);
    }
  }
  return { results, stepRuns: (step: Step) => evaluate(step.if, github, inputs, results, env, true) };
}

const mutationJobs = ["release-recover", "release-draft"];

test("dispatch defaults to certification and version tags trigger all three validation workflows", () => {
  assert.deepEqual(release.on.workflow_dispatch?.inputs?.release_mode.options, [
    "certify",
    "pack-only",
    "stage",
    "recover",
  ]);
  assert.equal(release.on.workflow_dispatch?.inputs?.release_mode.default, "certify");
  assert.equal(release.on.workflow_dispatch?.inputs?.release_package?.type, "string");
  assert.equal(release.on.workflow_dispatch?.inputs?.prior_run_id?.default, "");
  assert.equal(release.on.workflow_dispatch?.inputs?.prior_run_id?.type, "string");
  assert.equal(release.on.workflow_dispatch?.inputs?.candidate_tag?.default, "");
  assert.equal(release.on.workflow_dispatch?.inputs?.candidate_tag?.type, "string");
  for (const workflow of [release, runtime, docs]) assert.ok(workflow.on.push?.tags?.includes("v*"));
  for (const workflow of [release, runtime]) assert.ok(workflow.on.push?.tags?.includes("*-v*"));
  assert.ok(!docs.on.push?.tags?.includes("*-v*"));
  assert.equal(release.jobs["release-bootstrap"], undefined);
  assert.equal(release.jobs["release-publish"], undefined);
  assert.match(release.on.workflow_dispatch?.inputs?.release_mode.description ?? "", /\bstage\b/u);
});

test("main, PR, manual certification, and every version tag cannot reach a release mutation", () => {
  for (const [event, mode, ref] of [
    ["push", "certify", "refs/heads/main"],
    ["pull_request", "certify", "refs/pull/1/merge"],
    ["workflow_dispatch", "certify", "refs/heads/main"],
    ["workflow_dispatch", "pack-only", "refs/heads/main"],
    ...["v0.1.0-rc.0", "v0.1.0-rc.1", "v0.1.0", "postgres-v1.0.1"].map((tag) => [
      "push",
      "certify",
      `refs/tags/${tag}`,
    ]),
  ]) {
    const { results } = graph(release, event, mode, ref);
    for (const name of mutationJobs) assert.equal(results[name].result, "skipped", `${event}/${mode}/${ref}: ${name}`);
  }
  const dryRun = release.jobs["release-final"].steps.find((step) => step.run?.includes("--mode stage-dry-run"));
  assert.ok(dryRun);
  assert.equal(graph(release, "workflow_dispatch", "certify").stepRuns(dryRun), true);
  assert.equal(graph(release, "push", "certify", "refs/tags/v0.1.0").stepRuns(dryRun), true);
});

test("main staging reuses certified bytes without rebuilding and a successful stage authorizes the draft", () => {
  const { results } = graph(release, "workflow_dispatch", "stage");
  assert.equal(results["release-recover"].result, "success");
  assert.equal(results["release-draft"].result, "success");
  for (const [name, result] of Object.entries(results)) {
    if (!mutationJobs.includes(name)) assert.equal(result.result, "skipped", `staging reached ${name}`);
  }
  assert.equal(
    graph(release, "workflow_dispatch", "stage", "refs/heads/main", "release-recover").results["release-draft"].result,
    "skipped",
  );
});

test("recovery bypasses the build and certification DAG without authorizing a draft", () => {
  const { results } = graph(release, "workflow_dispatch", "recover");
  assert.equal(results["release-recover"].result, "success");
  for (const [name, result] of Object.entries(results)) {
    if (name !== "release-recover") assert.equal(result.result, "skipped", `recovery reached ${name}`);
  }
  const failed = graph(release, "workflow_dispatch", "recover", "refs/heads/main", "release-recover").results;
  assert.equal(failed["release-draft"].result, "skipped");
  assert.deepEqual(dependencies(release.jobs["release-recover"]), []);
});

test("recovery rejects unauthorized inputs before checking out tools or downloading artifacts", () => {
  const recovery = release.jobs["release-recover"];
  const authorization = recovery.steps[0];
  assert.ok(authorization.run);
  const valid = {
    ...process.env,
    GITHUB_REF: "refs/heads/main",
    SQLBRAID_RELEASE_MODE: "recover",
    SQLBRAID_RECOVERY_RUN_ID: "37109603570",
    SQLBRAID_RECOVERY_TAG: "v1.0.2",
    SQLBRAID_REJECTED_STAGES_CONFIRMED: "true",
  };
  for (const patch of [
    { GITHUB_REF: "refs/tags/v1.0.2" },
    { GITHUB_REF: "refs/heads/recovery" },
    { SQLBRAID_RECOVERY_RUN_ID: "" },
    { SQLBRAID_RECOVERY_RUN_ID: "37109603570; echo unsafe" },
    { SQLBRAID_RECOVERY_TAG: "" },
    { SQLBRAID_RECOVERY_TAG: "refs/tags/v1.0.2" },
    { SQLBRAID_RECOVERY_TAG: "../v1.0.2" },
    { SQLBRAID_REJECTED_STAGES_CONFIRMED: "false" },
    { SQLBRAID_REJECTED_STAGES_CONFIRMED: "" },
  ]) {
    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", authorization.run], {
      env: { ...valid, ...patch },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, JSON.stringify(patch));
  }
  for (const tag of ["v1.0.2", "v1.0.2-rc.1", "postgres-v1.0.2"]) {
    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", authorization.run], {
      env: { ...valid, SQLBRAID_RECOVERY_TAG: tag },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("fresh main staging requires a certified producer and no recovery confirmation", () => {
  const authorization = release.jobs["release-recover"].steps[0];
  assert.ok(authorization.run);
  const valid = {
    ...process.env,
    GITHUB_REF: "refs/heads/main",
    SQLBRAID_RELEASE_MODE: "stage",
    INPUT_RELEASE_PACKAGE: "sqlbraid",
    SQLBRAID_RECOVERY_RUN_ID: "12345",
    SQLBRAID_RECOVERY_TAG: "v1.2.3",
    SQLBRAID_REJECTED_STAGES_CONFIRMED: "false",
  };
  for (const [patch, status] of [
    [{}, 0],
    [{ SQLBRAID_RECOVERY_TAG: "postgres-v1.2.3" }, 0],
    [{ GITHUB_REF: "refs/tags/v1.2.3" }, 1],
    [{ SQLBRAID_RECOVERY_RUN_ID: "" }, 1],
    [{ SQLBRAID_RECOVERY_TAG: "sqlbraid-v1.2.3" }, 1],
    [{ SQLBRAID_REJECTED_STAGES_CONFIRMED: "true" }, 1],
    [{ INPUT_RELEASE_PACKAGE: "all" }, 1],
    [{ INPUT_RELEASE_PACKAGE: "*" }, 1],
  ] as const) {
    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", authorization.run], {
      env: { ...valid, ...patch },
      encoding: "utf8",
    });
    assert.equal(result.status, status, result.stdout + result.stderr);
  }
});

test("recovery uses main tools and restores only original artifacts without repacking", () => {
  const recovery = release.jobs["release-recover"];
  assert.deepEqual(recovery.concurrency, {
    group: "npm-stage-refs/tags/${{ inputs.candidate_tag }}",
    "cancel-in-progress": false,
  });
  assert.deepEqual(recovery.env, {
    SQLBRAID_RECOVERY_TAG: "${{ inputs.candidate_tag }}",
    SQLBRAID_RECOVERY_RUN_ID: "${{ inputs.prior_run_id }}",
    SQLBRAID_REJECTED_STAGES_CONFIRMED: "${{ inputs.rejected_stages_confirmed }}",
  });
  const checkout = recovery.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkout?.with, { ref: "${{ github.sha }}", "fetch-depth": 0 });
  assert.ok(recovery.steps.some((step) => step.run === "pnpm install --frozen-lockfile"));
  const downloads = recovery.steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(
    downloads.map((step) => step.with?.name),
    ["release-candidate-validated", "release-staged-publication"],
  );
  for (const download of downloads) {
    assert.equal(download.with?.["run-id"], "${{ inputs.prior_run_id }}");
    assert.equal(download.with?.["github-token"], "${{ github.token }}");
    assert.equal(download.with?.repository, "${{ github.repository }}");
    assert.ok(String(download.with?.path).startsWith("${{ runner.temp }}/"));
  }
  const invocations = recovery.steps.filter((step) => step.run?.includes("node scripts/release-recovery.mjs"));
  assert.equal(invocations.length, 2);
  assert.match(invocations[0].run ?? "", /--mode preflight\b/u);
  assert.match(invocations[1].run ?? "", /--mode stage\b/u);
  assert.equal(invocations[0].env?.SQLBRAID_STAGE_PREFLIGHT_VERIFIED, undefined);
  assert.equal(invocations[1].env?.SQLBRAID_STAGE_PREFLIGHT_VERIFIED, "true");
  for (const step of invocations) {
    assert.match(step.run ?? "", /--artifact-dir "\$RUNNER_TEMP\/sqlbraid-release-artifacts"/u);
    assert.match(
      step.run ?? "",
      /--prior-staged-publication "\$RUNNER_TEMP\/prior-staged-evidence\/staged-publication\.json"/u,
    );
    assert.equal(step.env?.GITHUB_TOKEN, "${{ github.token }}");
  }
  for (const step of recovery.steps) {
    assert.equal(step.with?.["registry-url"], undefined);
    assert.doesNotMatch(step.run ?? "", /\b(?:build|pack|publish|approve|promote)\b|tar\s+-[a-z]*c|gh\s+release/u);
    assert.doesNotMatch(step.run ?? "", /(?:export\s+)?GITHUB_(?:SHA|REF(?:_NAME|_TYPE)?)=/u);
    for (const key of Object.keys(step.env ?? {})) assert.doesNotMatch(key, /^GITHUB_(?:SHA|REF)/u);
  }
  const uploads = recovery.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.deepEqual(
    uploads.map((step) => step.with?.name),
    ["release-staged-publication", "release-candidate-validated"],
  );
  for (const upload of uploads) {
    assert.equal(evaluate(upload.if, {}, {}, {}, {}, false), true, "failure must retain original bytes and evidence");
    assert.equal(upload.with?.["if-no-files-found"], "ignore");
  }
  assert.deepEqual(String(uploads[0].with?.path).trim().split("\n"), [
    "${{ runner.temp }}/sqlbraid-release-artifacts/staged-publication.json",
    "${{ runner.temp }}/sqlbraid-release-artifacts/release-manifest.json",
    "${{ runner.temp }}/sqlbraid-release-artifacts/recovery-evidence.json",
  ]);
  assert.equal(
    uploads[1].with?.path,
    `${String(downloads[0].with?.path)}/release-candidate-validated.tar.gz`,
    "retention must upload the original archive rather than re-archive mutated staging evidence",
  );
});

test("missing semantic evidence blocks certification even when database jobs pass", () => {
  for (const mode of ["certify", "pack-only"]) {
    const { results } = graph(release, "workflow_dispatch", mode, "refs/tags/v1.0.0", "release-semantic-contracts");
    assert.equal(results["release-db"].result, "success");
    assert.equal(results["release-common"].result, "success");
    assert.equal(results["release-final"].result, "skipped");
    assert.equal(results["release-recover"].result, "skipped");
    assert.equal(results["release-draft"].result, "skipped");
  }
});

test("full certification and mutation prerequisites include every npm release lane and pnpm stage dry-run", () => {
  const lanes = dependencies(release.jobs["release-final"]);
  for (const name of [
    "release-prep",
    "release-common",
    "release-db",
    "release-node24",
    "release-browser",
    "release-pack",
    "release-docs",
    "release-examples",
    "release-benchmark-smoke",
    "release-runtime",
    "release-compatibility",
    "release-bun-sql",
    "release-support-evidence",
    "release-target-evidence",
  ])
    assert.ok(lanes.includes(name), `missing ${name}`);
  assert.equal(release.jobs["release-vscode"], undefined);
  const dryRun = release.jobs["release-final"].steps.find((step) => step.run?.includes("--mode stage-dry-run"));
  assert.ok(dryRun);
  for (const mode of ["certify", "stage"])
    assert.equal(graph(release, "workflow_dispatch", mode, "refs/tags/v0.1.0-rc.0").stepRuns(dryRun), true);
  assert.equal(graph(release, "push", "certify", "refs/tags/v0.1.0-rc.0").stepRuns(dryRun), true);
  assert.equal(graph(release, "workflow_dispatch", "pack-only").stepRuns(dryRun), false);
  assert.ok(release.jobs["release-final"].steps.some((step) => step.run?.includes("--mode preflight")));
});

test("npm release preparation and evidence exclude VS Code artifacts", () => {
  const prep = release.jobs["release-prep"];
  assert.equal(prep.steps.find((step) => step.name === "Typecheck packages")?.run, "pnpm run typecheck:packages");
  assert.equal(prep.steps.find((step) => step.name === "Build packages once")?.run, "pnpm run build:packages");
  assert.doesNotMatch(
    prep.steps.find((step) => step.name === "Archive candidate and prepared build")?.run ?? "",
    /extensions\/vscode/u,
  );
  const packCheck = release.jobs["release-pack"].steps.find((step) => step.name === "Validate candidate package bytes");
  assert.equal(packCheck?.env?.SQLBRAID_SKIP_VSIX, "true");
  assert.equal(packCheck?.env?.SQLBRAID_VSIX_INPUT, undefined);
  assert.equal(packCheck?.env?.SQLBRAID_VSIX_OUTPUT, undefined);
  const draft = release.jobs["release-draft"].steps.find((step) => step.run?.includes("gh release create"))?.run ?? "";
  assert.doesNotMatch(draft, /\.vsix/u);
});

test("VS Code release packages one artifact and publishes the same VSIX to Open VSX with OIDC", () => {
  assert.deepEqual(vscode.permissions, { contents: "read" });
  assert.equal(vscode.on.workflow_dispatch?.inputs?.pre_release.default, true);
  assert.equal(vscode.on.workflow_dispatch?.inputs?.pre_release.type, "boolean");
  assert.deepEqual(vscode.concurrency, { group: "vscode-release-${{ github.ref }}", "cancel-in-progress": false });
  const pack = vscode.jobs.package;
  assert.ok(pack);
  assert.equal(pack.needs, undefined);
  const packageStep = pack.steps.find((step) => step.name === "Package and validate exact VSIX");
  assert.match(packageStep?.run ?? "", /scripts\/package-vscode\.mjs/u);
  assert.match(packageStep?.run ?? "", /--pre-release/u);
  assert.equal(packageStep?.env?.PRE_RELEASE, "${{ inputs.pre_release }}");
  const upload = pack.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload?.with?.name, "${{ steps.identity.outputs.artifact }}");
  assert.equal(upload?.with?.path, "${{ runner.temp }}/${{ steps.identity.outputs.filename }}");
  const openVsx = vscode.jobs["open-vsx"];
  assert.equal(openVsx.needs, "package");
  assert.deepEqual(openVsx.permissions, { contents: "read", "id-token": "write" });
  const download = openVsx.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download?.with?.name, "${{ needs.package.outputs.artifact }}");
  const publish = openVsx.steps.find((step) => step.name?.includes("trusted publishing"));
  assert.match(publish?.run ?? "", /ovsx@\$\{OVSX_VERSION\}/u);
  assert.match(publish?.run ?? "", /--trusted-publishing/u);
  assert.doesNotMatch(publish?.run ?? "", /--pre-release/u);
  assert.equal(publish?.env?.PRE_RELEASE, undefined);
  assert.equal(publish?.env?.VSIX, "${{ runner.temp }}/vsix/${{ needs.package.outputs.filename }}");
  const workflowText = readFileSync(new URL("../.github/workflows/vscode-release.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflowText, /secrets\.|VSCE_PAT|ovsx\s+publish\s+.*(?:--pat|-p\s)/u);
  assert.doesNotMatch(workflowText, /\bvsce\s+publish\b/u);
});

test("runtime workflows execute every exact packed compatibility cell", () => {
  const runtimeCompatibility = runtime.jobs.compatibility;
  assert.ok(runtimeCompatibility);
  assert.deepEqual(runtimeCompatibility.needs, ["plan", "prepare"]);
  assert.match(runtimeCompatibility.if ?? "", /needs\.plan\.outputs\.compatibility/u);
  assert.equal(
    runtimeCompatibility.steps.find((step) => step.name === "Run packed consumer smoke")?.run,
    "node scripts/runtime-compatibility-smoke.mjs",
  );
  const releaseCompatibility = release.jobs["release-compatibility"];
  assert.ok(releaseCompatibility);
  assert.equal(releaseCompatibility.needs, "release-prep");
  assert.match(
    releaseCompatibility.steps.find((step) => step.name === "Run packed consumer smoke")?.run ?? "",
    /runtime-compatibility-smoke\.mjs/u,
  );
  assert.match(String(release.jobs["release-prep"].outputs?.compatibility_matrix), /compatibility-matrix/u);
});

test("job capabilities isolate OIDC and release writes", () => {
  assert.deepEqual(release.permissions, { contents: "read" });
  assert.deepEqual(release.jobs["release-recover"].permissions, {
    contents: "read",
    actions: "read",
    "id-token": "write",
  });
  assert.deepEqual(release.jobs["release-draft"].permissions, { contents: "write", actions: "read" });
  for (const [name, job] of Object.entries(release.jobs)) {
    const permissions: Record<string, string> = job.permissions ?? release.permissions;
    if (name !== "release-recover") assert.notEqual(permissions["id-token"], "write");
    if (name !== "release-draft") assert.notEqual(permissions.contents, "write");
    for (const env of [release.env, job.env, ...(job.steps ?? []).map((step) => step.env)]) {
      for (const [key, value] of Object.entries(env ?? {})) {
        assert.doesNotMatch(key, /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_BOOTSTRAP_TOKEN)$/u);
        assert.doesNotMatch(value, /secrets\./u);
      }
    }
  }
  const stage = release.jobs["release-recover"];
  assert.ok(
    stage.steps.every((step) => step.with?.["registry-url"] === undefined),
    "setup-node must not inject fallback token configuration",
  );
  for (const job of Object.values(release.jobs)) {
    for (const step of job.steps ?? []) {
      assert.doesNotMatch(
        step.run ?? "",
        /\bnpm\s+(?:publish|install|i)\b/u,
        "release job must not publish or upgrade npm CLI",
      );
    }
  }
});

test("staging is serialized, reuses the validated candidate, and preserves partial evidence", () => {
  const stage = release.jobs["release-recover"];
  assert.deepEqual(stage.concurrency, {
    group: "npm-stage-refs/tags/${{ inputs.candidate_tag }}",
    "cancel-in-progress": false,
  });
  const download = stage.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download?.with?.name, "release-candidate-validated");
  assert.ok(stage.steps.some((step) => step.run?.includes("release-candidate-validated.tar.gz")));
  assert.ok(stage.steps.some((step) => step.name === "Mutate npm staging with pnpm OIDC"));
  assert.ok(stage.steps.every((step) => !/\bpnpm\s+(?:run\s+)?(?:build|pack)\b/u.test(step.run ?? "")));
  const evidence = stage.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(evidence?.if, "always()");
  assert.match(String(evidence?.with?.path), /staged-publication\.json/u);
  assert.match(String(evidence?.with?.path), /release-manifest\.json/u);
});

test("staging has no approval or direct publication path and draft release remains pending", () => {
  const stage = release.jobs["release-recover"];
  const stageRun = stage.steps.map((step) => step.run ?? "").join("\n");
  assert.doesNotMatch(stageRun, /--mode (?:publish|bootstrap|publish-dry-run)\b/u);
  assert.doesNotMatch(stageRun, /\bnpm\s+publish\b/u);
  assert.ok(!stage.steps.some((step) => /(?:approve|promote)/iu.test(`${step.name ?? ""}\n${step.run ?? ""}`)));
  const draft = release.jobs["release-draft"];
  assert.match(draft.name ?? "", /draft.*approval pending/iu);
  const create = draft.steps.find((step) => step.run?.includes("gh release create"));
  assert.ok(create?.run);
  const directory = mkdtempSync(join(tmpdir(), "sqlbraid-release-draft-"));
  try {
    mkdirSync(join(directory, "staged-evidence"));
    for (const version of ["1.2.3", "1.2.3-rc.1"]) {
      writeFileSync(join(directory, "staged-evidence", "release-manifest.json"), JSON.stringify({ version }));
      const tag = `postgres-v${version}`;
      const result: SpawnSyncReturns<string> = spawnSync(
        "bash",
        ["-e", "-c", `gh() { printf '%s\\n' "$@"; }\n${create.run}`],
        {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
          env: {
            ...process.env,
            RUNNER_TEMP: directory,
            SQLBRAID_RELEASE_PACKAGE: "sqlbraid",
            SQLBRAID_CANDIDATE_TAG: tag,
            GITHUB_REF_NAME: "main",
            GITHUB_REPOSITORY: "test/sqlbraid",
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), [
        "release",
        "create",
        tag,
        "--repo",
        "test/sqlbraid",
        "--draft",
        "--title",
        `SQLBraid ${tag}`,
        "--generate-notes",
        ...(version.includes("-") ? ["--prerelease"] : []),
        join(directory, "staged-evidence", "release-manifest.json"),
        join(directory, "staged-evidence", "staged-publication.json"),
        join(directory, "sqlbraid-release-artifacts", "release-evidence.json"),
      ]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(releasePrereleaseArg("0.1.0-rc.2"), "--prerelease");
  assert.equal(releasePrereleaseArg("0.1.0"), undefined);
  assert.match(draft.steps.find((step) => step.run?.includes("--mode durable-evidence"))?.run ?? "", /--artifact-dir/u);
});

test("fresh staging and recovery share tools but only recovery downloads prior staged evidence", () => {
  const stage = release.jobs["release-recover"];
  const prior = stage.steps.find((step) => step.with?.name === "release-staged-publication");
  assert.ok(prior);
  assert.equal(graph(release, "workflow_dispatch", "stage").stepRuns(prior), false);
  assert.equal(graph(release, "workflow_dispatch", "recover").stepRuns(prior), true);
  const invocations = stage.steps.filter((step) => step.run?.includes("node scripts/release-recovery.mjs"));
  for (const mode of ["stage", "recover"]) {
    for (const [index, step] of invocations.entries()) {
      const result = spawnSync("bash", ["-e", "-c", `node() { printf '%s\\n' "$@"; }\n${step.run}`], {
        encoding: "utf8",
        env: { ...process.env, SQLBRAID_RELEASE_MODE: mode, RUNNER_TEMP: "/candidate" },
      });
      assert.equal(result.status, 0, result.stderr);
      const args = result.stdout.trim().split("\n");
      assert.equal(args[0], "scripts/release-recovery.mjs");
      assert.equal(args[args.indexOf("--mode") + 1], index === 0 ? "preflight" : "stage");
      assert.equal(args.includes("--prior-staged-publication"), mode === "recover");
      assert.equal(args[args.indexOf("--artifact-dir") + 1], "/candidate/sqlbraid-release-artifacts");
    }
  }
  const draft = release.jobs["release-draft"];
  for (const name of ["support-profile-evidence", "release-target-evidence"]) {
    const download = draft.steps.find((step) => step.with?.name === name);
    assert.equal(download?.with?.["run-id"], "${{ inputs.prior_run_id }}");
  }
});

test("preparation executes facade and package-specific release selection", () => {
  const determine = release.jobs["release-prep"].steps.find((step) => step.name === "Determine release target");
  assert.ok(determine?.run);
  const directory = mkdtempSync(join(tmpdir(), "sqlbraid-release-target-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "9.9.9" }));
    for (const [slug, version] of [
      ["sqlbraid", "1.4.0"],
      ["postgres", "2.3.0"],
    ]) {
      mkdirSync(join(directory, "packages", slug), { recursive: true });
      writeFileSync(join(directory, "packages", slug, "package.json"), JSON.stringify({ version }));
    }
    for (const [ref, selector, expectedPackage, expectedVersion] of [
      ["v1.2.3", "sqlbraid", "sqlbraid", "1.2.3"],
      ["postgres-v1.2.3", "sqlbraid", "postgres", "1.2.3"],
      ["", String(release.on.workflow_dispatch?.inputs?.release_package?.default), "sqlbraid", "1.4.0"],
      ["", "postgres", "postgres", "2.3.0"],
      ["sqlbraid-v1.2.3", "sqlbraid", "", ""],
      ["", "all", "", ""],
      ["", "*", "", ""],
      ["v1.2.3", "all", "", ""],
      ["", "../sqlbraid", "", ""],
    ]) {
      const output = join(directory, "output");
      const environment = join(directory, "env");
      rmSync(output, { force: true });
      rmSync(environment, { force: true });
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", determine.run], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          INPUT_RELEASE_PACKAGE: selector,
          SQLBRAID_RELEASE_MODE: "certify",
          GITHUB_REF_TYPE: ref ? "tag" : "branch",
          GITHUB_REF_NAME: ref || "main",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_OUTPUT: output,
          GITHUB_ENV: environment,
        },
      });
      if (!expectedPackage) {
        assert.equal(result.status, 1, `${ref}/${selector}: ${result.stdout}`);
        continue;
      }
      assert.equal(result.status, 0, result.stderr);
      const version = expectedVersion;
      assert.equal(readFileSync(output, "utf8"), `package=${expectedPackage}\nversion=${version}\n`);
      assert.equal(
        readFileSync(environment, "utf8"),
        `SQLBRAID_RELEASE_PACKAGE=${expectedPackage}\nSQLBRAID_RELEASE_VERSION=${version}\n`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("documentation pushes publish latest and tagged docs while manual deployment remains opt-in", () => {
  assert.deepEqual(docs.permissions, { contents: "read" });
  assert.equal(docs.on.push?.paths, undefined);
  for (const ref of ["refs/heads/main", "refs/tags/v0.1.0-rc.0"]) {
    const { results } = graph(docs, "push", "certify", ref);
    assert.equal(results.build.result, "success");
    assert.equal(results["publish-history"].result, "success");
    assert.equal(results.deploy.result, "success");
  }
  const manual = graph(docs, "workflow_dispatch", "certify", "refs/heads/main").results;
  assert.equal(manual.build.result, "success");
  assert.equal(manual["publish-history"].result, "skipped");
  assert.equal(manual.deploy.result, "skipped");
  const authorized = graph(docs, "workflow_dispatch", "certify", "refs/heads/main", undefined, true).results;
  assert.equal(authorized.build.result, "success");
  assert.equal(authorized["publish-history"].result, "success");
  assert.equal(authorized.deploy.result, "success");
  assert.equal(
    graph(docs, "workflow_dispatch", "certify", "refs/heads/main", "build", true).results.deploy.result,
    "skipped",
  );
  assert.deepEqual(docs.jobs.build.permissions, { contents: "read" });
});

test("runtime manual and tag events retain full fail-open coverage", () => {
  assert.ok("workflow_dispatch" in runtime.on);
  assert.deepEqual(planChanges([], { eventName: "workflow_dispatch", baseKnown: false }), allPlan());
  assert.deepEqual(planChanges([], { eventName: "push", baseKnown: true }), allPlan());
  assert.notDeepEqual(planChanges(["README.md"], { eventName: "pull_request", baseKnown: true }), allPlan());
  for (const path of [
    "scripts/certification.mjs",
    "vitest.certification.config.ts",
    "tests/scripts/bun-sql-certification.mjs",
  ]) {
    assert.deepEqual(planChanges([path], { eventName: "pull_request", baseKnown: true }), allPlan());
  }
});
