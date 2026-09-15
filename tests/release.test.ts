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
  assertPnpmIdentityAndWriteAccess,
  pnpmPublish,
  parseSemver,
  readReleaseManifest,
  setReleaseCommand,
  setReleaseRequest,
  setReleaseVersion,
} from "../scripts/release.mjs";

const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.unstubAllEnvs();
  setReleaseRequest(fetch);
  setReleaseVersion("0.1.0-rc.0");
});

interface PnpmStub {
  readonly calls: readonly (readonly string[])[];
  readonly publishCount: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly command: (file: string, args: readonly string[]) => Promise<string>;
}

function notFound(): never {
  const error = new Error("pnpm error ERR_PNPM_FETCH_404");
  Object.assign(error, { stderr: "pnpm error ERR_PNPM_FETCH_404" });
  throw error;
}

function pnpmStub({
  integrity,
  initialIntegrity,
  initialTags = {},
  failPublish = false,
}: {
  integrity: string;
  initialIntegrity?: string;
  initialTags?: Readonly<Record<string, string>>;
  failPublish?: boolean;
}): PnpmStub {
  const calls: (readonly string[])[] = [];
  let publishedIntegrity = initialIntegrity;
  let packageExists = initialIntegrity !== undefined || Object.keys(initialTags).length > 0;
  let shouldFailPublish = failPublish;
  let publishCount = 0;
  const tags: Record<string, string> = { ...initialTags };
  const command = async (file: string, args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (file !== "pnpm") throw new Error(`unexpected command ${file}`);
    if (args[0] === "--version") return "12.3.4\n";
    if (args[0] === "config") return "https://registry.npmjs.org/\n";
    if (args[0] === "ping") return "";
    if (args[0] === "view" && args[2] === "dist.integrity") {
      if (publishedIntegrity === undefined) return notFound();
      return `${JSON.stringify(publishedIntegrity)}\n`;
    }
    if (args[0] === "view" && args[2] === "version") {
      if (publishedIntegrity === undefined) return notFound();
      return JSON.stringify("0.1.0");
    }
    if (args[0] === "view" && args[2] === "dist-tags") {
      if (!packageExists) return notFound();
      return `${JSON.stringify(tags)}\n`;
    }
    if (args[0] === "publish") {
      publishCount += 1;
      packageExists = true;
      publishedIntegrity = integrity;
      const tagIndex = args.indexOf("--tag");
      if (tagIndex >= 0) tags[args[tagIndex + 1]] = args[tagIndex + 1] === "next" ? "0.1.0-rc.0" : "0.1.0";
      if (shouldFailPublish) {
        shouldFailPublish = false;
        const error = new Error("network failure after upload");
        Object.assign(error, { stderr: "network failure after upload" });
        throw error;
      }
      return "";
    }
    if (args[0] === "dist-tag" && args[1] === "add") {
      const tag = args[3]?.startsWith("--") ? "latest" : args[3] ?? "latest";
      tags[tag] = tag === "next" ? "0.1.0-rc.0" : tag === "latest" ? "0.1.0" : "0.1.0";
      return "";
    }
    throw new Error(`unexpected pnpm invocation: ${args.join(" ")}`);
  };
  return {
    get calls() {
      return calls;
    },
    get publishCount() {
      return publishCount;
    },
    get tags() {
      return tags;
    },
    command,
  };
}

const manifest = (name: string, version: string, integrity: string) => ({
  version,
  commit: "fixture",
  packages: [{ name, version, file: `${name.replaceAll("/", "-")}.tgz`, sha256: "fixture", integrity }],
});

test("stable publication publishes absent packages under a temporary tag and promotes latest after verification", async () => {
  setReleaseVersion("0.1.0");
  const pnpm = pnpmStub({ integrity: "sha512-stable" });
  setReleaseCommand(pnpm.command);
  await pnpmPublish(manifest("@sqlbraid/core", "0.1.0", "sha512-stable"), { dryRun: false, provenance: false });
  assert.equal(pnpm.publishCount, 1);
  assert.deepEqual(pnpm.tags, { "release-0.1.0": "0.1.0", latest: "0.1.0" });
  const publish = pnpm.calls.find(([command]) => command === "publish");
  assert.ok(publish);
  assert.equal(publish[publish.indexOf("--tag") + 1], "release-0.1.0");
  assert.equal(publish[publish.indexOf("--access") + 1], "public");
  assert.equal(publish[publish.indexOf("--registry") + 1], "https://registry.npmjs.org/");
  assert.equal(publish.includes("--no-git-checks"), true);
  assert.equal(publish.includes("latest"), false);
  assert.equal(publish.includes("--provenance"), false);
});

