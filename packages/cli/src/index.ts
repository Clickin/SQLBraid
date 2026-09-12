#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProject, checkSource, createVirtualOverlay, discoverQueries, emitSource, type TypeScriptCheckOptions } from "@sqlbraid/compiler";
import { createManifestFromEvidence, fingerprintTemplate, templateFamilyFingerprintOf } from "@sqlbraid/operations";
import { diffSnapshots, parseSnapshotJson, type SchemaSnapshot } from "@sqlbraid/schema";

function usage(): never {
  console.error("Usage: sqlbraid check|manifest|build --file <path> [--out-file <path>] | sqlbraid check --project <path> | sqlbraid drift --before <path> --after <path>");
  process.exit(2);
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function loadSnapshot(path: string | undefined): Promise<SchemaSnapshot | undefined> {
  if (!path) return undefined;
  return parseSnapshotJson(await readFile(path, "utf8"));
}

function diagnosticText(diagnostic: { readonly code: string; readonly message: string }): string {
  return `${diagnostic.code}: ${diagnostic.message}`;
}

function reportDiagnostics(diagnostics: readonly { readonly code: string; readonly message: string; readonly severity: string }[], json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(diagnostics)}\n`);
  else for (const diagnostic of diagnostics) console.error(diagnosticText(diagnostic));
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  const json = argv.includes("--json");
  const fileFlag = option(argv, "--file");
  const projectFlag = option(argv, "--project");
  if (!command || !["check", "manifest", "build", "drift"].includes(command)) usage();
  if (command === "drift") {
    const beforePath = option(argv, "--before");
    const afterPath = option(argv, "--after");
    if (!beforePath || !afterPath) usage();
    const before = await loadSnapshot(resolve(beforePath));
    const after = await loadSnapshot(resolve(afterPath));
    if (!before || !after) usage();
    const drift = diffSnapshots(before, after);
    process.stdout.write(`${JSON.stringify(drift, null, 2)}\n`);
    if (drift.length) process.exitCode = 1;
    return;
  }
  if (!fileFlag && !projectFlag) usage();
  if (projectFlag && command === "manifest") usage();
  if (projectFlag && command === "build") usage();
  const projectFile = projectFlag ? resolve(projectFlag) : undefined;
  const targetFile = fileFlag ? resolve(fileFlag) : undefined;
  if (!targetFile && projectFile && command !== "check") usage();
  const file = targetFile ?? projectFile;
  if (!file) usage();
  const source = targetFile ? await readFile(targetFile, "utf8") : "";
  const nodeTypes = resolve(process.cwd(), "node_modules/@types/node");
  const sqlbraidRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const sourcePackages = resolve(sqlbraidRoot, "packages");
  const sourcePaths = existsSync(resolve(sourcePackages, "cli/src/index.ts")) ? {
    "@sqlbraid/*": [resolve(sourcePackages, "*/src/index.ts")],
    "@sqlbraid/postgres/pg": [resolve(sourcePackages, "postgres/src/pg.ts")],
    "@sqlbraid/mysql/mysql2": [resolve(sourcePackages, "mysql/src/mysql2.ts")],
    "@sqlbraid/sqlite/node-sqlite": [resolve(sourcePackages, "sqlite/src/node-sqlite.ts")],
  } : undefined;
  const options: TypeScriptCheckOptions = {
    moduleSpecifiers: ["@sqlbraid/template", "@sqlbraid/postgres", "@sqlbraid/mysql", "@sqlbraid/sqlite"],
    compilerOptions: {
      baseUrl: process.cwd(),
      ...(existsSync(nodeTypes) ? { types: ["node"], typeRoots: [resolve(process.cwd(), "node_modules/@types")] } : {}),
      ...(sourcePaths ? { paths: sourcePaths } : {}),
    },
  };
  const discovered = targetFile ? discoverQueries(source, file, options) : { queries: [], diagnostics: [] };
  const diagnostics = command === "check" && projectFile ? checkProject(projectFile, options) : command === "check" || command === "build" ? checkSource(source, file, options) : createVirtualOverlay(source, file, options).diagnostics;
  reportDiagnostics(diagnostics, json);
  if (command === "check") {
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) process.exitCode = 1;
    return;
  }
  if (command === "build") {
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) { process.exitCode = 1; return; }
    const emitted = emitSource(source, file, options);
    reportDiagnostics(emitted.diagnostics, json);
    if (emitted.diagnostics.some((diagnostic) => diagnostic.severity === "error")) { process.exitCode = 1; return; }
    const requested = option(argv, "--out-file");
    const outputFile = resolve(requested ?? `${file.slice(0, -extname(file).length)}.js`);
    await mkdir(dirname(outputFile), { recursive: true });
    let outputText = emitted.outputText;
    if (emitted.sourceMapText) {
      const map: { file: string; sources: string[] } = JSON.parse(emitted.sourceMapText);
      map.file = basename(outputFile);
      map.sources = map.sources.map((source) => relative(dirname(outputFile), resolve(dirname(file), source)).replaceAll("\\", "/"));
      outputText = outputText.replace(/\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/u, `//# sourceMappingURL=${encodeURIComponent(map.file)}.map\n`);
      await writeFile(`${outputFile}.map`, JSON.stringify(map), "utf8");
    }
    await writeFile(outputFile, outputText, "utf8");
    return;
  }
  const overlay = createVirtualOverlay(source, file, options);
  const manifests = discovered.queries.map((query) => {
    const captured = new Array<unknown>(Math.max(0, query.bindings.length)).fill(null);
    const contract = overlay.queryTypes.find((candidate) => candidate.range.start === query.range.start);
    return createManifestFromEvidence({ fingerprint: fingerprintTemplate(query.ir, captured), templateFamilyFingerprint: templateFamilyFingerprintOf(query.ir), resultKind: query.declaredResultKind, source: relative(process.cwd(), file), ...(contract?.rowType && contract.rowType !== "unknown" ? { resultType: contract.rowType } : {}) });
  });
  process.stdout.write(`${JSON.stringify(manifests, null, 2)}\n`);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) process.exitCode = 1;
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
