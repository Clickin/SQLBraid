import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertNpmIdentityAndWriteAccess,
  npmPublish,
  npmVersionAtLeast,
  parseSemver,
  setReleaseCommand,
  setReleaseVersion,
} from "../scripts/release.mjs";

interface NpmStub {
  readonly calls: readonly (readonly string[])[];
  readonly publishCount: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly command: (file: string, args: readonly string[]) => Promise<string>;
}

function notFound(): never {
  const error = new Error("npm error code E404");
  Object.assign(error, { stderr: "npm error code E404" });
  throw error;
}

function npmStub({
  integrity,
  initialIntegrity,
  initialTags = {},
  failPublish = false,
}: {
  integrity: string;
  initialIntegrity?: string;
  initialTags?: Readonly<Record<string, string>>;
  failPublish?: boolean;
}): NpmStub {
  const calls: (readonly string[])[] = [];
  let publishedIntegrity = initialIntegrity;
  let packageExists = initialIntegrity !== undefined || Object.keys(initialTags).length > 0;
  let shouldFailPublish = failPublish;
  let publishCount = 0;
  const tags: Record<string, string> = { ...initialTags };
  const command = async (file: string, args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (file !== "npm") throw new Error(`unexpected command ${file}`);
    if (args[0] === "--version") return "11.15.0\n";
    if (args[0] === "config") return "https://registry.npmjs.org/\n";
    if (args[0] === "ping") return "";
    if (args[0] === "view" && args[2] === "dist.integrity") {
      if (publishedIntegrity === undefined) return notFound();
      return `${JSON.stringify(publishedIntegrity)}\n`;
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
      const tag = args[3];
      tags[tag] = tag === "next" ? "0.1.0-rc.0" : tag === "latest" ? "0.1.0" : "0.1.0";
      return "";
    }
    throw new Error(`unexpected npm invocation: ${args.join(" ")}`);
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
  packages: [{ name, file: `${name.replaceAll("/", "-")}.tgz`, sha256: "fixture", integrity }],
});

test("stable publication publishes absent packages under a temporary tag and promotes latest after verification", async () => {
  setReleaseVersion("0.1.0");
  const npm = npmStub({ integrity: "sha512-stable" });
  setReleaseCommand(npm.command);
  await npmPublish(manifest("@sqlbraid/core", "0.1.0", "sha512-stable"), { dryRun: false, provenance: true });
  assert.equal(npm.publishCount, 1);
  assert.deepEqual(npm.tags, { "release-0.1.0": "0.1.0", latest: "0.1.0" });
  const publish = npm.calls.find(([command]) => command === "publish");
  assert.ok(publish);
  assert.equal(publish[publish.indexOf("--tag") + 1], "release-0.1.0");
  assert.equal(publish.includes("latest"), false);
  assert.equal(publish.includes("--provenance"), true);
});

test("stable publication skips an exact existing artifact but rejects mismatched content", async () => {
  setReleaseVersion("0.1.0");
  const exact = npmStub({
    integrity: "sha512-stable",
    initialIntegrity: "sha512-stable",
    initialTags: { "release-0.1.0": "0.1.0", latest: "0.0.9" },
  });
  setReleaseCommand(exact.command);
  await npmPublish(manifest("@sqlbraid/core", "0.1.0", "sha512-stable"), { dryRun: false, provenance: true });
  assert.equal(exact.publishCount, 0);
  assert.equal(exact.tags.latest, "0.1.0");

  const mismatch = npmStub({
    integrity: "sha512-stable",
    initialIntegrity: "sha512-tampered",
    initialTags: { latest: "0.0.9" },
  });
  setReleaseCommand(mismatch.command);
  await assert.rejects(
    npmPublish(manifest("@sqlbraid/core", "0.1.0", "sha512-stable"), { dryRun: false, provenance: true }),
    /Registry integrity mismatch/,
  );
  assert.equal(mismatch.publishCount, 0);
  assert.deepEqual(mismatch.tags, { latest: "0.0.9" });
});

test("RC publication survives an uncertain upload, retries by exact registry match, and leaves latest unchanged", async () => {
  setReleaseVersion("0.1.0-rc.0");
  const npm = npmStub({
    integrity: "sha512-rc",
    initialTags: { latest: "0.0.9" },
    failPublish: true,
  });
  setReleaseCommand(npm.command);
  const candidate = manifest("@sqlbraid/core", "0.1.0-rc.0", "sha512-rc");
  await npmPublish(candidate, { dryRun: false, provenance: false });
  await npmPublish(candidate, { dryRun: false, provenance: false });
  assert.equal(npm.publishCount, 1);
  assert.equal(npm.tags.next, "0.1.0-rc.0");
  assert.equal(npm.tags.latest, "0.0.9");
  const publishes = npm.calls.filter(([command]) => command === "publish");
  assert.equal(publishes[0].includes("--provenance"), false);
  assert.equal(publishes[0][publishes[0].indexOf("--tag") + 1], "next");
});

test("release tooling accepts SemVer RCs and enforces the trusted-publishing npm floor", () => {
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
  assert.equal(npmVersionAtLeast("11.15.0", "11.15.0"), true);
  assert.equal(npmVersionAtLeast("11.14.9", "11.15.0"), false);
});

test("old RC and stable retries cannot demote registry channels", async () => {
  for (const [version, tag, newer] of [
    ["0.1.0-rc.0", "next", "0.1.0-rc.1"],
    ["0.1.0", "latest", "0.2.0"],
  ]) {
    setReleaseVersion(version);
    const npm = npmStub({ integrity: "sha512-old", initialTags: { [tag]: newer } });
    setReleaseCommand(npm.command);
    await assert.rejects(
      npmPublish(manifest("@sqlbraid/core", version, "sha512-old"), { dryRun: false, provenance: true }),
      /Refusing to move .* backward/,
    );
    assert.equal(npm.publishCount, 0);
    assert.equal(npm.tags[tag], newer);
  }
});

test("bootstrap preflight rejects partial package access before publishing anything", async () => {
  setReleaseCommand(async (_file: string, args: readonly string[]) => {
    if (args[0] === "whoami") return "release-user";
    if (args[0] === "config") return "https://registry.npmjs.org/";
    if (args[0] === "ping") return "";
    if (args[0] === "access") return JSON.stringify({ "@sqlbraid/core": "read-write", sqlbraid: "read-only" });
    if (args[0] === "view") return JSON.stringify(args[1]);
    throw new Error(`Unexpected registry mutation: ${args.join(" ")}`);
  });
  await assert.rejects(
    assertNpmIdentityAndWriteAccess([{ name: "@sqlbraid/core" }, { name: "sqlbraid" }]),
    /does not have write access to sqlbraid/,
  );
});