test("provenance publication uses pnpm OIDC and an OIDC-authenticated tag repair", async () => {
  setReleaseVersion("0.1.0");
  const pnpm = pnpmStub({ integrity: "sha512-stable" });
  const requests: { url: string; method: string; authorization?: string; body?: string }[] = [];
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://oidc.actions.example/token");
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "actions-token");
  setReleaseCommand(pnpm.command);
  setReleaseRequest(async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET", authorization: String(new Headers(init.headers).get("authorization") ?? ""), body: typeof init.body === "string" ? init.body : undefined });
    if (!init.method) return Response.json({ value: "github-id-token" });
    if (init.method === "POST") return new Response(JSON.stringify({ token: "npm-oidc-token" }), { status: 200 });
    if (init.method === "PUT") (pnpm.tags as Record<string, string>)[new URL(String(url)).pathname.split("/").at(-1)!] = "0.1.0";
    return new Response("", { status: 200 });
  });
  try {
    await pnpmPublish(manifest("@sqlbraid/core", "0.1.0", "sha512-stable"), { dryRun: false, provenance: true });
    const publish = pnpm.calls.find(([command]) => command === "publish");
    assert.ok(publish);
    assert.equal(publish.includes("--provenance"), true);
    assert.equal(publish[publish.indexOf("--access") + 1], "public");
    assert.equal(requests.some(({ method, authorization, url }) => method === "POST"
      && url === "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/%40sqlbraid%2Fcore"
      && authorization === "Bearer github-id-token"), true);
    assert.equal(requests.some(({ method, authorization, body, url }) => method === "PUT"
      && url === "https://registry.npmjs.org/-/package/%40sqlbraid%2Fcore/dist-tags/latest"
      && authorization === "Bearer npm-oidc-token" && body === JSON.stringify("0.1.0")), true);
  } finally {
    setReleaseRequest(fetch);
  }
  assert.equal(requests[0].url, "https://oidc.actions.example/token?audience=npm%3Aregistry.npmjs.org");
  assert.equal(requests[0].authorization, "Bearer actions-token");
});

