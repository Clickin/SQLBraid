import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  archiveRelease,
  assertReleaseSource,
  isSemVer,
  readVersions,
  rewriteLegacyBaseLinks,
  rootRedirect,
  stageDeployment,
  syncLatest,
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
    latest: { root: ["", "runtime/transactions"], ko: [""] },
    "0.1.0": { root: ["", "runtime/transactions"], ko: [""] },
  };
  assert.equal(routeForVersion({ version: "latest", locale: "root", page: "runtime/transactions", pages }), "/SQLBraid/latest/runtime/transactions/");
  assert.equal(routeForVersion({ version: "latest", locale: "ko", page: "runtime/transactions", pages }), "/SQLBraid/latest/ko/");
  assert.equal(routeForVersion({ version: "0.1.0", locale: "root", page: "runtime/transactions", pages }), "/SQLBraid/v/0.1.0/runtime/transactions/");
  assert.equal(routeForVersion({ version: "0.1.0", locale: "ko", page: "runtime/transactions", pages }), "/SQLBraid/v/0.1.0/ko/");
  assert.equal(/content="0;url=([^"]+)"/u.exec(rootRedirect(null))?.[1], "/SQLBraid/latest/");
  assert.equal(/content="0;url=([^"]+)"/u.exec(rootRedirect("0.1.0"))?.[1], "/SQLBraid/v/0.1.0/");
});

test("latest sync replaces only the mutable channel while staging keeps archives", async () => {
  const history = await mkdtemp(join(tmpdir(), "sqlbraid-docs-history-"));
  const latest = await mkdtemp(join(tmpdir(), "sqlbraid-docs-latest-"));
  const release = await mkdtemp(join(tmpdir(), "sqlbraid-docs-release-"));
  const output = await mkdtemp(join(tmpdir(), "sqlbraid-docs-deploy-"));
  try {
    await writeFile(join(latest, "index.html"), "latest one\n");
    await writeFile(join(release, "index.html"), "immutable release\n");
    await archiveRelease({ sourceDirectory: release, historyDirectory: history, version: "1.2.3", verifySource: false });
    await syncLatest({ sourceDirectory: latest, historyDirectory: history });
    await writeFile(join(latest, "index.html"), "latest two\n");
    await syncLatest({ sourceDirectory: latest, historyDirectory: history });
    const staged = await stageDeployment({ historyDirectory: history, outputDirectory: output });
    assert.equal(await readFile(join(output, "latest", "index.html"), "utf8"), "latest two\n");
    assert.equal(await readFile(join(output, "v", "1.2.3", "index.html"), "utf8"), "immutable release\n");
    assert.deepEqual(staged.pages.latest.root, [""]);
    assert.deepEqual(staged.pages["1.2.3"].root, [""]);
    assert.equal(/content="0;url=([^"]+)"/u.exec(await readFile(join(output, "index.html"), "utf8"))?.[1], "/SQLBraid/v/1.2.3/");
  } finally {
    await rm(history, { recursive: true, force: true });
    await rm(latest, { recursive: true, force: true });
    await rm(release, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test("staging migrates the legacy development tree to latest", async () => {
  const history = await mkdtemp(join(tmpdir(), "sqlbraid-docs-history-"));
  const output = await mkdtemp(join(tmpdir(), "sqlbraid-docs-deploy-"));
  try {
    await mkdir(join(history, "dev", "_astro"), { recursive: true });
    await writeFile(join(history, "dev", "index.html"), '<script src="/SQLBraid/dev/_astro/app.js"></script>');
    await writeFile(join(history, "dev", "_astro", "app.js"), 'new Worker("/SQLBraid/dev/_astro/worker.js")');
    await writeFile(join(history, "versions.json"), `${JSON.stringify({
      stable: null,
      versions: [],
      pages: { dev: { root: [""] } },
    })}\n`);
    const staged = await stageDeployment({ historyDirectory: history, outputDirectory: output });
    assert.equal(await readFile(join(output, "latest", "index.html"), "utf8"), '<script src="/SQLBraid/latest/_astro/app.js"></script>');
    assert.equal(await readFile(join(output, "latest", "_astro", "app.js"), "utf8"), 'new Worker("/SQLBraid/latest/_astro/worker.js")');
    assert.deepEqual(staged.pages.latest.root, [""]);
    assert.equal(staged.pages.dev, undefined);
    assert.match(await readFile(join(output, "index.html"), "utf8"), /\/SQLBraid\/latest\//u);
  } finally {
    await rm(history, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test("legacy links migrate both development and unversioned targets", async () => {
  const output = await mkdtemp(join(tmpdir(), "sqlbraid-docs-links-"));
  try {
    await writeFile(join(output, "index.html"), '<a href="/SQLBraid/dev/getting-started/">dev</a><script src="/SQLBraid/dev/_astro/app.js"></script><a href="https://clickin.github.io/SQLBraid/reference/">root</a><a href="/SQLBraid/v/0.1.0/">release</a>\n');
    await rewriteLegacyBaseLinks(output, "/SQLBraid/v/1.2.3");
    const html = await readFile(join(output, "index.html"), "utf8");
    assert.match(html, /href="\/SQLBraid\/v\/1\.2\.3\/getting-started\/"/u);
    assert.match(html, /src="\/SQLBraid\/v\/1\.2\.3\/_astro\/app\.js"/u);
    assert.match(html, /href="https:\/\/clickin\.github\.io\/SQLBraid\/v\/1\.2\.3\/reference\/"/u);
    assert.match(html, /href="\/SQLBraid\/v\/0\.1\.0\/"/u);
    await mkdir(join(output, "ko"), { recursive: true });
    await writeFile(join(output, "ko", "index.html"), '<link href="/SQLBraid/dev/_astro/site.css"><a href="/SQLBraid/dev/ko/concepts/">guide</a><a href="/SQLBraid/reference/">guide</a>');
    await rewriteLegacyBaseLinks(output, "/SQLBraid/v/1.2.3");
    const korean = await readFile(join(output, "ko", "index.html"), "utf8");
    assert.match(korean, /href="\/SQLBraid\/v\/1\.2\.3\/_astro\/site\.css"/u);
    assert.match(korean, /href="\/SQLBraid\/v\/1\.2\.3\/ko\/concepts\/"/u);
    assert.match(korean, /href="\/SQLBraid\/v\/1\.2\.3\/ko\/reference\/"/u);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
