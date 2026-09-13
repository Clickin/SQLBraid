import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  archiveRelease,
  assertReleaseSource,
  isSemVer,
  readVersions,
  rootRedirect,
} from "./docs-history.mjs";
import { routeForVersion } from "../website/version-routes.mjs";

const execFileAsync = promisify(execFile);

test("archive version validation rejects paths and malformed prereleases", async () => {
  for (const version of ["../escape", "/tmp/archive", "not-a-version", "0.1.0-rc.01"]) {
    assert.equal(isSemVer(version), false);
    await assert.rejects(archiveRelease({ version, verifySource: false }), /SemVer/u);
  }
});

async function git(directory, ...args) {
  await execFileAsync("git", ["-C", directory, ...args]);
}

async function releaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-docs-source-"));
  await git(directory, "init", "-q");
  await git(directory, "config", "user.email", "docs-tests@example.invalid");
  await git(directory, "config", "user.name", "Docs tests");
  await writeFile(join(directory, "source.txt"), "release source\n");
  await writeFile(join(directory, "package.json"), '{"version":"1.2.3"}\n');
  await git(directory, "add", "source.txt", "package.json");
  await git(directory, "commit", "-qm", "release source");
  const commit = (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
  await git(directory, "tag", "v1.2.3");
  return { directory, commit };
}

test("release archives reject overwrite and keep the first source", async () => {
  const history = await mkdtemp(join(tmpdir(), "sqlbraid-docs-history-"));
  const source = await mkdtemp(join(tmpdir(), "sqlbraid-docs-build-"));
  await writeFile(join(source, "index.html"), "first\n");
  await archiveRelease({ sourceDirectory: source, historyDirectory: history, version: "1.2.3", verifySource: false });
  await writeFile(join(source, "index.html"), "second\n");
  await assert.rejects(
    archiveRelease({ sourceDirectory: source, historyDirectory: history, version: "1.2.3", verifySource: false }),
    /cannot be overwritten/u,
  );
  assert.equal(await readFile(join(history, "v", "1.2.3", "index.html"), "utf8"), "first\n");
  assert.deepEqual((await readVersions(history)).versions, ["1.2.3"]);
  await archiveRelease({ sourceDirectory: source, historyDirectory: history, version: "1.2.2", verifySource: false });
  await archiveRelease({ sourceDirectory: source, historyDirectory: history, version: "1.3.0-rc.0", verifySource: false });
  assert.equal((await readVersions(history)).stable, "1.2.3");
  await rm(history, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
});

test("release archives require the exact tagged source commit", async () => {
  const source = await releaseFixture();
  const history = await mkdtemp(join(tmpdir(), "sqlbraid-docs-history-"));
  const build = await mkdtemp(join(tmpdir(), "sqlbraid-docs-build-"));
  await writeFile(join(build, "index.html"), "release\n");
  await assertReleaseSource({ rootDirectory: source.directory, version: "1.2.3", commit: source.commit, ref: "refs/tags/v1.2.3" });
  await assert.rejects(
    assertReleaseSource({ rootDirectory: source.directory, version: "1.2.3", commit: "0".repeat(40), ref: "refs/tags/v1.2.3" }),
    /exact commit/u,
  );
  await archiveRelease({ sourceDirectory: build, historyDirectory: history, version: "1.2.3", rootDirectory: source.directory, commit: source.commit, ref: "v1.2.3" });
  await writeFile(join(build, "index.html"), "a rebuild must not replace the published archive\n");
  await archiveRelease({ sourceDirectory: build, historyDirectory: history, version: "1.2.3", rootDirectory: source.directory, commit: source.commit, ref: "v1.2.3" });
  assert.equal(await readFile(join(history, "v", "1.2.3", "index.html"), "utf8"), "release\n");
  await git(source.directory, "tag", "v1.2.4");
  await assert.rejects(
    assertReleaseSource({ rootDirectory: source.directory, version: "1.2.4", commit: source.commit, ref: "v1.2.4" }),
    /differs from package version/u,
  );
  assert.equal((await readVersions(history)).stable, "1.2.3");
  await rm(source.directory, { recursive: true, force: true });
  await rm(history, { recursive: true, force: true });
  await rm(build, { recursive: true, force: true });
});

test("version routes preserve locale and fall back to the locale root", () => {
  const pages = {
    "0.1.0": { root: ["", "runtime/transactions"], ko: [""] },
  };
  assert.equal(routeForVersion({ version: "0.1.0", locale: "root", page: "runtime/transactions", pages }), "/SQLBraid/v/0.1.0/runtime/transactions/");
  assert.equal(routeForVersion({ version: "0.1.0", locale: "ko", page: "runtime/transactions", pages }), "/SQLBraid/v/0.1.0/ko/");
  assert.equal(/content="0;url=([^"]+)"/u.exec(rootRedirect(null))?.[1], "/SQLBraid/dev/");
  assert.equal(/content="0;url=([^"]+)"/u.exec(rootRedirect("0.1.0"))?.[1], "/SQLBraid/v/0.1.0/");
});
