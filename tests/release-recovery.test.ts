import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { recoverRelease } from "../scripts/release-recovery.mjs";
import { setReleasePackage, setReleaseVersion } from "../scripts/release.mjs";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  setReleasePackage("sqlbraid");
  setReleaseVersion("0.1.0-rc.0");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fixture(names = ["@sqlbraid/core"], version = "1.0.2") {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-recovery-test-"));
  directories.push(directory);
  const candidateSha = "a".repeat(40);
  const toolSha = "b".repeat(40);
  const bytes = Buffer.from("original validated archive bytes");
  const entry = {
    name: names[0],
    version,
    file: "package-0.tgz",
    dependencies: [],
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  const manifest = {
    version: entry.version,
    releasePackages: names,
    commit: candidateSha,
    runId: "123",
    runAttempt: "1",
    packages: names.map((name, index) => (index === 0 ? entry : { ...entry, name, file: `package-${index}.tgz` })),
  };
  const report = {
    format: "sqlbraid-staged-publication",
    mode: "fresh",
    version: manifest.version,
    commit: candidateSha,
    runId: "123",
    runAttempt: "1",
    candidateRunId: "123",
    candidateRunAttempt: "1",
    manifestSha256: digest(manifest),
    candidateIdentitySha256: digest({
      version: manifest.version,
      releasePackages: manifest.releasePackages,
      commit: candidateSha,
      packages: manifest.packages,
    }),
    latestBefore: Object.fromEntries(names.map((name) => [name, { latest: "0.9.0" }])),
    complete: false,
    packages: manifest.packages.map((item) => ({
      name: item.name,
      version: item.version,
      candidateSha256: item.sha256,
      candidateIntegrity: item.integrity,
      tag: "latest",
      state: "pending",
    })),
    approvalCommands: [],
  };
  const stamp = {
    version: manifest.version,
    commit: manifest.commit,
    packages: manifest.packages.map(({ name, sha256 }) => ({ name, sha256 })),
  };
  const priorStagedPublication = join(directory, "prior.json");
  const save = async () => {
    await writeFile(join(directory, "release-manifest.json"), JSON.stringify(manifest));
    await writeFile(priorStagedPublication, JSON.stringify(report));
    await writeFile(join(directory, "pack-check-success.json"), JSON.stringify(stamp));
  };
  await Promise.all(manifest.packages.map((item) => writeFile(join(directory, item.file), bytes)));
  await save();
  const env: Record<string, string> = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: toolSha,
    GITHUB_REPOSITORY: "owner/sqlbraid",
    GITHUB_TOKEN: "fixture-token",
    GITHUB_RUN_ID: "456",
    GITHUB_RUN_ATTEMPT: "1",
    SQLBRAID_RELEASE_MODE: "recover",
    SQLBRAID_RECOVERY_RUN_ID: "123",
    SQLBRAID_RECOVERY_TAG: `v${version}`,
    SQLBRAID_REJECTED_STAGES_CONFIRMED: "true",
    SQLBRAID_STAGE_PREFLIGHT_VERIFIED: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.example/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
    NODE_AUTH_TOKEN: "",
    NPM_TOKEN: "",
    NPM_BOOTSTRAP_TOKEN: "",
    NPM_ID_TOKEN: "",
    GITHUB_STEP_SUMMARY: "",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const run = {
    id: 123,
    run_attempt: 1,
    repository: { full_name: env.GITHUB_REPOSITORY },
    head_repository: { full_name: env.GITHUB_REPOSITORY },
    path: ".github/workflows/release.yml",
    head_sha: candidateSha,
    head_branch: `v${version}`,
    status: "completed",
    conclusion: "failure",
    event: "workflow_dispatch",
  };
  const jobs = [
    {
      name: "Final release certification",
      run_id: 123,
      head_sha: candidateSha,
      status: "completed",
      conclusion: "success",
      steps: [],
    },
    {
      name: "Stage validated packages with pnpm OIDC",
      run_id: 123,
      head_sha: candidateSha,
      status: "completed",
      conclusion: "failure",
      steps: [{ name: "Mutate npm staging with pnpm OIDC", status: "completed", conclusion: "failure" }],
    },
  ];
  const behavior = {
    tag: candidateSha,
    head: toolSha,
    dirty: "",
    packedName: entry.name,
    packedDependencies: {},
    failUpload: false,
    gateBranch: `v${version}`,
  };
  const commands: string[][] = [];
  const requests: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    let body;
    if (url.endsWith("/runs/123")) body = run;
    else if (url.includes("/runs/123/attempts/1/jobs")) body = { jobs };
    else if (url.includes("/actions/workflows/release.yml/runs")) body = { workflow_runs: [] };
    else if (url.includes("/actions/workflows/")) {
      const workflow = url.includes("runtime-portability") ? "runtime-portability.yml" : "docs-pages.yml";
      assert.ok(url.includes(`head_sha=${candidateSha}`));
      body = {
        workflow_runs: [
          {
            id: 99,
            head_sha: candidateSha,
            head_branch: behavior.gateBranch,
            path: `.github/workflows/${workflow}`,
            status: "completed",
            conclusion: "success",
            event: "push",
          },
        ],
      };
    } else throw new Error(`Unexpected API request ${url}`);
    return new Response(JSON.stringify(body));
  };
  const command = async (file: string, args: readonly string[]) => {
    commands.push([file, ...args]);
    if (file === "git") {
      if (args[0] === "status") return behavior.dirty;
      if (args[1] === "HEAD") return behavior.head;
      assert.deepEqual(args, ["rev-parse", "--verify", `refs/tags/${env.SQLBRAID_RECOVERY_TAG}^{commit}`]);
      return behavior.tag;
    }
    if (file === "tar") {
      const packed = manifest.packages.find((item) => args[1] === join(directory, item.file))!;
      if (args[0] === "-xOf")
        return JSON.stringify({
          name: packed === entry ? behavior.packedName : packed.name,
          version: entry.version,
          dependencies: behavior.packedDependencies,
        });
      if (args[0] === "-tf") return "package/package.json\npackage/README.md\npackage/LICENSE\n";
    }
    if (file === "pnpm") {
      if (args[0] === "--version") return "12.3.4";
      if (args[0] === "config") return "https://registry.npmjs.org/";
      if (args[0] === "ping") return "";
      if (args[0] === "view") {
        if (args[2] === "versions") return JSON.stringify(["0.9.0"]);
        if (args[2] === "dist-tags") return JSON.stringify({ latest: "0.9.0" });
        if (args[2] === "dist.integrity" || args[2] === "version") return "null";
      }
      if (args[0] === "stage" && args[1] === "publish") {
        const staged = manifest.packages.find((item) => args[2] === join(directory, item.file));
        assert.ok(staged);
        assert.deepEqual(await readFile(args[2]), bytes);
        if (behavior.failUpload) throw new Error("upload interrupted");
        return JSON.stringify({
          [staged.name]: {
            name: staged.name,
            version: staged.version,
            integrity: staged.integrity,
            stageId: "00000000-0000-0000-0000-000000000001",
          },
        });
      }
    }
    throw new Error(`Unexpected command ${file} ${args.join(" ")}`);
  };
  const recover = (mode: "preflight" | "stage" = "preflight") =>
    recoverRelease({
      mode,
      artifactDir: directory,
      priorStagedPublication: env.SQLBRAID_RELEASE_MODE === "recover" ? priorStagedPublication : undefined,
      env,
      request,
      command,
    });
  const uploads = () => commands.filter(([file, cmd]) => file === "pnpm" && cmd === "stage");
  return {
    directory,
    manifest,
    report,
    stamp,
    save,
    env,
    run,
    jobs,
    behavior,
    requests,
    commands,
    recover,
    uploads,
    bytes,
    entry,
    request,
    command,
    priorStagedPublication,
  };
}