test("pinned pnpm executable dry-run reports integrity of the exact immutable tarball", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-pnpm-rehearsal-"));
  const packageDirectory = join(directory, "package");
  try {
    const packageManager = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).packageManager;
    assert.equal((await execFileAsync("pnpm", ["--version"])).stdout.trim(), packageManager.slice("pnpm@".length));
    await mkdir(packageDirectory);
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "release-rehearsal", version: "0.0.0-test" }));
    await writeFile(join(packageDirectory, "README.md"), "rehearsal\n");
    await writeFile(join(packageDirectory, "LICENSE"), "license\n");
    await execFileAsync("pnpm", ["pack", "--pack-destination", directory], { cwd: packageDirectory });
    const tarball = join(directory, "release-rehearsal-0.0.0-test.tgz");
    const before = createHash("sha256").update(await readFile(tarball)).digest("hex");
    const { stdout } = await execFileAsync("pnpm", ["publish", tarball, "--access", "public", "--tag", "next", "--dry-run", "--provenance", "--json", "--no-git-checks", "--registry", "https://registry.npmjs.org/"], { cwd: directory });
    const after = createHash("sha256").update(await readFile(tarball)).digest("hex");
    assert.equal(after, before);
    assert.equal(JSON.parse(stdout).integrity, `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native pnpm consumes unexpanded NODE_AUTH_TOKEN configuration for bootstrap identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-bootstrap-auth-"));
  let authorization: string | undefined;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    paths.push(request.url!);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/-/whoami"
      ? { username: "bootstrap-fixture-user" } : { "@sqlbraid/core": "read-write", sqlbraid: "read-write" }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const registry = `http://127.0.0.1:${address.port}/`;
    const config = join(directory, "npmrc");
    await writeFile(config, `registry=${registry}\n//127.0.0.1:${address.port}/:_authToken=\${NODE_AUTH_TOKEN}\n`);
    const { stdout } = await execFileAsync("pnpm", ["whoami", "--registry", registry], {
      cwd: directory,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: config, NODE_AUTH_TOKEN: "bootstrap-fixture-token" },
    });
    assert.equal(stdout.trim(), "bootstrap-fixture-user");
    assert.equal(authorization, "Bearer bootstrap-fixture-token");
    const access = await execFileAsync("pnpm", ["access", "list", "packages", "bootstrap-fixture-user", "--json", "--registry", registry], {
      cwd: directory,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: config, NODE_AUTH_TOKEN: "bootstrap-fixture-token" },
    });
    assert.deepEqual(JSON.parse(access.stdout), { "@sqlbraid/core": "read-write", sqlbraid: "read-write" });
    assert.deepEqual(paths, ["/-/whoami", "/-/user/bootstrap-fixture-user/package?format=cli"]);
    assert.ok((await readFile(config, "utf8")).includes("${NODE_AUTH_TOKEN}"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("stable publication skips an exact existing artifact but rejects mismatched content", async () => {
  setReleaseVersion("0.1.0");
  const exact = pnpmStub({
    integrity: "sha512-stable",
    initialIntegrity: "sha512-stable",
    initialTags: { "release-0.1.0": "0.1.0", latest: "0.0.9" },
  });
  setReleaseCommand(exact.command);
  await pnpmPublish(manifest("@sqlbraid/core", "0.1.0", "sha512-stable"), { dryRun: false, provenance: false });
  assert.equal(exact.publishCount, 0);
  assert.equal(exact.tags.latest, "0.1.0");

  const mismatch = pnpmStub({
    integrity: "sha512-stable",
    initialIntegrity: "sha512-tampered",
    initialTags: { latest: "0.0.9" },
  });
  setReleaseCommand(mismatch.command);
  await assert.rejects(
    pnpmPublish(manifest("@sqlbraid/core", "0.1.0", "sha512-stable"), { dryRun: false, provenance: false }),
    /Registry integrity mismatch/,
  );
  assert.equal(mismatch.publishCount, 0);
  assert.deepEqual(mismatch.tags, { latest: "0.0.9" });
});

test("RC publication survives an uncertain upload, retries by exact registry match, and leaves latest unchanged", async () => {
  setReleaseVersion("0.1.0-rc.0");
  const pnpm = pnpmStub({
    integrity: "sha512-rc",
    initialTags: { latest: "0.0.9" },
    failPublish: true,
  });
  setReleaseCommand(pnpm.command);
  const candidate = manifest("@sqlbraid/core", "0.1.0-rc.0", "sha512-rc");
  await pnpmPublish(candidate, { dryRun: false, provenance: false });
  await pnpmPublish(candidate, { dryRun: false, provenance: false });
  assert.equal(pnpm.publishCount, 1);
  assert.equal(pnpm.tags.next, "0.1.0-rc.0");
  assert.equal(pnpm.tags.latest, "0.0.9");
  const publishes = pnpm.calls.filter(([command]) => command === "publish");
  assert.equal(publishes[0].includes("--provenance"), false);
  assert.equal(publishes[0][publishes[0].indexOf("--tag") + 1], "next");
});

test("RC retry repairs next without allowing pnpm's default latest tag", async () => {
  setReleaseVersion("0.1.0-rc.0");
  const pnpm = pnpmStub({ integrity: "sha512-rc", initialIntegrity: "sha512-rc", initialTags: { next: "0.0.9", latest: "0.0.9" } });
  setReleaseCommand(pnpm.command);
  await pnpmPublish(manifest("@sqlbraid/core", "0.1.0-rc.0", "sha512-rc"), { dryRun: false, provenance: false });
  assert.equal(pnpm.tags.next, "0.1.0-rc.0");
  assert.equal(pnpm.tags.latest, "0.0.9");
  assert.equal(pnpm.publishCount, 0);
});

test("release tooling accepts valid SemVer and rejects malformed versions", () => {
  assert.deepEqual(parseSemver("0.1.0-rc.0"), {
    major: 0,
    minor: 1,
    patch: 0,
    prerelease: ["rc", "0"],
    isPrerelease: true,
  });
  assert.equal(parseSemver("0.1.0").isPrerelease, false);
  assert.throws(() => parseSemver("0.1"), /Invalid release version/);
  assert.throws(() => parseSemver("0.1.0-rc.01"), /Invalid release version/);
  assert.throws(() => parseSemver("v0.1.0"), /Invalid release version/);
});

test("old RC and stable retries cannot demote registry channels", async () => {
  for (const [version, tag, newer] of [
    ["0.1.0-rc.0", "next", "0.1.0-rc.1"],
    ["0.1.0", "latest", "0.2.0"],
  ]) {
    setReleaseVersion(version);
    const pnpm = pnpmStub({ integrity: "sha512-old", initialTags: { [tag]: newer } });
    setReleaseCommand(pnpm.command);
    await assert.rejects(
      pnpmPublish(manifest("@sqlbraid/core", version, "sha512-old"), { dryRun: false, provenance: false }),
      /Refusing to move .* backward/,
    );
    assert.equal(pnpm.publishCount, 0);
    assert.equal(pnpm.tags[tag], newer);
  }
});

test("bootstrap preflight rejects partial package access before publishing anything", async () => {
  setReleaseCommand(async (_file: string, args: readonly string[]) => {
    if (args[0] === "--version") return "12.3.4";
    if (args[0] === "whoami") return "release-user";
    if (args[0] === "config") return "https://registry.npmjs.org/";
    if (args[0] === "ping") return "";
    if (args[0] === "access") return JSON.stringify({ "@sqlbraid/core": "read-write", sqlbraid: "read-only" });
    if (args[0] === "view") return JSON.stringify(args[1]);
    throw new Error(`Unexpected registry mutation: ${args.join(" ")}`);
  });
  await assert.rejects(
    assertPnpmIdentityAndWriteAccess([{ name: "@sqlbraid/core" }, { name: "sqlbraid" }]),
    /does not have write access to sqlbraid/,
  );
});

test("publication authorization rejects non-dispatch events, branch/SHA refs, and mismatched versions", () => {
  const sha = "a".repeat(40);
  for (const mode of ["bootstrap-rc0", "publish"]) {
    setReleaseVersion("0.1.0-rc.0");
    const authorized = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", SQLBRAID_RELEASE_MODE: mode, GITHUB_REF: "refs/tags/v0.1.0-rc.0", GITHUB_SHA: sha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
    assertMutationAuthorization(mode, authorized);
    for (const override of [
      { GITHUB_EVENT_NAME: "push" }, { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_ACTIONS: "false" },
      { SQLBRAID_RELEASE_MODE: "certify" }, { SQLBRAID_RELEASE_MODE: "pack-only" },
      { GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: sha }, { GITHUB_REF: `refs/heads/${sha}` },
      { GITHUB_REF: "refs/tags/v0.1.0-rc.1" }, { GITHUB_REF: "refs/tags/v0.1.0" },
      { GITHUB_RUN_ID: "" }, { GITHUB_RUN_ATTEMPT: "" }, { GITHUB_SHA: "unknown" },
    ]) assert.throws(() => assertMutationAuthorization(mode, { ...authorized, ...override }));
  }
  setReleaseVersion("0.1.0-rc.1");
  assert.throws(() => assertMutationAuthorization("bootstrap-rc0", {
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", SQLBRAID_RELEASE_MODE: "bootstrap-rc0",
    GITHUB_REF: "refs/tags/v0.1.0-rc.1", GITHUB_SHA: sha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
  }), /exactly 0.1.0-rc.0/);
});

test("normal publication cannot fall back to static credentials or a supplied OIDC token", () => {
  const oidc = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.example/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "actions-token" };
  assertPublicationCredentials("publish", oidc);
  for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_BOOTSTRAP_TOKEN", "NPM_ID_TOKEN"]) {
    assert.throws(() => assertPublicationCredentials("publish", { ...oidc, [name]: "forbidden" }), /must not receive/);
  }
  assert.throws(() => assertPublicationCredentials("publish", {}), /id-token/);
  assert.throws(() => assertPublicationCredentials("bootstrap-rc0", {}), /NPM_BOOTSTRAP_TOKEN/);
  assertPublicationCredentials("bootstrap-rc0", { NODE_AUTH_TOKEN: "bootstrap-fixture" });
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
});

