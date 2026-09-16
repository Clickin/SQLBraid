#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const consumer = mkdtempSync(join(tmpdir(), "sqlbraid-pnpm-isolated-"));
const packageDir = resolve(process.env.SQLBRAID_PACK_INPUT_DIR ?? join(root, ".compatibility-packages"));
const tarballs = new Map();
for (const file of readdirSync(packageDir)) if (file.endsWith(".tgz")) {
  const path = join(packageDir, file);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
  tarballs.set(manifest.name, `file:${path}`);
}
for (const name of ["sqlbraid", "@sqlbraid/compiler", "@sqlbraid/vite"]) if (!tarballs.has(name)) throw new Error(`Missing candidate tarball: ${name}`);
const dependencies = { sqlbraid: tarballs.get("sqlbraid") };
const devDependencies = {
  "@sqlbraid/compiler": tarballs.get("@sqlbraid/compiler"),
  "@sqlbraid/vite": tarballs.get("@sqlbraid/vite"),
  typescript: "5.9.3",
  vite: "8.3.0",
};
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "sqlbraid-isolated-consumer", private: true, type: "module", dependencies, devDependencies }, null, 2));
writeFileSync(join(consumer, "pnpm-workspace.yaml"), "packages: []\n");
writeFileSync(join(consumer, "index.html"), "<script type=module src=\"/src.ts\"></script>\n");
writeFileSync(join(consumer, "src.ts"), [
  'import { sql } from "sqlbraid/tedious";',
  'let calls = 0;',
  'export const query = sql.rows<{ value: number }>`SELECT [Bob\'s] WHERE id = ${1} /*@braid if ${(calls += 1, false)}*/ AND active = 1 /*@braid end*/`;',
  'export const rendered = query.render();',
  'export const callsAfterRender = calls;',
].join("\n"));
writeFileSync(join(consumer, "vite.config.mjs"), `import { defineConfig } from "vite";\nimport sqlbraid from "@sqlbraid/vite";\nexport default defineConfig({ plugins: [sqlbraid()] });\n`);
execFileSync("pnpm", ["install", "--config.node-linker=isolated", "--config.shamefully-hoist=false", "--ignore-scripts", "--no-frozen-lockfile"], { cwd: consumer, stdio: "inherit" });
const nodeModules = readdirSync(join(consumer, "node_modules"));
assert.deepEqual(nodeModules.includes("@sqlbraid"), true);
assert.equal(nodeModules.includes("@sqlbraid/template"), false, "template must remain transitive in isolated app");
execFileSync("pnpm", ["exec", "vite", "build"], { cwd: consumer, stdio: "inherit" });
const asset = readdirSync(join(consumer, "dist/assets")).find((file) => file.endsWith(".js"));
if (!asset) throw new Error("Vite emitted no JavaScript asset.");
const built = readFileSync(join(consumer, "dist/assets", asset), "utf8");
assert.match(built, /sourceMappingURL/u);
const result = await import(`file://${join(consumer, "dist/assets", asset)}`);
assert.deepEqual(result.rendered.parameters.map(({ value }) => value), [1]);
assert.equal(result.callsAfterRender, 0, "inactive branch evaluated eagerly");
console.info(`PASS genuine pnpm isolated Vite consumer: ${consumer}`);