test("recovery preflight verifies original failed stage run and exact tag gates without npm commands", async () => {
  const f = await fixture();
  const evidence = await f.recover();
  assert.ok(evidence && "candidate" in evidence);
  assert.equal(evidence.tool.sha, f.env.GITHUB_SHA);
  assert.equal(evidence.candidate.sha, f.manifest.commit);
  assert.equal(
    f.commands.some(([file]) => file === "pnpm"),
    false,
  );
  assert.equal(f.requests.filter((url) => url.includes("/actions/workflows/")).length, 2);
  assert.equal(process.env.GITHUB_SHA, f.env.GITHUB_SHA);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
});

test.each([
  ["wrong main ref", "GITHUB_REF", "refs/tags/v1.0.2"],
  ["wrong event", "GITHUB_EVENT_NAME", "push"],
  ["not Actions", "GITHUB_ACTIONS", "false"],
  ["wrong mode", "SQLBRAID_RELEASE_MODE", "certify"],
  ["missing rejection", "SQLBRAID_REJECTED_STAGES_CONFIRMED", "false"],
  ["invalid SHA", "GITHUB_SHA", "abc"],
  ["invalid run", "GITHUB_RUN_ID", "0"],
  ["invalid attempt", "GITHUB_RUN_ATTEMPT", "zero"],
  ["invalid repository", "GITHUB_REPOSITORY", "owner/repo/extra"],
  ["missing token", "GITHUB_TOKEN", ""],
  ["invalid prior ID", "SQLBRAID_RECOVERY_RUN_ID", "../123"],
  ["invalid tag", "SQLBRAID_RECOVERY_TAG", "v1.02.0"],
  ["missing stage preflight", "SQLBRAID_STAGE_PREFLIGHT_VERIFIED", "false"],
])("recovery rejects %s before upload", async (_name, key, value) => {
  const f = await fixture();
  f.env[key] = value;
  await assert.rejects(f.recover("stage"));
  assert.equal(f.uploads().length, 0);
});

