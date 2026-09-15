import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredReleaseWorkflows = [
  ".github/workflows/runtime-portability.yml",
  ".github/workflows/docs-pages.yml",
];

export function successfulExactRun(runs, { sha, ref, workflow }) {
  const branch = ref.replace(/^refs\/(?:heads|tags)\//u, "");
  return runs.find((run) => run.head_sha === sha && run.head_branch === branch
    && run.path === workflow && run.status === "completed" && run.conclusion === "success"
    && run.event === "push");
}

export async function assertReleaseWorkflows(env = process.env, request = fetch) {
  const { GITHUB_SHA: sha, GITHUB_REF: ref, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = env;
  if (!/^[a-f\d]{40}$/u.test(sha ?? "") || !ref?.startsWith("refs/tags/v")
    || !/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !token) {
    throw new Error("Release workflow verification requires an exact tag SHA, repository, and GITHUB_TOKEN.");
  }
  const evidence = [];
  for (const workflow of requiredReleaseWorkflows) {
    let match;
    // GitHub caps filtered workflow-run searches at 1,000 results. Never wait for a run to finish.
    for (let page = 1; page <= 10; page += 1) {
      const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow.split("/").at(-1))}/runs`);
      url.search = new URLSearchParams({ head_sha: sha, per_page: "100", page: String(page), exclude_pull_requests: "true" }).toString();
      const response = await request(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`GitHub workflow verification failed for ${workflow}: HTTP ${response.status}.`);
      const body = await response.json();
      if (!Array.isArray(body.workflow_runs)) throw new Error(`Invalid GitHub workflow response for ${workflow}.`);
      match = successfulExactRun(body.workflow_runs, { sha, ref, workflow });
      if (match || body.workflow_runs.length < 100) break;
    }
    if (!match) throw new Error(`No completed successful ${workflow} run for exact ${ref} at ${sha}; finish certification and dispatch again.`);
    evidence.push({ workflow, runId: match.id, sha, ref });
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await assertReleaseWorkflows().then((evidence) => console.log(JSON.stringify(evidence, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
