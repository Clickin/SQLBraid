#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const consumer = mkdtempSync(join(tmpdir(), "sqlbraid-pnpm-isolated-"));
const packageDir = resolve(process.env.SQLBRAID_PACK_INPUT_DIR ?? join(root, ".compatibility-packages"));
const tarballs = new Map();
for (const file of readdirSync(packageDir))
  if (file.endsWith(".tgz")) {
    const path = join(packageDir, file);
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
    tarballs.set(manifest.name, `file:${path}`);
  }
for (const name of ["sqlbraid", "@sqlbraid/compiler", "@sqlbraid/vite"])
  if (!tarballs.has(name)) throw new Error(`Missing candidate tarball: ${name}`);
const dependencies = { sqlbraid: tarballs.get("sqlbraid") };
const devDependencies = {
  "@sqlbraid/compiler": tarballs.get("@sqlbraid/compiler"),
  "@sqlbraid/vite": tarballs.get("@sqlbraid/vite"),
  typescript: "5.9.3",
  vite: "8.3.0",
};
const overrides = Object.fromEntries(
  [...tarballs.entries()].filter(([name]) => name.startsWith("@sqlbraid/") || name === "sqlbraid"),
);
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify(
    { name: "sqlbraid-isolated-consumer", private: true, type: "module", dependencies, devDependencies },
    null,
    2,
  ),
);
writeFileSync(
  join(consumer, "pnpm-workspace.yaml"),
  `packages: []\noverrides:\n${Object.entries(overrides)
    .map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
    .join("\n")}\n`,
);
writeFileSync(join(consumer, ".npmrc"), "node-linker=isolated\nshamefully-hoist=false\npublic-hoist-pattern[]=\n");
writeFileSync(
  join(consumer, "src.ts"),
  [
    'import { sql } from "sqlbraid/sqlite";',
    "let calls = 0;",
    "export const query = sql.rows<{ value: number }>`SELECT [Bob's] WHERE id = ${1} /*@braid if ${(calls += 1, true)}*/ AND active = 1 /*@braid end*/`;",
    'export const schema = { "~standard": { version: 1 as const, vendor: "isolated-consumer", validate(value: unknown) { return { value: { value: String((value as { readonly value: number }).value) } }; } } };',
    "export const mapped = sql.rows(schema)`SELECT 1`;",
    "type MappedOutput = NonNullable<typeof mapped.__row>;",
    'export const mappedOutputTypeCheck: MappedOutput = { value: "mapped" };',
    "export const mappedSchemaIdentity = mapped.resultSchema === schema;",
    'export const mappedContent = schema["~standard"].validate({ value: 7 });',
    'export const lazy = sql`SELECT 1 /*@braid if ${false}*/ AND value = ${(() => { throw new Error("inactive branch evaluated"); })()} /*@braid end*/`;',
    "export const rendered = query.render();",
    "export const callsAfterRender = calls;",
  ].join("\n"),
);
writeFileSync(
  join(consumer, "vite.config.mjs"),
  `import { defineConfig } from "vite";\nimport sqlbraid from "@sqlbraid/vite";\nexport default defineConfig({ plugins: [sqlbraid()], build: { lib: { entry: "src.ts", formats: ["es"], fileName: "bundle" }, sourcemap: true } });\n`,
);
execFileSync("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], { cwd: consumer, stdio: "inherit" });
const resolutionProbe =
  "try { await import('sqlbraid/compiled'); } catch (error) { process.exitCode = 2; } try { await import('@sqlbraid/template'); process.exitCode = 3; } catch {}";
execFileSync(process.execPath, ["--input-type=module", "-e", resolutionProbe], { cwd: consumer, stdio: "inherit" });
execFileSync("pnpm", ["exec", "vite", "build"], { cwd: consumer, stdio: "inherit" });
execFileSync(
  "pnpm",
  [
    "exec",
    "tsc",
    "--noEmit",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--strict",
    "src.ts",
  ],
  { cwd: consumer, stdio: "inherit" },
);
const asset = readdirSync(join(consumer, "dist")).find((file) => file.endsWith(".js"));
if (!asset) throw new Error("Vite emitted no JavaScript asset.");
const built = readFileSync(join(consumer, "dist", asset), "utf8");
assert.match(built, /sourceMappingURL/u);
const sourceMap = JSON.parse(readFileSync(join(consumer, "dist", `${asset}.map`), "utf8"));
assert.ok(sourceMap.mappings, "Vite emitted no source mappings");
assert.ok(
  sourceMap.sources.some((source) => source.endsWith("src.ts")),
  "Vite source map lost the original TypeScript source",
);
const result = await import(`file://${join(consumer, "dist", asset)}`);
assert.deepEqual(
  result.rendered.parameters.map(({ value }) => value),
  [1],
);
assert.equal(result.callsAfterRender, 1, "active branch was not evaluated exactly once");
assert.equal(result.mappedSchemaIdentity, true, "result schema identity was not preserved");
assert.deepEqual(result.mappedContent, { value: { value: "7" } }, "mapped output content changed");
console.info(`PASS genuine pnpm isolated Vite consumer: ${consumer}`);