test.each([
  "tag",
  "head",
  "dirty",
  "artifact",
  "integrity",
  "stamp",
  "packed identity",
  "dependencies",
  "report digest",
  "report run",
  "report attempt",
  "candidate run",
  "candidate attempt",
  "API repository",
  "API workflow",
  "API SHA",
  "API tag",
  "API attempt",
  "API status",
  "certification",
  "skipped certification",
  "certification identity",
  "mutation",
  "missing mutation",
  "tag gates",
])("recovery rejects tampered %s before upload", async (kind) => {
  const f = await fixture();
  switch (kind) {
    case "tag":
      f.behavior.tag = "c".repeat(40);
      break;
    case "head":
      f.behavior.head = "c".repeat(40);
      break;
    case "dirty":
      f.behavior.dirty = " M package.json";
      break;
    case "artifact":
      await writeFile(join(f.directory, f.entry.file), "tampered");
      break;
    case "integrity":
      f.entry.integrity = `sha512-${"A".repeat(86)}==`;
      break;
    case "stamp":
      f.stamp.commit = "c".repeat(40);
      break;
    case "packed identity":
      f.behavior.packedName = "@sqlbraid/other";
      break;
    case "dependencies":
      f.behavior.packedDependencies = { "@sqlbraid/core": "1.0.2" };
      break;
    case "report digest":
      f.report.manifestSha256 = "c".repeat(64);
      break;
    case "report run":
      f.report.runId = "999";
      break;
    case "report attempt":
      f.report.runAttempt = "2";
      break;
    case "candidate run":
      f.manifest.runId = "999";
      f.report.manifestSha256 = digest(f.manifest);
      break;
    case "candidate attempt":
      f.manifest.runAttempt = "2";
      f.report.manifestSha256 = digest(f.manifest);
      break;
    case "API repository":
      f.run.repository.full_name = "evil/sqlbraid";
      break;
    case "API workflow":
      f.run.path = ".github/workflows/other.yml";
      break;
    case "API SHA":
      f.run.head_sha = "c".repeat(40);
      break;
    case "API tag":
      f.run.head_branch = "main";
      break;
    case "API attempt":
      f.run.run_attempt = 2;
      break;
    case "API status":
      f.run.status = "in_progress";
      break;
    case "certification":
      f.jobs[0].conclusion = "failure";
      break;
    case "skipped certification":
      f.jobs[0].conclusion = "skipped";
      break;
    case "certification identity":
      f.jobs[0].head_sha = "c".repeat(40);
      break;
    case "mutation":
      f.jobs[1].steps[0].conclusion = "skipped";
      break;
    case "missing mutation":
      f.jobs[1].steps = [];
      break;
    case "tag gates":
      f.behavior.gateBranch = "main";
      break;
  }
  await f.save();
  await assert.rejects(f.recover("stage"));
  assert.equal(f.uploads().length, 0);
});

test("successful recovery preserves candidate bytes and original provenance while recording current tool identity", async () => {
  const f = await fixture();
  const before = await readFile(join(f.directory, "release-manifest.json"));
  const evidence = await f.recover("stage");
  assert.ok(evidence && "recovery" in evidence);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.commit, f.manifest.commit);
  assert.equal(evidence.runId, f.env.GITHUB_RUN_ID);
  assert.equal(evidence.candidateRunId, f.manifest.runId);
  assert.equal(evidence.recovery.tool.sha, f.env.GITHUB_SHA);
  assert.equal(evidence.recovery.tool.ref, "refs/heads/main");
  assert.equal(evidence.recovery.candidate.sha, f.manifest.commit);
  assert.equal(evidence.rejectedStagesConfirmation?.confirmed, true);
  assert.equal(f.uploads().length, 1);
  assert.deepEqual(await readFile(join(f.directory, f.entry.file)), f.bytes);
  assert.deepEqual(await readFile(join(f.directory, "release-manifest.json")), before);
  assert.equal(process.env.GITHUB_SHA, f.env.GITHUB_SHA);
});

