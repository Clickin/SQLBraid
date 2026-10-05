import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertReleaseWorkflows } from "./assert-release-workflows.mjs";
import { formatReleaseError } from "./release-diagnostics.mjs";
import {
  assertPriorStagingEvidence,
  assertPublicationCredentials,
  parseSemver,
  readReleaseManifest,
  releaseCandidateTag,
  setReleaseCommand,
  setReleasePackage,
  setReleaseVersion,
  stageCandidates,
} from "./release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const defaultCommand = async (file, args) => (await execFileAsync(file, args, { cwd: root })).stdout;
const positiveId = (value) => typeof value === "string" && /^[1-9]\d*$/u.test(value);
const shaPattern = /^[a-f\d]{40}$/u;
const releaseWorkflow = ".github/workflows/release.yml";
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

export async function recoverRelease({
  mode,
  artifactDir,
  priorStagedPublication,
  env = process.env,
  request = fetch,
  command = defaultCommand,
}) {
  if (!["preflight", "stage"].includes(mode)) throw new Error("Recovery requires preflight or stage mode.");
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.SQLBRAID_RELEASE_MODE !== "recover"
  )
    throw new Error(
      "Recovery is allowed only from GitHub Actions workflow_dispatch on refs/heads/main with release_mode=recover.",
    );
  if (
    !shaPattern.test(env.GITHUB_SHA ?? "") ||
    !positiveId(env.GITHUB_RUN_ID) ||
    !positiveId(env.GITHUB_RUN_ATTEMPT) ||
    !/^[\w.-]+\/[\w.-]+$/u.test(env.GITHUB_REPOSITORY ?? "") ||
    !env.GITHUB_TOKEN ||
    !positiveId(env.SQLBRAID_RECOVERY_RUN_ID) ||
    env.SQLBRAID_RECOVERY_RUN_ID === env.GITHUB_RUN_ID
  )
    throw new Error(
      "Recovery requires exact tool SHA, run ID, attempt, repository, token, and a different numeric prior run ID.",
    );
  if (env.SQLBRAID_REJECTED_STAGES_CONFIRMED !== "true")
    throw new Error("Recovery requires explicit rejected-stage confirmation.");
  const tag = env.SQLBRAID_RECOVERY_TAG;
  const tagMatch = /^(?:([a-z0-9][a-z0-9._-]*)-)?v(.+)$/u.exec(tag ?? "");
  if (!tagMatch) throw new Error("Recovery requires a versioned candidate tag.");
  parseSemver(tagMatch[2]);
  if (!artifactDir || !priorStagedPublication)
    throw new Error("Recovery requires --artifact-dir and --prior-staged-publication.");
  if (mode === "stage") {
    assertPublicationCredentials("stage", env);
    if (env.SQLBRAID_STAGE_PREFLIGHT_VERIFIED !== "true")
      throw new Error("Recovery stage requires successful preflight in the same official workflow job.");
  }
  if ((await command("git", ["status", "--porcelain", "--untracked-files=all"])).trim())
    throw new Error("Recovery requires a clean git tree.");
  if ((await command("git", ["rev-parse", "HEAD"])).trim() !== env.GITHUB_SHA)
    throw new Error("Recovery tool checkout HEAD does not equal GITHUB_SHA.");
  const candidateSha = (await command("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`])).trim();
  if (!shaPattern.test(candidateSha)) throw new Error("Recovery candidate tag does not resolve to a commit.");

  const directory = resolve(artifactDir);
  const restored = await json(join(directory, "release-manifest.json"));
  parseSemver(restored.version);
  setReleaseVersion(restored.version);
  setReleasePackage(tagMatch[1] ?? "*");
  if (releaseCandidateTag(tagMatch[1] ?? "*", restored.version) !== tag)
    throw new Error("Recovery candidate tag does not match the restored manifest version.");
  if (command !== defaultCommand) setReleaseCommand(command);
  const manifest = await readReleaseManifest(directory, { priorCandidateRunId: env.SQLBRAID_RECOVERY_RUN_ID });
  if (manifest.commit !== candidateSha)
    throw new Error("Recovery candidate tag does not match the immutable manifest commit.");
  if (!positiveId(manifest.runId) || !positiveId(manifest.runAttempt))
    throw new Error("Recovery manifest requires original candidate run provenance.");
  if (
    tagMatch[1] &&
    (manifest.releasePackages.length !== 1 ||
      releaseCandidateTag(manifest.releasePackages[0], manifest.version) !== tag)
  )
    throw new Error("Recovery candidate tag does not match the selected release package.");
  const priorEvidence = await json(resolve(priorStagedPublication));
  assertPriorStagingEvidence(manifest, priorEvidence, env.SQLBRAID_RECOVERY_RUN_ID);
  if (!positiveId(priorEvidence.runId) || !positiveId(priorEvidence.runAttempt))
    throw new Error("Recovery report requires an exact prior run and attempt.");

  const get = async (path) => {
    const response = await request(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/${path}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Recovery GitHub evidence request failed: HTTP ${response.status}.`);
    return response.json();
  };
  const verifyRun = async (runId, attempt, sha, ref) => {
    const run = await get(`runs/${runId}`);
    if (
      String(run.id) !== runId ||
      String(run.run_attempt) !== attempt ||
      run.repository?.full_name !== env.GITHUB_REPOSITORY ||
      run.head_repository?.full_name !== env.GITHUB_REPOSITORY ||
      run.path !== releaseWorkflow ||
      run.head_sha !== sha ||
      run.head_branch !== ref.replace(/^refs\/(?:heads|tags)\//u, "") ||
      run.status !== "completed" ||
      !["push", "workflow_dispatch"].includes(run.event)
    )
      throw new Error("Recovery run evidence does not match its repository, workflow, SHA, ref, or attempt.");
    return run;
  };
  const jobsFor = async (runId, attempt) => {
    const jobs = [];
    for (let page = 1; page <= 10; page += 1) {
      const body = await get(`runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
      if (!Array.isArray(body.jobs)) throw new Error("Invalid recovery GitHub job evidence.");
      jobs.push(...body.jobs);
      if (body.jobs.length < 100) return jobs;
    }
    throw new Error("Unable to bound recovery job evidence; refusing an unverified upload.");
  };
  const candidateRef = `refs/tags/${tag}`;
  await verifyRun(manifest.runId, manifest.runAttempt, candidateSha, candidateRef);
  const candidateJobs = await jobsFor(manifest.runId, manifest.runAttempt);
  if (
    !candidateJobs.some(
      (job) =>
        job.name === "Final release certification" &&
        String(job.run_id) === manifest.runId &&
        job.head_sha === candidateSha &&
        job.status === "completed" &&
        job.conclusion === "success",
    )
  )
    throw new Error(
      "Recovery requires successful Final release certification for the original candidate run and attempt.",
    );

  let priorSha = candidateSha;
  let priorRef = candidateRef;
  if (priorEvidence.recovery) {
    const { tool, candidate, rejectedStagesConfirmed } = priorEvidence.recovery;
    if (
      tool?.repository !== env.GITHUB_REPOSITORY ||
      tool.ref !== "refs/heads/main" ||
      !shaPattern.test(tool.sha ?? "") ||
      tool.runId !== priorEvidence.runId ||
      tool.runAttempt !== priorEvidence.runAttempt ||
      rejectedStagesConfirmed !== true ||
      candidate?.sha !== candidateSha ||
      candidate.ref !== candidateRef ||
      candidate.runId !== manifest.runId ||
      candidate.runAttempt !== manifest.runAttempt
    )
      throw new Error("Recovery prior report has mismatched tool or candidate provenance.");
    priorSha = tool.sha;
    priorRef = tool.ref;
  }
  const priorRun = await verifyRun(priorEvidence.runId, priorEvidence.runAttempt, priorSha, priorRef);
  if (priorRun.event !== "workflow_dispatch") throw new Error("Recovery requires a prior dispatched mutation attempt.");
  const priorJobs =
    priorEvidence.runId === manifest.runId && priorEvidence.runAttempt === manifest.runAttempt
      ? candidateJobs
      : await jobsFor(priorEvidence.runId, priorEvidence.runAttempt);
  const priorJobName = priorEvidence.recovery
    ? "Recover validated packages with pnpm OIDC"
    : "Stage validated packages with pnpm OIDC";
  if (
    !priorJobs.some(
      (job) =>
        job.name === priorJobName &&
        String(job.run_id) === priorEvidence.runId &&
        job.head_sha === priorSha &&
        job.status === "completed" &&
        Array.isArray(job.steps) &&
        job.steps.some(
          (step) =>
            step.name === "Mutate npm staging with pnpm OIDC" &&
            step.status === "completed" &&
            ["success", "failure", "cancelled", "timed_out"].includes(step.conclusion),
        ),
    )
  )
    throw new Error("Recovery requires evidence of a previous npm mutation attempt.");

  // Candidate gates use their own identity; never replace the main tool process environment.
  const workflows = await assertReleaseWorkflows(
    { ...env, GITHUB_SHA: candidateSha, GITHUB_REF: candidateRef },
    request,
  );
  const recovery = {
    tool: {
      repository: env.GITHUB_REPOSITORY,
      sha: env.GITHUB_SHA,
      ref: env.GITHUB_REF,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
    },
    candidate: { sha: candidateSha, ref: candidateRef, runId: manifest.runId, runAttempt: manifest.runAttempt },
    priorRunId: priorEvidence.runId,
    priorRunAttempt: priorEvidence.runAttempt,
    rejectedStagesConfirmed: true,
    workflows,
  };
  // Keep the attestation and both identities even if credentials/registry checks fail before staging persists.
  await writeFile(join(directory, "recovery-evidence.json"), `${JSON.stringify(recovery, null, 2)}\n`);
  if (mode === "preflight") return recovery;
  return stageCandidates(manifest, {
    directory,
    priorEvidence: { ...priorEvidence, recovery },
    priorRunId: env.SQLBRAID_RECOVERY_RUN_ID,
    rejectedStagesConfirmed: true,
    currentRunId: env.GITHUB_RUN_ID,
    currentRunAttempt: env.GITHUB_RUN_ATTEMPT,
  });
}

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await recoverRelease({
    mode: option("--mode"),
    artifactDir: option("--artifact-dir"),
    priorStagedPublication: option("--prior-staged-publication"),
  }).catch((error) => {
    console.error(formatReleaseError(error));
    process.exitCode = 1;
  });
}
