import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredReleaseWorkflows = [
  ".github/workflows/runtime-portability.yml",
  ".github/workflows/docs-pages.yml",
];
const releaseWorkflow = ".github/workflows/release.yml";

export function successfulExactRun(runs, { sha, ref, workflow }) {
  const branch = ref.replace(/^refs\/(?:heads|tags)\//u, "");
  return runs.find(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === branch &&
      run.path === workflow &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.event === "push",
  );
}

export async function assertReleaseWorkflows(env = process.env, request = fetch) {
  const { GITHUB_SHA: sha, GITHUB_REF: ref, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = env;
  if (
    !/^[a-f\d]{40}$/u.test(sha ?? "") ||
    !ref?.startsWith("refs/tags/v") ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") ||
    !token
  ) {
    throw new Error("Release workflow verification requires an exact tag SHA, repository, and GITHUB_TOKEN.");
  }
  const evidence = [];
  for (const workflow of requiredReleaseWorkflows) {
    let match;
    // GitHub caps filtered workflow-run searches at 1,000 results. Never wait for a run to finish.
    for (let page = 1; page <= 10; page += 1) {
      const url = new URL(
        `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow.split("/").at(-1))}/runs`,
      );
      url.search = new URLSearchParams({
        head_sha: sha,
        per_page: "100",
        page: String(page),
        exclude_pull_requests: "true",
      }).toString();
      const response = await request(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(`GitHub workflow verification failed for ${workflow}: HTTP ${response.status}.`);
      const body = await response.json();
      if (!Array.isArray(body.workflow_runs)) throw new Error(`Invalid GitHub workflow response for ${workflow}.`);
      match = successfulExactRun(body.workflow_runs, { sha, ref, workflow });
      if (match || body.workflow_runs.length < 100) break;
    }
    if (!match)
      throw new Error(
        `No completed successful ${workflow} run for exact ${ref} at ${sha}; finish certification and dispatch again.`,
      );
    evidence.push({ workflow, runId: match.id, sha, ref });
  }
  return evidence;
}

export async function assertNoPriorStageAttempt(
  env = process.env,
  request = fetch,
  { allowReconciliation = false } = {},
) {
  const {
    GITHUB_SHA: sha,
    GITHUB_REF: ref,
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: token,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: runAttempt,
    GITHUB_API_URL: apiUrl = "https://api.github.com",
  } = env;
  if (allowReconciliation) return [];
  if (runAttempt !== "1") {
    throw new Error("Release staging rerun requires explicit prior staged evidence for reconciliation.");
  }
  if (
    !/^[a-f\d]{40}$/u.test(sha ?? "") ||
    !ref?.startsWith("refs/tags/v") ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") ||
    !/^\d+$/u.test(runId ?? "") ||
    !token
  ) {
    throw new Error("Prior release staging history requires an exact tag SHA, repository, run ID, and GITHUB_TOKEN.");
  }
  const branch = ref.replace(/^refs\/(?:heads|tags)\//u, "");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const getJson = async (url) => {
    const response = await request(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Release staging history verification failed: HTTP ${response.status}.`);
    return response.json();
  };
  const priorRuns = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(`${apiUrl}/repos/${repository}/actions/workflows/${releaseWorkflow.split("/").at(-1)}/runs`);
    url.search = new URLSearchParams({
      head_sha: sha,
      event: "workflow_dispatch",
      per_page: "100",
      page: String(page),
      exclude_pull_requests: "true",
    }).toString();
    const body = await getJson(url);
    if (!Array.isArray(body.workflow_runs)) throw new Error("Invalid GitHub release staging history response.");
    priorRuns.push(...body.workflow_runs);
    if (body.workflow_runs.length < 100) break;
    if (page === 10) throw new Error("Unable to bound GitHub release staging history; refusing an unverified upload.");
  }
  for (const run of priorRuns) {
    if (
      String(run.id) === runId ||
      run.head_sha !== sha ||
      run.head_branch !== branch ||
      run.event !== "workflow_dispatch"
    )
      continue;
    if (!/^\d+$/u.test(String(run.id))) throw new Error("Invalid GitHub release run identity.");
    const jobsUrl = new URL(`${apiUrl}/repos/${repository}/actions/runs/${run.id}/jobs`);
    jobsUrl.search = new URLSearchParams({ per_page: "100", page: "1" }).toString();
    let stage;
    for (let page = 1; page <= 10; page += 1) {
      jobsUrl.searchParams.set("page", String(page));
      const jobs = await getJson(jobsUrl);
      if (!Array.isArray(jobs.jobs)) throw new Error("Invalid GitHub release job history response.");
      stage = jobs.jobs.find((job) => /^Stage validated packages with pnpm OIDC(?:\s|$)/u.test(job.name ?? ""));
      if (stage || jobs.jobs.length < 100) break;
      if (page === 10) throw new Error("Unable to bound GitHub release job history; refusing an unverified upload.");
    }
    if (stage && (stage.status !== "completed" || stage.conclusion !== "skipped")) {
      throw new Error(
        `Prior staging attempt ${run.id} exists for ${ref}; supply its staged evidence for explicit reconciliation instead of uploading again.`,
      );
    }
  }
  return [];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await assertReleaseWorkflows()
    .then((evidence) => console.log(JSON.stringify(evidence, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
