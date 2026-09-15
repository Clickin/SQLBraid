import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertNoPriorStageAttempt, assertReleaseWorkflows, requiredReleaseWorkflows, successfulExactRun,
} from "../scripts/assert-release-workflows.mjs";

const sha = "a".repeat(40);
const ref = "refs/tags/v0.1.0-rc.0";
const workflow = requiredReleaseWorkflows[0];
const exact = { id: 42, head_sha: sha, head_branch: "v0.1.0-rc.0", path: workflow, status: "completed", conclusion: "success", event: "push" };
const context = { sha, ref, workflow };

test("release evidence accepts completed successful exact tag revision only", () => {
  assert.equal(successfulExactRun([exact], context), exact);
  for (const change of [
    { head_sha: "b".repeat(40) }, { conclusion: "failure" }, { conclusion: "cancelled" },
    { status: "in_progress", conclusion: null }, { status: "queued", conclusion: null },
    { conclusion: "skipped" }, { head_branch: "main" }, { head_branch: "v0.1.0-rc.1" },
    { event: "pull_request" }, { event: "workflow_dispatch" }, { path: requiredReleaseWorkflows[1] },
  ]) assert.equal(successfulExactRun([{ ...exact, ...change }], context), undefined);
  assert.equal(successfulExactRun([], context), undefined);
  const history = ["b", "c", "d"].map((character) => ({ ...exact, head_sha: character.repeat(40) }));
  assert.equal(successfulExactRun(history, context), undefined);
  assert.equal(successfulExactRun([...history, { ...exact, conclusion: "failure" }, exact], context), exact);
});

const env = { GITHUB_SHA: sha, GITHUB_REF: ref, GITHUB_REPOSITORY: "Clickin/SQLBraid", GITHUB_TOKEN: "test-token" };

test("publication requires both exact workflow successes, not one or incomplete evidence", async () => {
  for (const missing of requiredReleaseWorkflows) {
    await assert.rejects(assertReleaseWorkflows(env, async (url) => {
      const path = requiredReleaseWorkflows.find((value) => url.pathname.includes(value.split("/").at(-1)!))!;
      return Response.json({ workflow_runs: path === missing ? [] : [{ ...exact, path }] });
    }), /No completed successful/);
  }
  const evidence = await assertReleaseWorkflows(env, async (url) => {
    const path = requiredReleaseWorkflows.find((value) => url.pathname.includes(value.split("/").at(-1)!))!;
    assert.equal(url.searchParams.get("head_sha"), sha);
    return Response.json({ workflow_runs: [{ ...exact, path }] });
  });
  assert.deepEqual(evidence.map((entry) => entry.workflow), requiredReleaseWorkflows);
});

test("workflow verification fails closed on API errors and malformed responses", async () => {
  await assert.rejects(assertReleaseWorkflows(env, async () => new Response(null, { status: 403 })), /HTTP 403/);
  await assert.rejects(assertReleaseWorkflows(env, async () => Response.json({})), /Invalid GitHub/);
  await assert.rejects(assertReleaseWorkflows({ ...env, GITHUB_REF: "refs/heads/main" }), /requires an exact tag/);
});

test("workflow verification checks later result pages without polling unfinished runs", async () => {
  let calls = 0;
  const evidence = await assertReleaseWorkflows(env, async (url) => {
    calls += 1;
    const path = requiredReleaseWorkflows.find((value) => url.pathname.includes(value.split("/").at(-1)!))!;
    return Response.json({ workflow_runs: url.searchParams.get("page") === "1"
      ? Array.from({ length: 100 }, () => ({ ...exact, path, conclusion: "failure" })) : [{ ...exact, path }] });
  });
  assert.equal(calls, 4);
  assert.equal(evidence.length, 2);
});

const stageHistoryEnv = {
  GITHUB_SHA: sha,
  GITHUB_REF: ref,
  GITHUB_REPOSITORY: "Clickin/SQLBraid",
  GITHUB_TOKEN: "test-token",
  GITHUB_RUN_ID: "999",
  GITHUB_RUN_ATTEMPT: "1",
};

test("staging rejects any prior same-candidate stage attempt unless explicit evidence is supplied", async () => {
  const priorRun = { id: 111, head_sha: sha, head_branch: "v0.1.0-rc.0", event: "workflow_dispatch" };
  const calls: string[] = [];
  const request = async (url: URL) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith("/runs")) return Response.json({ workflow_runs: [priorRun] });
    if (url.pathname.endsWith("/jobs")) return Response.json({
      jobs: [{ name: "Stage validated packages with pnpm OIDC", status: "completed", conclusion: "failure" }],
    });
    throw new Error(`Unexpected URL ${url}`);
  };
  await assert.rejects(assertNoPriorStageAttempt(stageHistoryEnv, request), /Prior staging attempt/);
  assert.deepEqual(calls, ["/repos/Clickin/SQLBraid/actions/workflows/release.yml/runs", "/repos/Clickin/SQLBraid/actions/runs/111/jobs"]);
  await assert.doesNotReject(assertNoPriorStageAttempt({ ...stageHistoryEnv, GITHUB_RUN_ATTEMPT: "2" }, request, { allowReconciliation: true }));
});

test("staging rejects a rerun with no prior evidence before querying history", async () => {
  await assert.rejects(assertNoPriorStageAttempt({ ...stageHistoryEnv, GITHUB_RUN_ATTEMPT: "2" }, async () => {
    throw new Error("history should not be queried");
  }), /rerun requires explicit prior staged evidence/);
});

test("staging history fails closed on API errors and treats skipped stage jobs as certification-only", async () => {
  await assert.rejects(assertNoPriorStageAttempt(stageHistoryEnv, async () => new Response(null, { status: 403 })), /history verification failed/);
  await assert.doesNotReject(assertNoPriorStageAttempt(stageHistoryEnv, async (url) => {
    if (url.pathname.endsWith("/runs")) return Response.json({ workflow_runs: [{ id: 111, head_sha: sha, head_branch: "v0.1.0-rc.0", event: "workflow_dispatch" }] });
    return Response.json({ jobs: [{ name: "Stage validated packages with pnpm OIDC", status: "completed", conclusion: "skipped" }] });
  }));
});
