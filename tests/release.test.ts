import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test, vi } from "vitest";
import {
  assertManifestOrder,
  assertMutationAuthorization,
  assertPublicationCredentials,
  assertTaggedSha,
  createReleaseEvidence,
  stageCandidates,
  verifyPublished,
  parseSemver,
  readReleaseManifest,
  setReleaseCommand,
  setReleasePackage,
  setReleaseVersion,
  type ReleaseManifest,
  type StagedPublication,
} from "../scripts/release.mjs";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const uuid = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
afterEach(async () => {
  vi.unstubAllEnvs();
  setReleasePackage("*");
  setReleaseVersion("0.1.0-rc.0");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(version = "0.1.0-rc.0", names = ["@sqlbraid/core"], releaseNames = names) {
  setReleaseVersion(version);
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://oidc.actions.example/token");
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "actions-fixture");
  for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_BOOTSTRAP_TOKEN", "NPM_ID_TOKEN"]) vi.stubEnv(key, "");
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-stage-test-"));
  directories.push(directory);
  const bytes = new Map(names.map((name) => [name, Buffer.from(`validated archive: ${name}`)]));
  const manifest: ReleaseManifest = {
    version,
    releasePackages: releaseNames,
    commit: "a".repeat(40),
    runId: "123",
    runAttempt: "1",
    packages: names.map((name, index) => ({
      name,
      version,
      file: `package-${index}.tgz`,
      sha256: createHash("sha256").update(bytes.get(name)!).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes.get(name)!).digest("base64")}`,
      dependencies: names.slice(0, index),
    })),
  };
  for (const entry of manifest.packages) await writeFile(join(directory, entry.file), bytes.get(entry.name)!);
  const publicIntegrity = new Map<string, string>();
  const tags = new Map(names.map((name) => [name, { latest: "0.0.9" } as Record<string, string>]));
  const calls: string[][] = [];
  const behavior = {
    failAfterUpload: false,
    failBeforeUpload: false,
    invalidSummary: false,
    provenance: true,
    changeLatest: false,
    advanceNext: false,
    failPackage: "",
    packageNotFound: false,
    exactVersionNotFound: false,
  };
  let stagedCount = 0;
  setReleaseCommand(async (file, args) => {
    assert.equal(file, "pnpm");
    calls.push([...args]);
    if (args[0] === "--version") return "12.3.4";
    if (args[0] === "config") return "https://registry.npmjs.org/";
    if (args[0] === "ping") return "";
    if (args[0] === "view") {
      if (
        behavior.packageNotFound ||
        (behavior.exactVersionNotFound && (args[2] === "dist.integrity" || args[2] === "version"))
      ) {
        throw Object.assign(new Error(`No matching version found for ${args[1]}`), {
          code: "ERR_PNPM_PACKAGE_NOT_FOUND",
        });
      }
      const name = names.find((name) => args[1] === name || args[1] === `${name}@${version}`)!;
      if (args[2] === "dist-tags") return JSON.stringify(tags.get(name));
      if (args[2] === "versions") return JSON.stringify(["0.0.0-bootstrap.0"]);
      if (args[2] === "dist.integrity") return JSON.stringify(publicIntegrity.get(name) ?? null);
      if (args[2] === "version") return JSON.stringify(publicIntegrity.has(name) ? version : null);
      if (args[2] === "dist.attestations")
        return JSON.stringify(
          behavior.provenance
            ? {
                url: "https://registry.npmjs.org/-/npm/v1/attestations/fixture",
                provenance: { predicateType: "https://slsa.dev/provenance/v1" },
              }
            : null,
        );
    }
    if (args[0] === "stage" && args[1] === "publish") {
      const entry = manifest.packages.find(({ file }) => args[2] === join(directory, file));
      assert.ok(entry, "only immutable tarball paths may be staged");
      assert.deepEqual(await readFile(args[2]), bytes.get(entry.name));
      if (behavior.failBeforeUpload || behavior.failPackage === entry.name) throw new Error("upload interrupted");
      const summary = { name: entry.name, version, integrity: entry.integrity };
      if (args.includes("--dry-run")) return JSON.stringify({ [entry.name]: summary });
      stagedCount += 1;
      if (behavior.changeLatest) tags.get(entry.name)!.latest = version;
      if (behavior.advanceNext) tags.get(entry.name)!.next = "0.1.0-rc.1";
      if (behavior.failAfterUpload) throw new Error("connection lost after upload");
      return behavior.invalidSummary
        ? "truncated JSON"
        : JSON.stringify({ [entry.name]: { ...summary, stageId: uuid(stagedCount) } });
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  });
  const run = (dryRun = false) => stageCandidates(manifest, { directory, dryRun });
  const evidence = async (): Promise<StagedPublication> =>
    JSON.parse(await readFile(join(directory, "staged-publication.json"), "utf8"));
  const uploads = () =>
    calls.filter((args) => args[0] === "stage" && args[1] === "publish" && !args.includes("--dry-run"));
  return { manifest, directory, publicIntegrity, tags, calls, behavior, run, evidence, uploads };
}

test("pnpm missing exact-version errors are treated as a new version of an existing package", async () => {
  const f = await fixture();
  f.behavior.exactVersionNotFound = true;
  const result = await f.run();
  assert.ok(result?.complete);
  assert.equal(f.uploads().length, 1);
});

test("staging fails before upload when the npm package itself has never been bootstrapped", async () => {
  const f = await fixture();
  f.behavior.packageNotFound = true;
  await assert.rejects(f.run(), /does not exist on npm.*bootstrap version/iu);
  assert.equal(f.uploads().length, 0);
});

test("staging records exact candidate IDs, requests provenance and next, and never changes latest", async () => {
  const f = await fixture();
  vi.stubEnv("GITHUB_STEP_SUMMARY", join(f.directory, "summary"));
  const result = await f.run();
  assert.ok(result?.complete);
  assert.equal(result.packages[0].stageId, uuid(1));
  assert.equal(result.packages[0].candidateSha256, f.manifest.packages[0].sha256);
  assert.equal(result.packages[0].candidateIntegrity, f.manifest.packages[0].integrity);
  assert.equal(f.tags.get("@sqlbraid/core")!.latest, "0.0.9");
  const [args] = f.uploads();
  for (const flag of ["--provenance", "--ignore-scripts", "--no-git-checks", "--json", "--reporter=silent"])
    assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--tag") + 1], "next");
  assert.equal(args[args.indexOf("--access") + 1], "public");
  assert.equal(args[args.indexOf("--npmrc-auth-file") + 1], "/dev/null");
  assert.equal(
    f.calls.some(([cmd]) => ["publish", "dist-tag", "pack"].includes(cmd)),
    false,
  );
  assert.deepEqual(
    f.calls.filter(([cmd]) => cmd === "stage").map(([, subcommand]) => subcommand),
    ["publish"],
  );
  const summary = await readFile(join(f.directory, "summary"), "utf8");
  assert.match(summary, /human approval required/);
  assert.ok(summary.includes(uuid(1)));
  assert.doesNotMatch(summary, /ephemeral-fixture|github-fixture|actions-fixture/);
});

test("certification exercises exact tarball staged dry-run with no registry reads or uploads", async () => {
  const f = await fixture();
  await f.run(true);
  assert.equal(f.uploads().length, 0);
  assert.equal(
    f.calls.some(([command]) => command === "view"),
    false,
  );
  assert.equal(f.calls.filter(([cmd]) => cmd === "stage").length, 1);
  setReleaseCommand(async () => "12.3.3");
  await assert.rejects(f.run(true), /requires pnpm/);
});

test("package-specific staging validates the full candidate but uploads only the selected package", async () => {
  const f = await fixture("1.0.1", ["@sqlbraid/core", "@sqlbraid/postgres"], ["@sqlbraid/postgres"]);
  f.publicIntegrity.set("@sqlbraid/core", f.manifest.packages[0].integrity);
  const result = await f.run();
  assert.ok(result?.complete);
  assert.deepEqual(
    result?.packages.map(({ name }) => name),
    ["@sqlbraid/postgres"],
  );
  assert.equal(f.uploads().length, 1);
  assert.match(f.uploads()[0][2], /package-1\.tgz$/u);
  assert.equal(result?.packages[0].tag, "release-1.0.1");
});

test("package-specific staging refuses an unpublished internal dependency", async () => {
  const f = await fixture("1.0.1", ["@sqlbraid/core", "@sqlbraid/postgres"], ["@sqlbraid/postgres"]);
  await assert.rejects(f.run(), /Release dependency @sqlbraid\/core@1\.0\.1 .* is not public/u);
  assert.equal(f.uploads().length, 0);
});

test("uncertain uploads retain pending evidence and never retry blindly", async () => {
  for (const flag of ["failAfterUpload", "invalidSummary"] as const) {
    const f = await fixture();
    f.behavior[flag] = true;
    await assert.rejects(f.run(), /outcome unresolved/);
    assert.equal(f.uploads().length, 1);
    const report = await f.evidence();
    assert.equal(report.packages[0].state, "pending");
    assert.equal(report.packages[0].stageId, undefined);
    await assert.rejects(f.run(), /Uncertain prior stage/);
    assert.equal(f.uploads().length, 1);
  }
});

test("a pending upload with no visible stage cannot be blindly retried", async () => {
  const f = await fixture();
  f.behavior.failBeforeUpload = true;
  await assert.rejects(f.run(), /outcome unresolved/);
  f.behavior.failBeforeUpload = false;
  await assert.rejects(f.run(), /Uncertain prior stage/);
  assert.equal(f.uploads().length, 1);
  assert.equal((await f.evidence()).packages[0].state, "pending");
});

test("returned stage evidence is sufficient for the approval handoff", async () => {
  const f = await fixture();
  await f.run();
  const report = await f.evidence();
  assert.equal(report.packages[0].stageId, uuid(1));
  assert.equal(report.packages[0].state, "staged");
  assert.deepEqual(report.approvalCommands, [
    { layer: 1, command: `pnpm stage approve ${uuid(1)} --registry https://registry.npmjs.org/` },
  ]);
  await assert.rejects(f.run(), /Uncertain prior stage/);
  assert.equal(f.uploads().length, 1);
});

