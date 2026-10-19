// Creates the annotated release tag for one package at HEAD. It does not push.
// Usage: pnpm release:tag <package> [version]   (for example: pnpm release:tag postgres)
// The tag message is the release summary. CI adds the install command and the diff since the previous tag.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseTag, selectPreviousTag } from "./release-notes.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const [selector, requested] = process.argv.slice(2);
if (!selector) {
  process.stderr.write("Usage: pnpm release:tag <package> [version]\n");
  process.exit(2);
}
const slug = selector.replace(/^@sqlbraid\//u, "");
const name = slug === "sqlbraid" ? "sqlbraid" : `@sqlbraid/${slug}`;
const directory = git("ls-files", "packages/*/package.json")
  .split("\n")
  .find((path) => JSON.parse(readFileSync(path, "utf8")).name === name);
if (!directory) {
  process.stderr.write(`No package named ${name}.\n`);
  process.exit(2);
}
const version = requested ?? JSON.parse(readFileSync(directory, "utf8")).version;
const tag = slug === "sqlbraid" ? `v${version}` : `${slug}-v${version}`;
parseReleaseTag(tag);
if (git("status", "--porcelain")) {
  process.stderr.write("The working tree is not clean. Commit the release commit first.\n");
  process.exit(1);
}
const previous = selectPreviousTag(git("tag", "--list").split("\n"), tag);
const directoryName = mkdtempSync(join(tmpdir(), "sqlbraid-release-tag-"));
try {
  const file = join(directoryName, "message.txt");
  writeFileSync(
    file,
    [
      "",
      "",
      "# Write the release summary above: what changed for users, and what they must do for a breaking change.",
      "# Lines that start with # are removed. CI adds the install command, the package interface diff",
      `# and the commits${previous ? ` since ${previous}` : ""}.`,
      "",
    ].join("\n"),
  );
  const result = spawnSync("git", ["tag", "-a", "-e", "-F", file, tag], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
} finally {
  rmSync(directoryName, { recursive: true, force: true });
}
process.stdout.write(
  `Created ${tag} at ${git("rev-parse", "--short", "HEAD")}. Push it with: git push origin ${tag}\n`,
);
