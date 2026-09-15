import assert from "node:assert/strict";
import { test } from "vitest";
import { assertReleaseWorkflows, requiredReleaseWorkflows, successfulExactRun } from "../scripts/assert-release-workflows.mjs";

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