test("already public exact integrity is deterministic and never triggers staging or tag repair", async () => {
  const f = await fixture();
  const [entry] = f.manifest.packages;
  f.publicIntegrity.set(entry.name, entry.integrity);
  f.tags.get(entry.name)!.next = entry.version;
  await f.run();
  await f.run();
  assert.equal((await f.evidence()).packages[0].state, "public");
  assert.equal(f.uploads().length, 0);
  delete f.tags.get(entry.name)!.next;
  await assert.rejects(f.run(), /incorrect next tag/);
  assert.equal((await f.evidence()).complete, false);
  f.publicIntegrity.set(entry.name, "sha512-conflicting");
  await assert.rejects(f.run(), /Registry integrity mismatch/);
  assert.equal(f.tags.get(entry.name)!.latest, "0.0.9");
});

test("old release candidates and stable versions cannot demote channels", async () => {
  for (const [version, tag, newer] of [
    ["0.1.0-rc.0", "next", "0.1.0-rc.1"],
    ["0.1.0", "latest", "0.2.0"],
  ]) {
    const f = await fixture(version);
    f.tags.get("@sqlbraid/core")![tag] = newer;
    await assert.rejects(f.run(), /Refusing to move .* backward/);
    assert.equal(f.uploads().length, 0);
  }
});