test("failed recovery retains tool/candidate identity, rejection attestation, and durable pending evidence", async () => {
  const f = await fixture();
  f.behavior.failUpload = true;
  await assert.rejects(f.recover("stage"), /Staging outcome unresolved/);
  const report = JSON.parse(await readFile(join(f.directory, "staged-publication.json"), "utf8"));
  const recovery = JSON.parse(await readFile(join(f.directory, "recovery-evidence.json"), "utf8"));
  assert.deepEqual(report.recovery, recovery);
  assert.equal(recovery.tool.sha, f.env.GITHUB_SHA);
  assert.equal(recovery.candidate.sha, f.manifest.commit);
  assert.equal(recovery.rejectedStagesConfirmed, true);
  assert.equal(report.rejectedStagesConfirmation.confirmed, true);
  assert.equal(report.packages[0].state, "pending");
  assert.equal(report.complete, false);
});

test("a later recovery binds the prior main tool run separately from the original candidate producer", async () => {
  const f = await fixture();
  await f.recover("stage");
  const prior = await readFile(join(f.directory, "staged-publication.json"));
  await writeFile(f.priorStagedPublication, prior);
  await rm(join(f.directory, "staged-publication.json"));
  f.env.SQLBRAID_RECOVERY_RUN_ID = "456";
  f.env.GITHUB_RUN_ID = "789";
  f.env.GITHUB_SHA = "c".repeat(40);
  f.behavior.head = f.env.GITHUB_SHA;
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/runs/456"))
      return new Response(JSON.stringify({ ...f.run, id: 456, head_sha: "b".repeat(40), head_branch: "main" }));
    if (url.includes("/runs/456/attempts/1/jobs"))
      return new Response(
        JSON.stringify({
          jobs: [
            { ...f.jobs[1], name: "Recover validated packages with pnpm OIDC", run_id: 456, head_sha: "b".repeat(40) },
          ],
        }),
      );
    return f.request(input, init);
  };
  const evidence = await recoverRelease({
    mode: "stage",
    artifactDir: f.directory,
    priorStagedPublication: f.priorStagedPublication,
    env: f.env,
    command: f.command,
    request,
  });
  assert.ok(evidence && "recovery" in evidence);
  assert.equal(evidence.recovery.tool.sha, "c".repeat(40));
  assert.equal(evidence.recovery.candidate.sha, "a".repeat(40));
  assert.equal(evidence.candidateRunId, "123");
  assert.equal(evidence.reconciledFrom?.runId, "456");
});

test("recovery preserves its identity evidence when registry prechecks fail before staging starts", async () => {
  const f = await fixture();
  await assert.rejects(
    recoverRelease({
      mode: "stage",
      artifactDir: f.directory,
      priorStagedPublication: f.priorStagedPublication,
      env: f.env,
      request: f.request,
      command: async (file, args) => {
        if (file === "pnpm") throw new Error("registry precheck failed");
        return f.command(file, args);
      },
    }),
    /registry precheck failed/,
  );
  const recovery = JSON.parse(await readFile(join(f.directory, "recovery-evidence.json"), "utf8"));
  assert.equal(recovery.tool.sha, f.env.GITHUB_SHA);
  assert.equal(recovery.candidate.sha, f.manifest.commit);
  assert.equal(recovery.rejectedStagesConfirmed, true);
  assert.equal(f.uploads().length, 0);
});

test("recovery rejects forged prior main-tool provenance before any further upload", async () => {
  const f = await fixture();
  await f.recover("stage");
  const report = JSON.parse(await readFile(join(f.directory, "staged-publication.json"), "utf8"));
  report.recovery.tool.runId = "999";
  await writeFile(f.priorStagedPublication, JSON.stringify(report));
  await rm(join(f.directory, "staged-publication.json"));
  f.env.SQLBRAID_RECOVERY_RUN_ID = "456";
  f.env.GITHUB_RUN_ID = "789";
  const uploadsBefore = f.uploads().length;
  await assert.rejects(f.recover("stage"), /mismatched tool or candidate provenance/);
  assert.equal(f.uploads().length, uploadsBefore);
});

test.each(["1.0.0", "1.0.2", "2.3.4"])(
  "coordinated recovery trusts original selected artifacts and provenance at %s",
  async (version) => {
    const f = await fixture(["@sqlbraid/core", "sqlbraid"], version);
    const evidence = await f.recover("stage");
    assert.ok(evidence && "packages" in evidence);
    assert.deepEqual(
      evidence.packages.map(({ name }) => name),
      ["@sqlbraid/core", "sqlbraid"],
    );
    assert.equal(f.uploads().length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, "release-manifest.json"), "utf8")), f.manifest);
  },
);

