#!/usr/bin/env node
import { builtinModules } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = join(root, "tests");
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const testsManifest = JSON.parse(await readFile(join(testsRoot, "package.json"), "utf8"));
const rootDependencies = new Set(Object.keys({ ...rootManifest.dependencies, ...rootManifest.devDependencies }));
const testsDependencies = new Set(Object.keys({
  ...testsManifest.dependencies,
  ...testsManifest.devDependencies,
  ...testsManifest.peerDependencies,
}));
const stableRootDependencies = new Set([
  "@sqlbraid/bun-sql", "@sqlbraid/core", "@sqlbraid/mariadb", "@sqlbraid/mssql", "@sqlbraid/mysql",
  "@sqlbraid/oracle", "@sqlbraid/postgres", "@sqlbraid/runtime", "@sqlbraid/sqlite", "@sqlbraid/template",
  "@sqlite.org/sqlite-wasm",
  "miniflare", "playwright", "vite",
]);
const forbiddenRootDependencies = new Set([
  "@jridgewell/trace-mapping", "@libsql/client", "@opentelemetry/api", "@opentelemetry/context-async-hooks",
  "@opentelemetry/sdk-metrics", "@opentelemetry/sdk-trace-base", "@standard-schema/spec",
  "@testcontainers/mysql", "@testcontainers/postgresql", "@types/oracledb", "@types/pg", "better-sqlite3", "mariadb",
  "mysql2", "oracledb", "pg", "pg-cursor", "tedious", "testcontainers", "valibot", "yaml", "zod",
  "@sqlbraid/cli", "@sqlbraid/codegen", "@sqlbraid/compiler", "@sqlbraid/language-server", "@sqlbraid/metadata",
  "@sqlbraid/opentelemetry", "@sqlbraid/operations", "@sqlbraid/tooling", "@sqlbraid/vite",
]);
const movedScripts = [
  "agent-tooling-consumer.mjs", "audit-runtime.mjs", "bulk-execution-benchmark.mjs", "bun-sql-matrix.mjs",
  "isolated-facade-consumer.mjs", "isolated-lsp-consumer.mjs", "otel-api-consumer.mjs", "runtime-compatibility-consumer.mjs",
  "runtime-driver-smoke.mjs", "runtime-packed-five-db.mjs", "runtime-portability.mjs", "runtime-smoke.mjs",
  "sync-boundary-benchmark.mjs", "test-examples.mjs", "test-tanstack-start.mjs", "validate-packages.mjs",
  "value-fidelity-benchmark.mjs",
];
const builtin = new Set(["bun", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
function importSpecifiers(path, source) {
  const scriptKind = /\.(?:ts|mts|cts)$/u.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports;
}

function packageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || specifier.startsWith("#") || builtin.has(specifier)) return undefined;
  return specifier.startsWith("@") ? specifier.split("/", 2).join("/") : specifier.split("/", 1)[0];
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && /\.(?:[cm]?js|ts|mts|cts)$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const rootLeaks = [...forbiddenRootDependencies].filter((name) => rootDependencies.has(name) && !stableRootDependencies.has(name));
if (rootLeaks.length) throw new Error(`Forbidden test-only root dependencies: ${rootLeaks.sort().join(", ")}`);
for (const script of movedScripts) {
  if (rootDependencies.has(script)) throw new Error(`Script name leaked into root dependencies: ${script}`);
  const oldPath = join(root, "scripts", script);
  const newPath = join(testsRoot, "scripts", script);
  try {
    await readFile(newPath);
  } catch {
    throw new Error(`Moved integration script is missing: ${newPath}`);
  }
  try {
    await readFile(oldPath);
    throw new Error(`Obsolete integration script remains at ${oldPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const testFiles = (await sourceFiles(testsRoot)).filter((path) => !path.startsWith(`${testsRoot}/fixtures/`));
const testImports = new Set();
for (const path of testFiles) {
  const source = await readFile(path, "utf8");
  for (const specifier of importSpecifiers(path, source)) {
    const name = packageName(specifier);
    if (name && name !== "sqlbraid") testImports.add(name);
  }
}
const missingTests = [...testImports].filter((name) => !testsDependencies.has(name));
if (missingTests.length) throw new Error(`Tests package does not declare imported dependencies: ${missingTests.sort().join(", ")}`);

for (const packageDirectory of (await readdir(join(root, "packages"), { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
  const packageRoot = join(root, "packages", packageDirectory.name);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const declared = new Set(Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  }));
  const imports = new Set();
  for (const path of await sourceFiles(join(packageRoot, "src"))) {
    const source = await readFile(path, "utf8");
    for (const specifier of importSpecifiers(path, source)) {
      const name = packageName(specifier);
      if (name && name !== manifest.name) imports.add(name);
    }
  }
  const missing = [...imports].filter((name) => !declared.has(name));
  if (missing.length) throw new Error(`${manifest.name} source imports undeclared packages: ${missing.sort().join(", ")}`);
}

for (const name of [...testImports].filter((name) => testsDependencies.has(name)).sort()) {
  const manifestPath = join(testsRoot, "node_modules", ...name.split("/"), "package.json");
  try {
    await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`Tests package cannot resolve ${name}: ${error.message}`);
  }
}
for (const script of ["isolated-facade-consumer.mjs", "isolated-lsp-consumer.mjs"]) {
  const source = await readFile(join(testsRoot, "scripts", script), "utf8");
  if (!source.includes("node-linker=isolated") || !source.includes("public-hoist-pattern[]=")) {
    throw new Error(`${script} must install with isolated pnpm resolution and no public hoist.`);
  }
}
console.info(`PASS dependency ownership: ${testImports.size} test imports, ${movedScripts.length} moved scripts, ${rootLeaks.length} forbidden root dependencies, package imports declared.`);