test("prerelease latest corruption before or during staging fails closed", async () => {
  const f = await fixture();
  f.tags.get("@sqlbraid/core")!.latest = f.manifest.version;
  await assert.rejects(f.run(), /Refusing prerelease/);
  const other = await fixture();
  other.behavior.changeLatest = true;
  await assert.rejects(other.run(), /latest tag changed/);
  assert.equal((await other.evidence()).complete, false);
  const advanced = await fixture();
  advanced.behavior.advanceNext = true;
  await assert.rejects(advanced.run(), /Refusing to move .* backward/);
  assert.equal((await advanced.evidence()).complete, false);
});

test("partial package staging preserves IDs and blocks automatic recovery", async () => {
  const f = await fixture("0.1.0", ["@sqlbraid/core", "@sqlbraid/template"]);
  f.behavior.failPackage = "@sqlbraid/template";
  await assert.rejects(f.run(), /outcome unresolved/);
  const partial = await f.evidence();
  assert.equal(partial.packages[0].state, "staged");
  assert.equal(partial.packages[1].state, "pending");
  assert.equal(partial.complete, false);
  for (const tag of f.tags.values()) assert.deepEqual(tag, { latest: "0.0.9" });
  f.behavior.failPackage = "";
  assert.deepEqual(partial.approvalCommands, [
    { layer: 1, command: `pnpm stage approve ${uuid(1)} --registry https://registry.npmjs.org/` },
  ]);
  const uploadsBeforeRetry = f.uploads().length;
  await assert.rejects(f.run());
  assert.equal(f.uploads().length, uploadsBeforeRetry);
  assertManifestOrder(f.manifest, ["@sqlbraid/core", "@sqlbraid/template"]);
  assert.throws(() => assertManifestOrder(f.manifest, ["@sqlbraid/template", "@sqlbraid/core"]), /dependency-derived/);
});

