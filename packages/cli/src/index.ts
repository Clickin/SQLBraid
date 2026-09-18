#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { generateModels, type CodegenDiagnostic } from "@sqlbraid/codegen";
import {
  checkProject,
  checkSource,
  createSourceContext,
  createVirtualOverlay,
  discoverQueries,
  emitSource,
  type TypeScriptCheckOptions,
} from "@sqlbraid/compiler";
import { createManifestFromEvidence, fingerprintTemplate, templateFamilyFingerprintOf } from "@sqlbraid/operations";
import { diffSnapshots, parseSnapshotJson, type MetadataSnapshot } from "@sqlbraid/metadata";
import {
  CONFIG_NAMES,
  ConfigurationError,
  createWorkspace,
  loadConfig,
  type CodegenTargetConfig,
} from "@sqlbraid/tooling";
import { codegenOutputCollisionKey } from "./codegen-path.js";

function usage(): never {
  console.error(
    "Usage: sqlbraid check|manifest|build --file <path> [--out-file <path>] | sqlbraid check --project <path> | sqlbraid drift --before <path> --after <path> | sqlbraid codegen [--config <path>] [--target <name>]... [--check] [--json] | sqlbraid inspect query --file <path> --line <n> --column <n> [--config <path>] [--json] | sqlbraid inspect symbol <name> [--config <path>] [--json] | sqlbraid inspect diagnostics --file <path> [--config <path>] [--json]\nOptions: --help, --version",
  );
  process.exit(2);
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function options(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1)
    if (argv[index] === name) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage();
      values.push(value);
      index += 1;
    }
  return values;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

async function loadMetadata(path: string | undefined): Promise<MetadataSnapshot | undefined> {
  if (!path) return undefined;
  return parseSnapshotJson(await readFile(path, "utf8"));
}

type CodegenStatus = "written" | "unchanged" | "stale" | "missing" | "error";

interface CodegenCliTargetResult {
  readonly target: string;
  readonly metadata: string;
  readonly outFile: string;
  status: CodegenStatus;
  readonly metadataHash?: string;
  readonly typePolicyId?: string;
  readonly typePolicyHash?: string;
  readonly optionsHash?: string;
  diagnostics: readonly CodegenDiagnostic[];
}

interface PreparedCodegenTarget {
  readonly target: CodegenTargetConfig;
  readonly metadataPath: string;
  readonly outputPath: string;
  readonly source?: string;
  readonly current?: string;
  readonly result: CodegenCliTargetResult;
}

