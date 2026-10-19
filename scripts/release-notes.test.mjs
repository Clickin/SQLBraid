import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVersions,
  diffManifest,
  groupCommits,
  parseReleaseTag,
  renderNotes,
  selectPreviousTag,
} from "./release-notes.mjs";

test("tags select the facade or a scoped package", () => {
  assert.deepEqual(parseReleaseTag("v2.0.0"), { slug: "sqlbraid", version: "2.0.0" });
  assert.deepEqual(parseReleaseTag("language-server-v1.0.4"), { slug: "language-server", version: "1.0.4" });
  assert.throws(() => parseReleaseTag("release-2.0.0"), /not v<version>/u);
});

test("version order puts a prerelease before its release and compares numerically", () => {
  assert.ok(compareVersions("1.0.0-rc.2", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-rc.10", "1.0.0-rc.2") > 0);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
});

test("the previous tag stays in the same package and skips prereleases for a stable release", () => {
  const tags = ["v1.0.0-rc.2", "v1.0.0", "v1.0.2", "core-v1.0.4", "v2.0.0", "v2.0.0-rc.1"];
  assert.equal(selectPreviousTag(tags, "v2.0.0"), "v1.0.2");
  assert.equal(selectPreviousTag(tags, "v2.0.0-rc.2"), "v2.0.0-rc.1");
  assert.equal(selectPreviousTag(tags, "core-v1.0.5"), "core-v1.0.4");
  assert.equal(selectPreviousTag(tags, "mysql-v1.0.0"), undefined);
});

test("the manifest diff reports dependency, engine and export changes", () => {
  const before = { dependencies: { a: "1", b: "1" }, exports: { ".": { import: "./a.js" }, "./old": "./o.js" } };
  const after = { dependencies: { a: "2", c: "1" }, exports: { ".": { import: "./a.js" } } };
  assert.deepEqual(
    diffManifest(before, after).map(({ key }) => key),
    ["dependencies.a", "dependencies.b", "dependencies.c", 'exports["./old"]'],
  );
  assert.deepEqual(diffManifest(before, before), []);
});

test("commits group by conventional type and breaking marks come first", () => {
  const groups = groupCommits([
    { sha: "aaaaaaaa", subject: "feat!: separate dialect packages" },
    { sha: "bbbbbbbb", subject: "fix(bun-sql): report SQLite as not reused" },
    { sha: "cccccccc", subject: "added an example" },
  ]);
  assert.deepEqual(
    groups.map(([title]) => title),
    ["Breaking changes", "Fixes", "Other"],
  );
  assert.match(groups[1][1][0], /\*\*bun-sql\*\*: report SQLite as not reused \(bbbbbbb\)/u);
});

test("the notes keep the changelog text and add install and diff sections", () => {
  const notes = renderNotes({
    tag: "v2.0.0",
    packageName: "sqlbraid",
    version: "2.0.0",
    previousTag: "v1.0.2",
    repo: "Clickin/SQLBraid",
    message: "Breaking text.",
    manifestDiff: [],
    commits: [],
  });
  assert.match(notes, /^Breaking text\./u);
  assert.match(notes, /pnpm add sqlbraid@2\.0\.0/u);
  assert.match(notes, /compare\/v1\.0\.2\.\.\.v2\.0\.0/u);
});