test("staging evidence from another candidate or run cannot authorize a retry", async () => {
  const f = await fixture();
  await f.run();
  await assert.rejects(
    stageCandidates({ ...f.manifest, runId: "another" }, { directory: f.directory }),
    /does not match/,
  );
  assert.equal(f.uploads().length, 1);
});

test("cross-run reconciliation imports only explicit prior evidence and preserves current-run identity", async () => {
  const f = await fixture();
  f.publicIntegrity.set("@sqlbraid/core", f.manifest.packages[0].integrity);
  f.tags.get("@sqlbraid/core")!.next = f.manifest.version;
  await f.run();
  const prior = await f.evidence();
  await rm(join(f.directory, "staged-publication.json"));
  const report = await stageCandidates(f.manifest, {
    directory: f.directory,
    priorEvidence: prior,
    priorRunId: "123",
    currentRunId: "456",
    currentRunAttempt: "1",
  });
  assert.equal(report?.mode, "reconcile");
  assert.equal(report?.runId, "456");
  assert.equal(report?.runAttempt, "1");
  assert.equal(report?.candidateRunId, "123");
  assert.equal(report?.candidateRunAttempt, "1");
  assert.deepEqual(report?.reconciledFrom, {
    runId: "123",
    runAttempt: "1",
    manifestSha256: prior.manifestSha256,
    candidateIdentitySha256: prior.candidateIdentitySha256,
  });
  assert.equal(report?.packages[0].state, "public");
  assert.equal(f.uploads().length, 0);
});

test("cross-run reconciliation refuses an uncertain prior upload without retrying", async () => {
  const f = await fixture();
  f.behavior.failAfterUpload = true;
  await assert.rejects(f.run(), /outcome unresolved/);
  const prior = await f.evidence();
  await rm(join(f.directory, "staged-publication.json"));
  await assert.rejects(
    stageCandidates(f.manifest, {
      directory: f.directory,
      priorEvidence: prior,
      priorRunId: "123",
      currentRunId: "456",
      currentRunAttempt: "1",
    }),
  );
  assert.equal(f.uploads().length, 1);
});

