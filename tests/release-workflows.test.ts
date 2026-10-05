import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertNoPriorStageAttempt,
  assertReleaseWorkflows,
  requiredReleaseWorkflows,
  successfulExactRun,
} from "../scripts/assert-release-workflows.mjs";

const sha = "a".repeat(40);
const ref = "refs/tags/v0.1.0-rc.0";
const workflow = requiredReleaseWorkflows[0];
const exact = {
  id: 42,
  head_sha: sha,
  head_branch: "v0.1.0-rc.0",
  path: workflow,
  status: "completed",
  conclusion: "success",
  event: "push",
};
const context = { sha, ref, workflow };

test("release evidence accepts completed successful exact tag revision only", () => {
  assert.equal(successfulExactRun([exact], context), exact);
  for (const change of [
    { head_sha: "b".repeat(40) },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { status: "in_progress", conclusion: null },
    { status: "queued", conclusion: null },
    { conclusion: "skipped" },
    { head_branch: "main" },
    { head_branch: "v0.1.0-rc.1" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { path: requiredReleaseWorkflows[1] },
  ])
    assert.equal(successfulExactRun([{ ...exact, ...change }], context), undefined);
  assert.equal(successfulExactRun([], context), undefined);
  // oxlint-disable-next-line no-map-spread -- Each historical run must be a separate object without changing the shared exact-match fixture.
  const history = ["b", "c", "d"].map((character) => ({ ...exact, head_sha: character.repeat(40) }));
  assert.equal(successfulExactRun(history, context), undefined);
  assert.equal(successfulExactRun([...history, { ...exact, conclusion: "failure" }, exact], context), exact);
});

const env = { GITHUB_SHA: sha, GITHUB_REF: ref, GITHUB_REPOSITORY: "Clickin/SQLBraid", GITHUB_TOKEN: "test-token" };

test("publication requires both exact workflow successes, not one or incomplete evidence", async () => {
  for (const missing of requiredReleaseWorkflows) {
    // oxlint-disable-next-line no-await-in-loop -- Complete each missing-workflow failure before exercising the next evidence case.
    await assert.rejects(
      assertReleaseWorkflows(env, async (url) => {
        const path = requiredReleaseWorkflows.find((value) => url.pathname.includes(value.split("/").at(-1)!))!;
        return Response.json({ workflow_runs: path === missing ? [] : [{ ...exact, path }] });
      }),
      /No completed successful/,
    );
  }
  const evidence = await assertReleaseWorkflows(env, async (url) => {
    const path = requiredReleaseWorkflows.find((value) => url.pathname.includes(value.split("/").at(-1)!))!;
    assert.equal(url.searchParams.get("head_sha"), sha);
    return Response.json({ workflow_runs: [{ ...exact, path }] });
  });
  assert.deepEqual(
    evidence.map((entry) => entry.workflow),
    requiredReleaseWorkflows,
  );
});

test("package-specific tags require exact runtime portability evidence without a docs tag deployment", async () => {
  const packageRef = "refs/tags/postgres-v1.2.3";
  const packageEnv = { ...env, GITHUB_REF: packageRef };
  const packageExact = { ...exact, head_branch: "postgres-v1.2.3", path: requiredReleaseWorkflows[0] };
  let calls = 0;
  const evidence = await assertReleaseWorkflows(packageEnv, async (url) => {
    calls += 1;
    assert.ok(url.pathname.includes("runtime-portability.yml"));
    return Response.json({ workflow_runs: [packageExact] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    evidence.map((entry) => entry.workflow),
    [requiredReleaseWorkflows[0]],
  );
});

test("workflow verification fails closed on API errors and malformed responses", async () => {
  await assert.rejects(
    assertReleaseWorkflows(env, async () => new Response(null, { status: 403 })),
    /HTTP 403/,
  );
  await assert.rejects(
    assertReleaseWorkflows(env, async () => Response.json({})),
    /Invalid GitHub/,
  );
  await assert.rejects(assertReleaseWorkflows({ ...env, GITHUB_REF: "refs/heads/main" }), /requires an exact tag/);
});

test("workflow verification checks later result pages without polling unfinished runs", async () => {
  let calls = 0;
  const evidence = await assertReleaseWorkflows(env, async (url) => {
    calls += 1;
    const path = requiredReleaseWorkflows.find((value) => url.pathname.includes(value.split("/").at(-1)!))!;
    return Response.json({
      workflow_runs:
        url.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, () => ({ ...exact, path, conclusion: "failure" }))
          : [{ ...exact, path }],
    });
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

test("staging rejects a prior npm mutation but ignores a preflight-only failure", async () => {
  const priorRun = { id: 111, head_sha: sha, head_branch: "v0.1.0-rc.0", event: "workflow_dispatch" };
  const mutationJob = {
    name: "Stage validated packages with pnpm OIDC",
    status: "completed",
    conclusion: "failure",
    steps: [
      { name: "Verify npm staging preconditions", status: "completed", conclusion: "success" },
      { name: "Mutate npm staging with pnpm OIDC", status: "completed", conclusion: "failure" },
    ],
  };
  const calls: string[] = [];
  const request = async (url: URL) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith("/runs")) return Response.json({ workflow_runs: [priorRun] });
    if (url.pathname.endsWith("/jobs")) return Response.json({ jobs: [mutationJob] });
    throw new Error(`Unexpected URL ${url}`);
  };
  await assert.rejects(assertNoPriorStageAttempt(stageHistoryEnv, request), /Prior npm staging mutation/);
  assert.deepEqual(calls, [
    "/repos/Clickin/SQLBraid/actions/workflows/release.yml/runs",
    "/repos/Clickin/SQLBraid/actions/runs/111/jobs",
  ]);
  await assert.doesNotReject(
    assertNoPriorStageAttempt(stageHistoryEnv, async (url) => {
      if (url.pathname.endsWith("/runs")) return Response.json({ workflow_runs: [priorRun] });
      return Response.json({
        jobs: [
          {
            ...mutationJob,
            steps: [
              { name: "Verify npm staging preconditions", status: "completed", conclusion: "failure" },
              { name: "Mutate npm staging with pnpm OIDC", status: "completed", conclusion: "skipped" },
            ],
          },
        ],
      });
    }),
  );
});

test("staging rejects a rerun with no prior evidence before querying history", async () => {
  await assert.rejects(
    assertNoPriorStageAttempt({ ...stageHistoryEnv, GITHUB_RUN_ATTEMPT: "2" }, async () => {
      throw new Error("history should not be queried");
    }),
    /rerun requires explicit prior staged evidence/,
  );
});

test("staging history fails closed on API errors and treats skipped stage jobs as certification-only", async () => {
  await assert.rejects(
    assertNoPriorStageAttempt(stageHistoryEnv, async () => new Response(null, { status: 403 })),
    /history verification failed/,
  );
  await assert.doesNotReject(
    assertNoPriorStageAttempt(stageHistoryEnv, async (url) => {
      if (url.pathname.endsWith("/runs"))
        return Response.json({
          workflow_runs: [{ id: 111, head_sha: sha, head_branch: "v0.1.0-rc.0", event: "workflow_dispatch" }],
        });
      return Response.json({
        jobs: [
          {
            name: "Stage validated packages with pnpm OIDC",
            status: "completed",
            conclusion: "skipped",
            steps: [{ name: "Mutate npm staging with pnpm OIDC", status: "completed", conclusion: "skipped" }],
          },
        ],
      });
    }),
  );
});

test("the sqlbraid-v alias never authorizes release workflow gates", async () => {
  await assert.rejects(
    assertReleaseWorkflows({ ...env, GITHUB_REF: "refs/tags/sqlbraid-v1.2.3" }, async () => {
      throw new Error("Alias must be rejected before fetching evidence.");
    }),
    /requires an exact tag/,
  );
});

test.each(["Stage", "Recover"])("history rejects a prior main %s mutation across tooling SHAs", async (kind) => {
  await assert.rejects(
    assertNoPriorStageAttempt(stageHistoryEnv, async (url) => {
      if (url.pathname.endsWith("/runs")) {
        assert.equal(url.searchParams.has("head_sha"), false);
        return Response.json({
          workflow_runs: [
            {
              id: 111,
              head_sha: "b".repeat(40),
              head_branch: "main",
              display_title: "Release v0.1.0-rc.0",
              event: "workflow_dispatch",
              status: "completed",
            },
          ],
        });
      }
      return Response.json({
        jobs: [
          {
            name: `${kind} validated packages with pnpm OIDC`,
            steps: [{ name: "Mutate npm staging with pnpm OIDC", status: "completed", conclusion: "failure" }],
          },
        ],
      });
    }),
    /Prior npm staging mutation/,
  );
});

test("history blocks an unresolved same-candidate main run but ignores another candidate", async () => {
  const priorRun = {
    id: 111,
    head_sha: "b".repeat(40),
    head_branch: "main",
    display_title: "Release v0.1.0-rc.0",
    event: "workflow_dispatch",
    status: "in_progress",
  };
  await assert.rejects(
    assertNoPriorStageAttempt(stageHistoryEnv, async () => Response.json({ workflow_runs: [priorRun] })),
    /unresolved/,
  );
  priorRun.display_title = "Release core-v1.2.3";
  await assert.doesNotReject(
    assertNoPriorStageAttempt(stageHistoryEnv, async () => Response.json({ workflow_runs: [priorRun] })),
  );
});

const legacyRun = {
  id: 37266867709,
  head_sha: "b".repeat(40),
  head_branch: "main",
  display_title: "Release",
  event: "workflow_dispatch",
  status: "completed",
  run_attempt: 1,
};
const legacyHistory = async (url: URL) =>
  url.pathname.endsWith("/runs")
    ? Response.json({ workflow_runs: [legacyRun] })
    : Response.json({
        jobs: [
          {
            name: "Recover validated packages with pnpm OIDC",
            steps: [{ name: "Mutate npm staging with pnpm OIDC", status: "completed", conclusion: "success" }],
          },
        ],
      });
const legacyEvidence = () => ({
  tool: {
    repository: env.GITHUB_REPOSITORY,
    sha: legacyRun.head_sha,
    ref: "refs/heads/main",
    runId: String(legacyRun.id),
    runAttempt: "1",
  },
  candidate: { ref: "refs/tags/v1.0.2", sha },
  rejectedStagesConfirmed: true,
});

test.each(["v1.0.3", "postgres-v1.0.3"])("legacy v1.0.2 recovery does not block %s", async (tag) => {
  await assert.doesNotReject(
    assertNoPriorStageAttempt({ ...stageHistoryEnv, GITHUB_REF: `refs/tags/${tag}` }, legacyHistory, async () =>
      legacyEvidence(),
    ),
  );
});

test("legacy recovery still blocks its own candidate and rejects unverified evidence", async () => {
  await assert.rejects(
    assertNoPriorStageAttempt({ ...stageHistoryEnv, GITHUB_REF: "refs/tags/v1.0.2" }, legacyHistory, async () =>
      legacyEvidence(),
    ),
    /Prior npm staging mutation/,
  );
  await assert.rejects(
    assertNoPriorStageAttempt(stageHistoryEnv, legacyHistory, async () => {
      const evidence = legacyEvidence();
      evidence.tool.runId = "999";
      return evidence;
    }),
    /candidate evidence/,
  );
  await assert.rejects(
    assertNoPriorStageAttempt(stageHistoryEnv, legacyHistory, async () => {
      throw new Error("Artifact expired");
    }),
    /Artifact expired/,
  );
});