test("bootstrap verifies creation rights and current-token grants before any mutation", async () => {
  vi.stubEnv("NODE_AUTH_TOKEN", "bootstrap-fixture");
  setReleaseCommand(async (file, args) => {
    assert.equal(file, "pnpm");
    if (args[0] === "--version") return "12.3.4";
    if (args[0] === "whoami") return "release-user";
    if (args[0] === "config") return "https://registry.npmjs.org/";
    if (args[0] === "ping") return "";
    if (args[0] === "access") return "{}";
    if (args[0] === "view") return notFound();
    throw new Error("Unexpected mutation before bootstrap preflight completed");
  });
  let role = "developer";
  const currentToken = {
    token: "bootstra...ture",
    readonly: false,
    bypass_2fa: true,
    revoked: null,
    expiry: new Date(Date.now() + 60_000).toISOString(),
    permissions: [{ name: "package", action: "write" }],
    scopes: [{ type: "package", name: "*" }],
  };
  let tokens = [currentToken];
  let status = 200;
  setReleaseRequest(async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer bootstrap-fixture");
    assert.equal(init?.redirect, "error");
    if (String(url).includes("/-/npm/v1/tokens?")) {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      return Response.json({ objects: tokens.slice(page, page + 1), total: tokens.length }, { status });
    }
    assert.equal(String(url), "https://registry.npmjs.org/-/org/sqlbraid/user");
    return Response.json({ "release-user": role, "another-user": "owner" });
  });
  assert.equal(await assertPnpmIdentityAndWriteAccess([{ name: "@sqlbraid/core" }, { name: "sqlbraid" }]), "release-user");
  tokens = [{ ...currentToken, token: "other-token" }, currentToken];
  assert.equal(await assertPnpmIdentityAndWriteAccess([{ name: "sqlbraid" }]), "release-user");
  for (const change of [
    { scopes: [{ type: "package", name: "@sqlbraid/core" }] },
    { scopes: [{ type: "org", name: "sqlbraid" }] },
    { permissions: [{ name: "package", action: "read" }] },
    { readonly: true }, { bypass_2fa: false }, { expiry: "2000-01-01" },
  ]) {
    tokens = [{ ...currentToken, ...change }];
    await assert.rejects(assertPnpmIdentityAndWriteAccess([{ name: "@sqlbraid/core" }, { name: "sqlbraid" }]), /All packages/);
  }
  for (const ambiguous of [[], [currentToken, currentToken], [{ ...currentToken, token: "another-token" }]]) {
    tokens = ambiguous;
    await assert.rejects(assertPnpmIdentityAndWriteAccess([{ name: "sqlbraid" }]), /uniquely verify/);
  }
  status = 403;
  await assert.rejects(assertPnpmIdentityAndWriteAccess([{ name: "sqlbraid" }]), /HTTP 403/);
  role = "read-only";
  await assert.rejects(assertPnpmIdentityAndWriteAccess([{ name: "@sqlbraid/core" }]), /cannot create packages/);
});