function displayPath(path: string): string {
  const value = relative(process.cwd(), path).replaceAll("\\", "/");
  return value || ".";
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function metadataDiagnostic(error: unknown): CodegenDiagnostic {
  return {
    code: "CODEGEN_METADATA_INVALID",
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function prepareCodegenTarget(
  target: CodegenTargetConfig,
  configDirectory: string,
): Promise<PreparedCodegenTarget> {
  const metadataPath = resolve(configDirectory, target.metadata);
  const outputPath = resolve(configDirectory, target.outFile);
  try {
    const metadata = parseSnapshotJson(await readFile(metadataPath, "utf8"));
    const generated = generateModels(metadata, {
      typePolicy: target.typePolicy,
      filters: target.filters,
      naming: target.naming,
      typeOverrides: target.typeOverrides,
    });
    const diagnostics = generated.diagnostics;
    let current: string | undefined;
    try {
      current = await readFile(outputPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const status: CodegenStatus = diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? "error"
      : current === undefined
        ? "missing"
        : current === generated.source
          ? "unchanged"
          : "stale";
    return {
      target,
      metadataPath,
      outputPath,
      source: generated.source,
      current,
      result: {
        target: target.name,
        metadata: displayPath(metadataPath),
        outFile: displayPath(outputPath),
        status,
        metadataHash: generated.metadataHash,
        typePolicyId: generated.typePolicyId,
        typePolicyHash: generated.typePolicyHash,
        optionsHash: generated.optionsHash,
        diagnostics,
      },
    };
  } catch (error) {
    const diagnostics = [metadataDiagnostic(error)];
    return {
      target,
      metadataPath,
      outputPath,
      result: {
        target: target.name,
        metadata: displayPath(metadataPath),
        outFile: displayPath(outputPath),
        status: "error",
        diagnostics,
      },
    };
  }
}

async function atomicWrite(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function reportCodegen(results: readonly CodegenCliTargetResult[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  for (const result of results) console.log(`${result.target.padEnd(12)} ${result.status.padEnd(9)} ${result.outFile}`);
  for (const result of results)
    for (const diagnostic of result.diagnostics) {
      const location = [diagnostic.relation, diagnostic.column].filter(Boolean).join(".");
      console.error(`${result.target} ${diagnostic.code}${location ? ` ${location}` : ""}: ${diagnostic.message}`);
    }
}

async function runCodegen(argv: readonly string[], json: boolean): Promise<void> {
  const loaded = await loadConfig(option(argv, "--config"));
  const targets = loaded.config.codegen?.targets;
  if (!targets) throw new CliError("Configuration must define codegen.targets.", 2);
  const requested = options(argv, "--target");
  const requestedSet = new Set(requested);
  for (const name of requested)
    if (!targets.some((target) => target.name === name)) throw new CliError(`Unknown codegen target: ${name}.`, 2);
  const selected = targets
    .filter((target) => requestedSet.size === 0 || requestedSet.has(target.name))
    // eslint-disable-next-line unicorn/no-array-sort -- Sort the owned filter result without allocating a second array.
    .sort((left, right) => compareNames(left.name, right.name));
  const check = argv.includes("--check");
  const prepared = await Promise.all(selected.map((target) => prepareCodegenTarget(target, loaded.directory)));
  const paths = new Map<string, PreparedCodegenTarget>();
  let configurationError = false;
  for (const item of prepared) {
    const prior = paths.get(codegenOutputCollisionKey(item.outputPath));
    if (prior) {
      configurationError = true;
      const message = `Output path collides with target ${prior.target.name}.`;
      item.result.status = "error";
      item.result.diagnostics = [
        ...item.result.diagnostics,
        { code: "CODEGEN_OUTPUT_PATH_COLLISION", severity: "error", message },
      ];
      prior.result.status = "error";
      prior.result.diagnostics = [
        ...prior.result.diagnostics,
        {
          code: "CODEGEN_OUTPUT_PATH_COLLISION",
          severity: "error",
          message: `Output path collides with target ${item.target.name}.`,
        },
      ];
    } else paths.set(codegenOutputCollisionKey(item.outputPath), item);
  }
  const hasGenerationError = prepared.some((item) => item.result.status === "error");
  if (!check && !configurationError && !hasGenerationError) {
    for (const item of prepared) {
      if (item.result.status !== "stale" && item.result.status !== "missing") continue;
      if (item.source === undefined) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- Stop writing subsequent targets after the first failed atomic write.
        await atomicWrite(item.outputPath, item.source);
        item.result.status = "written";
      } catch (error) {
        item.result.status = "error";
        item.result.diagnostics = [
          ...item.result.diagnostics,
          {
            code: "CODEGEN_OUTPUT_WRITE_FAILED",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ];
        break;
      }
    }
  }
  // eslint-disable-next-line unicorn/no-array-sort -- The mapped result array is owned by this report.
  const results = prepared.map((item) => item.result).sort((left, right) => compareNames(left.target, right.target));
  reportCodegen(results, json);
  if (configurationError) throw new CliError("Codegen output paths must be unique.", 2);
  if (results.some((result) => result.status === "error" || result.status === "stale" || result.status === "missing"))
    process.exitCode = 1;
}

function diagnosticText(diagnostic: { readonly code: string; readonly message: string }): string {
  return `${diagnostic.code}: ${diagnostic.message}`;
}

function reportDiagnostics(
  diagnostics: readonly { readonly code: string; readonly message: string; readonly severity: string }[],
  json: boolean,
): void {
  if (json) process.stdout.write(`${JSON.stringify(diagnostics)}\n`);
  else for (const diagnostic of diagnostics) console.error(diagnosticText(diagnostic));
}

function numericOption(argv: readonly string[], name: string): number {
  const value = option(argv, name);
  if (!value || !/^\d+$/u.test(value)) usage();
  return Number(value);
}

function offsetAt(source: string, line: number, column: number): number {
  if (line < 1 || column < 1) usage();
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const next = source.indexOf("\n", offset);
    if (next < 0) return source.length;
    offset = next + 1;
    currentLine += 1;
  }
  return Math.min(source.length, offset + column - 1);
}

function inspectionContext(
  fileName: string | undefined,
  configPath: string | undefined,
): { readonly rootPath: string; readonly configPath?: string } {
  if (configPath) {
    const absoluteConfigPath = resolve(process.cwd(), configPath);
    return { rootPath: dirname(absoluteConfigPath), configPath: absoluteConfigPath };
  }
  let current = fileName ? dirname(fileName) : process.cwd();
  let projectFallback: string | undefined;
  while (true) {
    const sqlBraidConfig = CONFIG_NAMES.map((name) => resolve(current, name)).find((path) => existsSync(path));
    if (sqlBraidConfig) return { rootPath: current, configPath: sqlBraidConfig };
    if (
      !projectFallback &&
      (existsSync(resolve(current, "tsconfig.json")) || existsSync(resolve(current, "package.json")))
    )
      projectFallback = current;
    const parent = dirname(current);
    if (parent === current) return { rootPath: projectFallback ?? current };
    current = parent;
  }
}

async function runInspect(argv: readonly string[], json: boolean): Promise<void> {
  const operation = argv[0];
  const configPath = option(argv, "--config");
  if (!operation || !["query", "symbol", "diagnostics"].includes(operation)) usage();
  const fileOption = option(argv, "--file");
  const fileName = fileOption ? resolve(process.cwd(), fileOption) : undefined;
  if ((operation === "query" || operation === "diagnostics") && !fileName) usage();
  const symbolName =
    operation === "symbol"
      ? argv.slice(1).find((value, index, values) => !value.startsWith("--") && values[index - 1] !== "--config")
      : undefined;
  if (operation === "symbol" && !symbolName) usage();
  const workspace = createWorkspace(inspectionContext(fileName, configPath));
  try {
    if (operation === "symbol") {
      const service = await workspace.service();
      const symbols = service.workspaceSymbols(symbolName as string);
      const result = { operation, query: symbolName, symbols };
      if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else for (const symbol of symbols) console.log(`${symbol.name} ${symbol.kind} ${symbol.location.uri}`);
      return;
    }
    const source = await readFile(fileName as string, "utf8");
    workspace.setDocument(fileName as string, source);
    const service = await workspace.service();
    if (operation === "diagnostics") {
      const allDiagnostics = service.diagnostics(source, fileName as string);
      // oxlint-disable-next-line no-map-spread -- Truncate presentation text without mutating the service's cached diagnostics.
      const diagnostics = allDiagnostics.slice(0, 100).map((diagnostic) => ({
        ...diagnostic,
        message: diagnostic.message.slice(0, 2000),
      }));
      if (json)
        process.stdout.write(
          `${JSON.stringify({ operation, file: fileName, truncated: allDiagnostics.length > diagnostics.length, diagnostics })}\n`,
        );
      else reportDiagnostics(diagnostics, false);
      return;
    }
    const hover = service.hover(
      source,
      fileName as string,
      offsetAt(source, numericOption(argv, "--line"), numericOption(argv, "--column")),
    );
    const result = hover
      ? {
          operation,
          file: fileName,
          resolved: true,
          contents: hover.contents,
          range: hover.range,
          provenance: "sqlbraid",
        }
      : { operation, file: fileName, resolved: false, evidence: "unresolved" };
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else console.log(result.resolved ? `${result.contents}` : "unresolved");
  } finally {
    workspace.dispose();
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command === "--help" || command === "-h") {
    console.log(
      "SQLBraid SQL-first compiler and metadata tooling\n\n" +
        "Usage: sqlbraid <check|build|manifest|drift|codegen|inspect> [options]\n\nRun `sqlbraid <command> --help` for command options.",
    );
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(packageJson.version);
    return;
  }
  const json = argv.includes("--json");
  if (command === "inspect") {
    await runInspect(argv.slice(1), json);
    return;
  }
  if (command === "codegen") {
    await runCodegen(argv.slice(1), json);
    return;
  }
  const fileFlag = option(argv, "--file");
  const projectFlag = option(argv, "--project");
  if (!command || !["check", "manifest", "build", "drift"].includes(command)) usage();
  if (command === "drift") {
    const beforePath = option(argv, "--before");
    const afterPath = option(argv, "--after");
    if (!beforePath || !afterPath) usage();
    const before = await loadMetadata(resolve(beforePath));
    const after = await loadMetadata(resolve(afterPath));
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
  const sourcePaths = existsSync(resolve(sourcePackages, "cli/src/index.ts"))
    ? {
        "@sqlbraid/*": [resolve(sourcePackages, "*/src/index.ts")],
        "sqlbraid/*": [resolve(sourcePackages, "sqlbraid/src/*.ts")],
        "@sqlbraid/postgres/pg": [resolve(sourcePackages, "postgres/src/pg.ts")],
        "@sqlbraid/mysql/mysql2": [resolve(sourcePackages, "mysql/src/mysql2.ts")],
        "@sqlbraid/mariadb/mariadb": [resolve(sourcePackages, "mariadb/src/mariadb.ts")],
        "@sqlbraid/sqlite/node-sqlite": [resolve(sourcePackages, "sqlite/src/node-sqlite.ts")],
        "@sqlbraid/sqlite/better-sqlite3": [resolve(sourcePackages, "sqlite/src/better-sqlite3.ts")],
        "@sqlbraid/sqlite/libsql": [resolve(sourcePackages, "sqlite/src/libsql.ts")],
        "@sqlbraid/sqlite/wasm": [resolve(sourcePackages, "sqlite/src/wasm.ts")],
        "@sqlbraid/sqlite/d1": [resolve(sourcePackages, "sqlite/src/d1.ts")],
      }
    : undefined;
  const checkOptions: TypeScriptCheckOptions = {
    compilerOptions: {
      baseUrl: process.cwd(),
      ...(existsSync(nodeTypes) ? { types: ["node"], typeRoots: [resolve(process.cwd(), "node_modules/@types")] } : {}),
      ...(sourcePaths ? { paths: sourcePaths } : {}),
    },
  };
  const sourceContext =
    command === "manifest" && targetFile ? createSourceContext(source, file, checkOptions) : undefined;
  const analysisOptions = sourceContext
    ? { ...checkOptions, ...sourceContext, sourceFile: sourceContext.sourceFile, typeChecker: sourceContext.checker }
    : checkOptions;
  const discovered = targetFile ? discoverQueries(source, file, analysisOptions) : { queries: [], diagnostics: [] };
  const diagnostics =
    command === "check" && projectFile
      ? checkProject(projectFile, checkOptions)
      : command === "check" || command === "build"
        ? checkSource(source, file, checkOptions)
        : createVirtualOverlay(source, file, analysisOptions).diagnostics;
  reportDiagnostics(diagnostics, json);
  if (command === "check") {
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) process.exitCode = 1;
    return;
  }
  if (command === "build") {
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      process.exitCode = 1;
      return;
    }
    const emitted = emitSource(source, file, checkOptions);
    reportDiagnostics(emitted.diagnostics, json);
    if (emitted.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      process.exitCode = 1;
      return;
    }
    const requested = option(argv, "--out-file");
    const outputFile = resolve(requested ?? `${file.slice(0, -extname(file).length)}.js`);
    await mkdir(dirname(outputFile), { recursive: true });
    let outputText = emitted.outputText;
    if (emitted.sourceMapText) {
      const map: { file: string; sources: string[] } = JSON.parse(emitted.sourceMapText);
      map.file = basename(outputFile);
      map.sources = map.sources.map((sourcePath) =>
        relative(dirname(outputFile), resolve(dirname(file), sourcePath)).replaceAll("\\", "/"),
      );
      outputText = outputText.replace(
        /\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/u,
        `//# sourceMappingURL=${encodeURIComponent(map.file)}.map\n`,
      );
      await writeFile(`${outputFile}.map`, JSON.stringify(map), "utf8");
    }
    await writeFile(outputFile, outputText, "utf8");
    return;
  }
  const overlay = createVirtualOverlay(source, file, analysisOptions);
  const manifests = discovered.queries.map((query) => {
    const captured = Array.from({ length: Math.max(0, query.bindings.length) }, () => null);
    const contract = overlay.queryTypes.find((candidate) => candidate.range.start === query.range.start);
    return createManifestFromEvidence({
      fingerprint: fingerprintTemplate(query.ir, captured),
      templateFamilyFingerprint: templateFamilyFingerprintOf(query.ir),
      resultKind: query.declaredResultKind,
      source: relative(process.cwd(), file),
      ...(contract?.rowType && contract.rowType !== "unknown" ? { resultType: contract.rowType } : {}),
    });
  });
  process.stdout.write(`${JSON.stringify(manifests, null, 2)}\n`);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) process.exitCode = 1;
}

export function runCli(argv: readonly string[]): void {
  void main(argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CliError || error instanceof ConfigurationError ? error.exitCode : 1;
  });
}

const invokedPath = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) runCli(process.argv.slice(2));