test("cross-run reconciliation binds the requested run and original manifest digest", async () => {
  const f = await fixture();
  await f.run();
  const prior = await f.evidence();
  await rm(join(f.directory, "staged-publication.json"));
  await assert.rejects(
    stageCandidates(f.manifest, {
      directory: f.directory,
      priorEvidence: prior,
      priorRunId: "999",
      currentRunId: "456",
      currentRunAttempt: "1",
    }),
    /requested prior candidate run/,
  );
  await assert.rejects(
    stageCandidates(f.manifest, {
      directory: f.directory,
      priorEvidence: { ...prior, manifestSha256: "f".repeat(64) },
      priorRunId: "123",
      currentRunId: "456",
      currentRunAttempt: "1",
    }),
    /immutable prior candidate manifest/,
  );
  assert.equal(f.uploads().length, 1);
});

test("post-approval verification needs no tarballs and rejects missing packages, provenance, tags or changed latest", async () => {
  const f = await fixture();
  await f.run();
  const evidence = await f.evidence();
  const [entry] = f.manifest.packages;
  await rm(join(f.directory, entry.file));
  await assert.rejects(verifyPublished(f.manifest, evidence), /Registry integrity mismatch/);
  f.publicIntegrity.set(entry.name, entry.integrity);
  await assert.rejects(verifyPublished(f.manifest, evidence), /Registry tag/);
  f.tags.get(entry.name)!.next = entry.version;
  await verifyPublished(f.manifest, evidence);
  f.behavior.provenance = false;
  await assert.rejects(verifyPublished(f.manifest, evidence), /provenance metadata missing/);
  f.behavior.provenance = true;
  f.tags.get(entry.name)!.latest = entry.version;
  await assert.rejects(verifyPublished(f.manifest, evidence), /latest tag changed/);
  assert.equal(f.uploads().length, 1);
});

test("stable post-approval verification reports but never executes latest promotion", async () => {
  const f = await fixture("0.1.0");
  await f.run();
  const evidence = await f.evidence();
  const [entry] = f.manifest.packages;
  f.publicIntegrity.set(entry.name, entry.integrity);
  f.tags.get(entry.name)!["release-0.1.0"] = "0.1.0";
  await verifyPublished(f.manifest, evidence);
  await assert.rejects(verifyPublished(f.manifest, evidence, { requireLatest: true }), /Registry latest/);
  f.tags.get(entry.name)!.latest = "0.1.0";
  await verifyPublished(f.manifest, evidence, { requireLatest: true });
  assert.equal(
    f.calls.some(([command]) => command === "dist-tag"),
    false,
  );
});

test("offline verification rejects mixed versions, duplicate identities and malformed digests before registry reads", async () => {
  const f = await fixture();
  await f.run();
  const evidence = await f.evidence();
  const [entry] = f.manifest.packages;
  const queries = f.calls.length;
  for (const packages of [
    [{ ...entry, version: "0.1.0-rc.1" }],
    [entry, entry],
    [{ ...entry, name: "unsafe;command" }],
    [{ ...entry, sha256: "invalid" }],
    [{ ...entry, integrity: "sha512-invalid" }],
    [],
  ]) {
    const manifest = { ...f.manifest, packages };
    const matchingEvidence = {
      ...evidence,
      manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    };
    await assert.rejects(verifyPublished(manifest, matchingEvidence), /Invalid release/);
  }
  assert.equal(f.calls.length, queries);
});

test("stage authorization requires explicit dispatch and exact version tag, rejecting retired modes", () => {
  const sha = "a".repeat(40);
  const authorized = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    SQLBRAID_RELEASE_MODE: "stage",
    GITHUB_REF: "refs/tags/v0.1.0-rc.0",
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };
  assertMutationAuthorization("stage", authorized);
  for (const override of [
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_ACTIONS: "false" },
    { SQLBRAID_RELEASE_MODE: "certify" },
    { SQLBRAID_RELEASE_MODE: "pack-only" },
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF: sha },
    { GITHUB_REF: `refs/heads/${sha}` },
    { GITHUB_REF: "refs/tags/v0.1.0-rc.1" },
    { GITHUB_REF: "refs/tags/v0.1.0" },
    { GITHUB_RUN_ID: "" },
    { GITHUB_RUN_ATTEMPT: "" },
    { GITHUB_SHA: "unknown" },
  ])
    assert.throws(() => assertMutationAuthorization("stage", { ...authorized, ...override }));
  for (const mode of ["publish", "bootstrap-rc0", "certify"])
    assert.throws(() => assertMutationAuthorization(mode, authorized));
});