test("publication dry-run is pnpm tarball-only and rejects a different installed pnpm", async () => {
  const pnpm = pnpmStub({ integrity: "sha512-rc" });
  setReleaseVersion("0.1.0-rc.0");
  setReleaseCommand(pnpm.command);
  const candidate = manifest("@sqlbraid/core", "0.1.0-rc.0", "sha512-rc");
  await pnpmPublish(candidate, { dryRun: true, provenance: false });
  const publish = pnpm.calls.find(([name]) => name === "publish")!;
  assert.ok(publish[1].endsWith(candidate.packages[0].file));
  assert.ok(publish.includes("--dry-run"));
  assert.equal(pnpm.calls.some(([name]) => name === "pack" || name === "dist-tag"), false);
  setReleaseCommand(async () => "12.3.3");
  await assert.rejects(pnpmPublish(candidate, { dryRun: true, provenance: false }), /requires pnpm/);
});

test("uncertain publication rejects different registry bytes and leaves all dist-tags unpromoted", async () => {
  setReleaseVersion("0.1.0");
  const pnpm = pnpmStub({ integrity: "sha512-different", failPublish: true, initialTags: { latest: "0.0.9" } });
  setReleaseCommand(pnpm.command);
  await assert.rejects(pnpmPublish(manifest("@sqlbraid/core", "0.1.0", "sha512-expected"), { dryRun: false, provenance: false }), /Registry integrity mismatch/);
  assert.equal(pnpm.tags.latest, "0.0.9");
  assert.equal(pnpm.calls.some(([command]) => command === "dist-tag"), false);
});