test.each(["sqlbraid", "@sqlbraid/core"])("fresh main staging uploads only the certified %s artifact", async (name) => {
  const f = await fixture([name], "2.3.4");
  f.env.SQLBRAID_RELEASE_MODE = "stage";
  f.env.SQLBRAID_REJECTED_STAGES_CONFIRMED = "false";
  f.env.SQLBRAID_RECOVERY_TAG = name === "sqlbraid" ? "v2.3.4" : "core-v2.3.4";
  f.run.head_branch = f.env.SQLBRAID_RECOVERY_TAG;
  f.run.event = "push";
  f.run.conclusion = "success";
  f.behavior.gateBranch = f.env.SQLBRAID_RECOVERY_TAG;
  f.jobs.splice(1);
  await f.recover();
  assert.equal(f.uploads().length, 0);
  const evidence = await f.recover("stage");
  assert.ok(evidence && "packages" in evidence);
  assert.equal(evidence.mode, "fresh");
  assert.equal(evidence.tool?.sha, f.env.GITHUB_SHA);
  assert.equal(evidence.commit, f.manifest.commit);
  assert.equal(evidence.candidateRunId, "123");
  assert.equal(evidence.rejectedStagesConfirmation, undefined);
  assert.deepEqual(
    evidence.packages.map((item) => item.name),
    [name],
  );
  assert.equal(f.uploads().length, 1);
  assert.deepEqual(await readFile(join(f.directory, f.entry.file)), f.bytes);
});

test.each<[string, string[]]>([
  ["v1.0.2", ["@sqlbraid/core", "sqlbraid"]],
  ["v1.0.2", ["@sqlbraid/core"]],
  ["sqlbraid-v1.0.2", ["sqlbraid"]],
  ["core-v1.0.2", ["sqlbraid"]],
])("fresh staging rejects mismatched or noncanonical candidate %s / %s", async (tag, names) => {
  const f = await fixture(names);
  f.env.SQLBRAID_RELEASE_MODE = "stage";
  f.env.SQLBRAID_REJECTED_STAGES_CONFIRMED = "false";
  f.env.SQLBRAID_RECOVERY_TAG = tag;
  await assert.rejects(f.recover("stage"), /canonical|selected release package/);
  assert.equal(f.uploads().length, 0);
});

test("fresh staging requires the producer run, not an unrelated artifact download run", async () => {
  const f = await fixture(["sqlbraid"]);
  f.env.SQLBRAID_RELEASE_MODE = "stage";
  f.env.SQLBRAID_REJECTED_STAGES_CONFIRMED = "false";
  f.env.SQLBRAID_RECOVERY_RUN_ID = "999";
  await assert.rejects(f.recover("stage"), /original certified candidate producer/);
  assert.equal(f.uploads().length, 0);
});

test("recovery of a failed fresh main stage retains original producer and validates staging tool provenance", async () => {
  const f = await fixture(["sqlbraid"]);
  f.env.SQLBRAID_RELEASE_MODE = "stage";
  f.env.SQLBRAID_REJECTED_STAGES_CONFIRMED = "false";
  f.behavior.failUpload = true;
  await assert.rejects(f.recover("stage"), /outcome unresolved/);
  const prior = await readFile(join(f.directory, "staged-publication.json"));
  await writeFile(f.priorStagedPublication, prior);
  await rm(join(f.directory, "staged-publication.json"));
  f.env.SQLBRAID_RELEASE_MODE = "recover";
  f.env.SQLBRAID_REJECTED_STAGES_CONFIRMED = "true";
  f.env.SQLBRAID_RECOVERY_RUN_ID = "456";
  f.env.GITHUB_RUN_ID = "789";
  f.behavior.failUpload = false;
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/runs/456"))
      return new Response(JSON.stringify({ ...f.run, id: 456, head_sha: f.env.GITHUB_SHA, head_branch: "main" }));
    if (url.includes("/runs/456/attempts/1/jobs"))
      return new Response(JSON.stringify({ jobs: [{ ...f.jobs[1], run_id: 456, head_sha: f.env.GITHUB_SHA }] }));
    return f.request(input, init);
  };
  const evidence = await recoverRelease({
    mode: "stage",
    artifactDir: f.directory,
    priorStagedPublication: f.priorStagedPublication,
    env: f.env,
    command: f.command,
    request,
  });
  assert.ok(evidence && "recovery" in evidence);
  assert.equal(evidence.candidateRunId, "123");
  assert.equal(evidence.reconciledFrom?.runId, "456");
  assert.equal(evidence.rejectedStagesConfirmation?.confirmed, true);
});