test("package-specific tag authorization uses the package slug", () => {
  const sha = "a".repeat(40);
  setReleasePackage("postgres");
  setReleaseVersion("1.2.3");
  assertMutationAuthorization("stage", {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    SQLBRAID_RELEASE_MODE: "stage",
    GITHUB_REF: "refs/tags/postgres-v1.2.3",
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  });
});

test("normal staging cannot fall back to static credentials or a supplied OIDC token", () => {
  const oidc = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.example/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "actions-token",
  };
  assertPublicationCredentials("stage", oidc);
  for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_BOOTSTRAP_TOKEN", "NPM_ID_TOKEN"]) {
    assert.throws(() => assertPublicationCredentials("stage", { ...oidc, [name]: "forbidden" }), /must not receive/);
  }
  assert.throws(() => assertPublicationCredentials("stage", {}), /id-token/);
});

test("pinned pnpm stages and downloads exact prebuilt tarball bytes through a local fake registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-native-stage-"));
  directories.push(directory);
  await mkdir(join(directory, "package"));
  await writeFile(
    join(directory, "package/package.json"),
    JSON.stringify({
      name: "release-rehearsal",
      version: "0.0.0-test",
      scripts: { prepublishOnly: "exit 99", postpublish: "exit 99" },
    }),
  );
  const tarball = join(directory, "candidate.tgz");
  await execFileAsync("tar", ["-czf", tarball, "-C", directory, "package"]);
  const bytes = await readFile(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const nativeCalls: string[] = [];
  let uploaded: Buffer | undefined;
  let requestedTag: unknown;
  const server = createServer(async (request, response) => {
    nativeCalls.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/-/stage/package/release-rehearsal") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const document = JSON.parse(Buffer.concat(chunks).toString());
      requestedTag = document["dist-tags"];
      const attachment =
        document._attachments[Object.keys(document._attachments).find((name) => name.endsWith(".tgz"))!];
      uploaded = Buffer.from(attachment.data, "base64");
      response.end(JSON.stringify({ ok: true, stageId: uuid(1) }));
    } else if (request.method === "GET" && request.url === `/-/stage/${uuid(1)}/tarball`) {
      response.setHeader("content-type", "application/octet-stream");
      response.end(uploaded);
    } else {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "unexpected request" }));
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const registry = `http://127.0.0.1:${address.port}/`;
    const env = {
      ...process.env,
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      GITHUB_ACTIONS: "",
      NPM_ID_TOKEN: "",
      NODE_AUTH_TOKEN: "",
      NPM_TOKEN: "",
    };
    const args = [
      "stage",
      "publish",
      tarball,
      "--access",
      "public",
      "--tag",
      "next",
      "--json",
      "--reporter=silent",
      "--no-git-checks",
      "--ignore-scripts",
      "--npmrc-auth-file",
      "/dev/null",
      "--registry",
      registry,
    ];
    const pinned = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).packageManager;
    assert.equal((await execFileAsync("pnpm", ["--version"])).stdout.trim(), pinned.slice(5));
    const dry = await execFileAsync("pnpm", [...args, "--dry-run", "--provenance"], { cwd: directory, env });
    assert.equal(JSON.parse(dry.stdout)["release-rehearsal"].integrity, integrity);
    assert.equal(nativeCalls.length, 0);
    const stage = await execFileAsync("pnpm", args, { cwd: directory, env });
    assert.equal(JSON.parse(stage.stdout)["release-rehearsal"].stageId, uuid(1));
    assert.deepEqual(uploaded, bytes);
    assert.deepEqual(requestedTag, { next: "0.0.0-test" });
    const download = await execFileAsync(
      "pnpm",
      [
        "stage",
        "download",
        uuid(1),
        "--json",
        "--reporter=silent",
        "--npmrc-auth-file",
        "/dev/null",
        "--registry",
        registry,
      ],
      { cwd: directory, env },
    );
    const summary = JSON.parse(download.stdout)["release-rehearsal"];
    assert.equal(summary.integrity, integrity);
    assert.deepEqual(await readFile(join(directory, summary.filename)), bytes);
    assert.deepEqual(await readFile(tarball), bytes);
    assert.deepEqual(nativeCalls, ["POST /-/stage/package/release-rehearsal", `GET /-/stage/${uuid(1)}/tarball`]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("release tooling accepts valid SemVer and rejects malformed versions", () => {
  assert.deepEqual(parseSemver("0.1.0-rc.2"), {
    major: 0,
    minor: 1,
    patch: 0,
    prerelease: ["rc", "2"],
    isPrerelease: true,
  });
  assert.equal(parseSemver("0.1.0").isPrerelease, false);
  assert.throws(() => parseSemver("0.1"), /Invalid release version/);
  assert.throws(() => parseSemver("0.1.0-rc.01"), /Invalid release version/);
  assert.throws(() => parseSemver("v0.1.0"), /Invalid release version/);
});

test("version tags must resolve to checkout HEAD and the exact workflow SHA", async () => {
  const head = "a".repeat(40);
  let tagged = head;
  setReleaseVersion("0.1.0-rc.0");
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_SHA", head);
  vi.stubEnv("GITHUB_REF", "refs/tags/v0.1.0-rc.0");
  setReleaseCommand(async (file, args) => {
    assert.equal(file, "git", "tag preflight cannot mutate a registry");
    if (args[0] === "rev-parse") return head;
    if (args[0] === "rev-list") return tagged;
    throw new Error(`Unexpected git operation ${args[0]}`);
  });
  assert.equal(await assertTaggedSha(), head);
  tagged = "b".repeat(40);
  await assert.rejects(assertTaggedSha(), /does not point at HEAD/);
  tagged = head;
  vi.stubEnv("GITHUB_SHA", "c".repeat(40));
  await assert.rejects(assertTaggedSha(), /does not equal checked out HEAD/);
  vi.stubEnv("GITHUB_SHA", head);
  vi.stubEnv("SQLBRAID_TAG_BEFORE", "b".repeat(40));
  await assert.rejects(assertTaggedSha(), /create a new release candidate/);
});

test("candidate validation rejects changed bytes, missing integrity, stale runs, identities, and pack stamps", async () => {
  setReleaseVersion("0.1.0-rc.0");
  vi.stubEnv("GITHUB_RUN_ID", "123");
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-candidate-check-"));
  try {
    await mkdir(join(directory, "package"));
    await writeFile(
      join(directory, "package/package.json"),
      JSON.stringify({ name: "@sqlbraid/core", version: "0.1.0-rc.0" }),
    );
    await writeFile(join(directory, "package/README.md"), "candidate");
    await writeFile(join(directory, "package/LICENSE"), "license");
    const tarball = join(directory, "core.tgz");
    await execFileAsync("tar", ["-czf", tarball, "-C", directory, "package"]);
    const bytes = await readFile(tarball);
    const entry = {
      name: "@sqlbraid/core",
      version: "0.1.0-rc.0",
      file: "core.tgz",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      dependencies: [],
    };
    const candidateVersion = "0.1.0-rc.0";
    const candidate = {
      version: candidateVersion,
      commit: "a".repeat(40),
      runId: "123",
      runAttempt: "1",
      packages: [entry],
    };
    const stamp = {
      version: candidate.version,
      commit: candidate.commit,
      packages: [{ name: entry.name, sha256: entry.sha256 }],
    };
    const manifestFile = join(directory, "release-manifest.json");
    const stampFile = join(directory, "pack-check-success.json");
    setReleaseCommand(async (file, args, cwd) => {
      assert.equal(file, "tar", "candidate verification cannot rebuild or publish");
      return (await execFileAsync(file, [...args], { cwd })).stdout;
    });
    await writeFile(manifestFile, JSON.stringify(candidate));
    await writeFile(stampFile, JSON.stringify(stamp));
    assert.equal((await readReleaseManifest(directory)).packages[0].integrity, entry.integrity);
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
    await assert.rejects(readReleaseManifest(directory), /attempt/);
    assert.equal((await readReleaseManifest(directory, { priorCandidateRunId: "456" })).runId, "123");
    await assert.rejects(
      readReleaseManifest(directory, { priorCandidateRunId: "not-a-run" }),
      /requested prior candidate run/,
    );
    assert.equal((await readReleaseManifest(directory, { allowCurrentAttemptMismatch: true })).runAttempt, "1");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    for (const changed of [
      { ...candidate, runId: "122" },
      { ...candidate, runAttempt: "2" },
      { ...candidate, packages: [{ ...entry, sha256: "changed" }] },
      { ...candidate, packages: [{ ...entry, integrity: undefined }] },
      { ...candidate, packages: [{ ...entry, integrity: "sha512-different" }] },
      { ...candidate, packages: [{ ...entry, dependencies: ["@sqlbraid/core"] }] },
      { ...candidate, packages: [{ ...entry, name: "@sqlbraid/template" }] },
      { ...candidate, packages: [{ ...entry, version: "0.1.0" }] },
    ]) {
      await writeFile(manifestFile, JSON.stringify(changed));
      await assert.rejects(readReleaseManifest(directory));
    }
    await writeFile(manifestFile, JSON.stringify(candidate));
    await writeFile(stampFile, JSON.stringify({ ...stamp, commit: "b".repeat(40) }));
    await assert.rejects(readReleaseManifest(directory), /pack-check stamp/);
    await writeFile(stampFile, JSON.stringify(stamp));
    await writeFile(tarball, Buffer.concat([bytes, Buffer.from("changed")]));
    await assert.rejects(readReleaseManifest(directory), /tarball changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable release evidence keeps candidate, support, and staged identities compact", async () => {
  const f = await fixture();
  await f.run();
  const support = join(f.directory, "support-profile-evidence.json");
  const targets = join(f.directory, "targets");
  await mkdir(targets);
  await writeFile(
    support,
    JSON.stringify({
      format: "sqlbraid-support-evidence",
      version: 1,
      commit: f.manifest.commit,
      run: "123",
      targets: [{ id: "postgres" }],
    }),
  );
  await writeFile(
    join(targets, "postgres.json"),
    JSON.stringify({
      format: "sqlbraid-support-evidence",
      version: 1,
      commit: f.manifest.commit,
      targets: [{ id: "postgres" }],
    }),
  );
  const durable = await createReleaseEvidence(f.manifest, await f.evidence(), {
    directory: f.directory,
    supportEvidencePath: support,
    targetEvidenceDirectory: targets,
    stagedEvidencePath: join(f.directory, "staged-publication.json"),
  });
  assert.equal(durable.format, "sqlbraid-release-evidence");
  assert.equal(durable.version, f.manifest.version);
  assert.equal(durable.commit, f.manifest.commit);
  assert.equal(durable.candidate.packages[0].sha256, f.manifest.packages[0].sha256);
  assert.deepEqual(durable.certification.support.targetIds, ["postgres"]);
  assert.deepEqual(durable.certification.targets[0].ids, ["postgres"]);
  assert.equal(durable.certification.targets[0].sha256.length, 64);
  assert.equal(durable.publication.packages[0].stageId, uuid(1));
});