test("stable publication never promotes a partial package set", async () => {
  setReleaseVersion("0.1.0");
  const core = pnpmStub({ integrity: "sha512-core", initialTags: { latest: "0.0.9" } });
  const template = pnpmStub({ integrity: "sha512-template", initialTags: { latest: "0.0.9" } });
  setReleaseCommand(async (file, args) => {
    if (args[0] === "publish" && args[1].includes("template")) throw new Error("second package upload failed");
    return (args[1]?.includes("template") ? template : core).command(file, args);
  });
  const candidate = manifest("@sqlbraid/core", "0.1.0", "sha512-core");
  candidate.packages.push(...manifest("@sqlbraid/template", "0.1.0", "sha512-template").packages);
  assertManifestOrder(candidate, ["@sqlbraid/core", "@sqlbraid/template"]);
  assert.throws(() => assertManifestOrder(candidate, ["@sqlbraid/template", "@sqlbraid/core"]), /dependency-derived/);
  await assert.rejects(pnpmPublish(candidate, { dryRun: false, provenance: false }), /second package upload failed/);
  assert.equal(core.tags.latest, "0.0.9");
  assert.equal(template.tags.latest, "0.0.9");
  assert.equal(core.tags["release-0.1.0"], "0.1.0");
});

test("candidate validation rejects changed bytes, missing integrity, stale runs, identities, and pack stamps", async () => {
  setReleaseVersion("0.1.0-rc.0");
  vi.stubEnv("GITHUB_RUN_ID", "123");
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-candidate-check-"));
  try {
    await mkdir(join(directory, "package"));
    await writeFile(join(directory, "package/package.json"), JSON.stringify({ name: "@sqlbraid/core", version: "0.1.0-rc.0" }));
    await writeFile(join(directory, "package/README.md"), "candidate");
    await writeFile(join(directory, "package/LICENSE"), "license");
    const tarball = join(directory, "core.tgz");
    await execFileAsync("tar", ["-czf", tarball, "-C", directory, "package"]);
    const bytes = await readFile(tarball);
    const entry = { name: "@sqlbraid/core", version: "0.1.0-rc.0", file: "core.tgz", sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    const candidate = { version: "0.1.0-rc.0", commit: "a".repeat(40), runId: "123", runAttempt: "1", packages: [entry] };
    const stamp = { version: candidate.version, commit: candidate.commit, packages: [{ name: entry.name, sha256: entry.sha256 }] };
    const manifestFile = join(directory, "release-manifest.json");
    const stampFile = join(directory, "pack-check-success.json");
    setReleaseCommand(async (file, args, cwd) => {
      assert.equal(file, "tar", "candidate verification cannot rebuild or publish");
      return (await execFileAsync(file, [...args], { cwd })).stdout;
    });
    await writeFile(manifestFile, JSON.stringify(candidate));
    await writeFile(stampFile, JSON.stringify(stamp));
    assert.equal((await readReleaseManifest(directory)).packages[0].integrity, entry.integrity);
    for (const changed of [
      { ...candidate, runId: "122" }, { ...candidate, runAttempt: "2" },
      { ...candidate, packages: [{ ...entry, sha256: "changed" }] },
      { ...candidate, packages: [{ ...entry, integrity: undefined }] },
      { ...candidate, packages: [{ ...entry, integrity: "sha512-different" }] },
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
