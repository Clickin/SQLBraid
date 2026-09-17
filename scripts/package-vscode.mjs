#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages");
const extensionRoot = join(root, "extensions", "vscode");
const preRelease = process.argv.includes("--pre-release") || process.env.SQLBRAID_VSIX_PRE_RELEASE === "true";
const outOptionIndex = process.argv.indexOf("--out");
const output = resolve(
  outOptionIndex >= 0
    ? process.argv[outOptionIndex + 1]
    : (process.env.SQLBRAID_VSIX_OUTPUT ?? join(root, "sqlbraid-vscode.vsix")),
);
const temp = await mkdtemp(join(tmpdir(), "sqlbraid-vscode-package-"));

function packageDirectory(name) {
  if (!name.startsWith("@sqlbraid/")) throw new Error(`Not a first-party SQLBraid package: ${name}`);
  return join(packageRoot, name.slice("@sqlbraid/".length));
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function run(command, args, cwd = root) {
  return execFile(command, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function numericExtensionVersion(version) {
  const parts = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(version)?.slice(1).map(Number);
  return (
    parts?.length === 3 &&
    parts.some((value) => value !== 0) &&
    parts.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647)
  );
}

async function packFirstParty(name, tarballs) {
  if (tarballs.has(name)) return;
  const directory = packageDirectory(name);
  const manifest = await json(join(directory, "package.json"));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@sqlbraid/")) await packFirstParty(dependency, tarballs);
  }
  const destination = join(temp, "packages");
  await mkdir(destination, { recursive: true });
  const before = new Set(await readdir(destination));
  await run("pnpm", ["pack", "--pack-destination", destination], directory);
  const added = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz") && !before.has(entry));
  if (added.length !== 1) throw new Error(`Expected one tarball for ${name}; found ${added.length}.`);
  tarballs.set(name, join(destination, added[0]));
}

try {
  if (outOptionIndex >= 0 && !process.argv[outOptionIndex + 1]) throw new Error("--out requires a path.");
  const extensionManifest = await json(join(extensionRoot, "package.json"));
  if (!numericExtensionVersion(extensionManifest.version)) {
    throw new Error(`VS Code extension version must be numeric major.minor.patch; found ${extensionManifest.version}.`);
  }

  const extensionDependencies = Object.fromEntries(
    Object.entries(extensionManifest.dependencies ?? {}).map(([name, specifier]) => [
      name,
      typeof specifier === "string" ? specifier.replace(/^workspace:/u, "") : specifier,
    ]),
  );
  const firstPartyRoots = Object.keys(extensionDependencies).filter((name) => name.startsWith("@sqlbraid/"));
  for (const required of ["@sqlbraid/cli", "@sqlbraid/language-server"]) {
    if (!firstPartyRoots.includes(required)) throw new Error(`VS Code extension must depend on ${required}.`);
    const manifest = await json(join(packageDirectory(required), "package.json"));
    assert.equal(
      extensionDependencies[required],
      manifest.version,
      `${required} dependency must match the bundled source version.`,
    );
  }

  const tarballs = new Map();
  for (const name of firstPartyRoots) await packFirstParty(name, tarballs);

  const extension = join(temp, "extension");
  await mkdir(extension);
  await cp(join(extensionRoot, "dist"), join(extension, "dist"), { recursive: true });
  await copyFile(join(extensionRoot, "README.md"), join(extension, "README.md"));
  await copyFile(join(root, "LICENSE"), join(extension, "LICENSE"));
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      ...extensionManifest,
      devDependencies: {},
      dependencies: {
        ...extensionDependencies,
        ...Object.fromEntries([...tarballs].map(([name, path]) => [name, `file:${path}`])),
      },
    }),
  );
  await run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], extension);
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({ ...extensionManifest, devDependencies: {}, dependencies: extensionDependencies }),
  );
  await rm(join(extension, "package-lock.json"), { force: true });

  const packaged = join(temp, basename(output));
  const packageArgs = ["package", "--no-yarn"];
  if (preRelease) packageArgs.push("--pre-release");
  packageArgs.push("--out", packaged);
  await run(join(root, "node_modules", ".bin", "vsce"), packageArgs, extension);

  const { stdout: listing } = await run("unzip", ["-Z1", packaged]);
  const files = new Set(listing.trim().split("\n"));
  for (const file of [
    "readme.md",
    extensionManifest.main.replace(/^\.\//u, ""),
    "node_modules/@sqlbraid/language-server/dist/cli.js",
    "node_modules/@sqlbraid/cli/dist/index.js",
  ]) {
    if (!files.has(`extension/${file}`)) throw new Error(`VSIX omits ${file}.`);
  }
  const licensePath = [...files].find((file) => /^extension\/license(?:\.(?:txt|md))?$/iu.test(file));
  assert.ok(licensePath, "VSIX must include its license document.");
  const { stdout: license } = await run("unzip", ["-p", packaged, licensePath]);
  assert.equal(
    license,
    await readFile(join(root, "LICENSE"), "utf8"),
    "VSIX must ship the repository Apache-2.0 license.",
  );

  const readVsixJson = async (path) => JSON.parse((await run("unzip", ["-p", packaged, path])).stdout);
  const packagedManifest = await readVsixJson("extension/package.json");
  assert.equal(packagedManifest.name, extensionManifest.name, "VSIX extension name must match source.");
  assert.equal(packagedManifest.publisher, extensionManifest.publisher, "VSIX publisher must match source.");
  assert.equal(packagedManifest.version, extensionManifest.version, "VSIX version must match source.");
  for (const name of ["@sqlbraid/cli", "@sqlbraid/language-server"]) {
    const expected = await json(join(packageDirectory(name), "package.json"));
    const bundled = await readVsixJson(`extension/node_modules/${name}/package.json`);
    assert.equal(bundled.name, name, `VSIX must bundle ${name}.`);
    assert.equal(bundled.version, expected.version, `VSIX must bundle the current ${name} version.`);
  }

  await mkdir(dirname(output), { recursive: true });
  await copyFile(packaged, output);
  await run("pnpm", ["--dir", extensionRoot, "run", "compile-tests"]);
  const previousVsix = process.env.SQLBRAID_VSIX_PATH;
  process.env.SQLBRAID_VSIX_PATH = output;
  try {
    await run(process.execPath, [join(root, "scripts", "test-vscode.mjs")]);
  } finally {
    if (previousVsix === undefined) delete process.env.SQLBRAID_VSIX_PATH;
    else process.env.SQLBRAID_VSIX_PATH = previousVsix;
  }

  const identity = {
    name: packagedManifest.name,
    publisher: packagedManifest.publisher,
    version: packagedManifest.version,
    preRelease,
    file: basename(output),
    sha256: await sha256(output),
    bundled: Object.fromEntries(
      await Promise.all(
        ["@sqlbraid/cli", "@sqlbraid/language-server"].map(async (name) => [
          name,
          (await json(join(packageDirectory(name), "package.json"))).version,
        ]),
      ),
    ),
  };
  process.stdout.write(`${JSON.stringify(identity)}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
