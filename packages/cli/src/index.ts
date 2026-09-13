#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateModels, type CodegenDiagnostic } from "@sqlbraid/codegen";
import { checkProject, checkSource, createVirtualOverlay, discoverQueries, emitSource, type TypeScriptCheckOptions } from "@sqlbraid/compiler";
import { createManifestFromEvidence, fingerprintTemplate, templateFamilyFingerprintOf } from "@sqlbraid/operations";
import { diffSnapshots, parseSnapshotJson, type MetadataSnapshot } from "@sqlbraid/metadata";
import type { CodegenTargetConfig, SqlBraidConfig } from "./config.js";

function usage(): never {
  console.error("Usage: sqlbraid check|manifest|build --file <path> [--out-file <path>] | sqlbraid check --project <path> | sqlbraid drift --before <path> --after <path> | sqlbraid codegen [--config <path>] [--target <name>]... [--check] [--json]");
  process.exit(2);
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function options(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === name) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    values.push(value);
    index += 1;
  }
  return values;
}

class CliError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfigOptions(target: Record<string, unknown>): void {
  const policy = target.typePolicy;
  if (!isRecord(policy) || typeof policy.id !== "string" || !policy.id || typeof policy.hash !== "string" || !policy.hash || !Array.isArray(policy.mappings)) {
    throw new CliError(`Configuration target ${String(target.name)} has an invalid typePolicy.`, 2);
  }
  for (const [index, mapping] of policy.mappings.entries()) {
    if (!isRecord(mapping) || ["databaseType", "inputType", "outputType"].some((field) => typeof mapping[field] !== "string" || !mapping[field]) || typeof mapping.nullable !== "boolean") {
      throw new CliError(`Configuration target ${String(target.name)} has an invalid typePolicy mapping ${index}.`, 2);
    }
  }
  const filters = target.filters;
  if (filters !== undefined && (!isRecord(filters)
    || ["includeNamespaces", "excludeNamespaces", "includeRelations", "excludeRelations", "kinds"]
      .some((field) => filters[field] !== undefined && (!Array.isArray(filters[field]) || filters[field].some((entry) => typeof entry !== "string"))))) {
    throw new CliError("Configuration target filters must contain only string arrays.", 2);
  }
  const filterKinds = isRecord(filters) && Array.isArray(filters.kinds) ? filters.kinds : [];
  if (filterKinds.some((kind) => !["table", "view", "materialized", "foreign", "virtual", "unknown"].includes(String(kind)))) {
    throw new CliError("Configuration target filters.kinds contains an invalid relation kind.", 2);
  }
  const naming = target.naming;
  if (naming !== undefined) {
    if (!isRecord(naming)) throw new CliError("Configuration target naming has invalid structure.", 2);
    if (naming.relations !== undefined && (!isRecord(naming.relations) || Object.values(naming.relations).some((name) => typeof name !== "string"))) {
      throw new CliError("Configuration target naming.relations has invalid structure.", 2);
    }
    const suffixes = naming.suffixes;
    if (suffixes !== undefined && (!isRecord(suffixes) || ["row", "insert", "update"].some((field) => suffixes[field] !== undefined && typeof suffixes[field] !== "string"))) {
      throw new CliError("Configuration target naming.suffixes has invalid structure.", 2);
    }
  }
  const overrides = target.typeOverrides;
  if (overrides !== undefined && !isRecord(overrides)) throw new CliError("Configuration target typeOverrides must be an object.", 2);
  if (isRecord(overrides)) {
    for (const field of ["databaseTypes", "columns"]) {
      if (overrides[field] !== undefined && !isRecord(overrides[field])) throw new CliError(`Configuration target typeOverrides.${field} must be an object.`, 2);
    }
    const validateOverrideMap = (map: Record<string, unknown>, label: string): void => {
      for (const [key, value] of Object.entries(map)) {
        if (!isRecord(value)) throw new CliError(`Configuration ${label}.${key} must be an object.`, 2);
        if (value.inputType === undefined && value.outputType === undefined) throw new CliError(`Configuration ${label}.${key} must specify a type.`, 2);
        for (const side of ["inputType", "outputType"]) if (value[side] !== undefined && (typeof value[side] !== "string" || value[side].length === 0)) {
          throw new CliError(`Configuration ${label}.${key}.${side} must be a non-empty string.`, 2);
        }
      }
    };
    if (isRecord(overrides.databaseTypes)) validateOverrideMap(overrides.databaseTypes, "typeOverrides.databaseTypes");
    if (isRecord(overrides.columns)) for (const [relation, columns] of Object.entries(overrides.columns)) {
      if (!isRecord(columns)) throw new CliError(`Configuration typeOverrides.columns.${relation} must be an object.`, 2);
      validateOverrideMap(columns, `typeOverrides.columns.${relation}`);
    }
  }
}

function validateConfig(value: unknown): asserts value is SqlBraidConfig {
  if (!isRecord(value)) throw new CliError("Configuration default export must be an object.", 2);
  const codegen = value.codegen;
  if (codegen === undefined) return;
  if (!isRecord(codegen) || !Array.isArray(codegen.targets)) throw new CliError("Configuration codegen.targets must be an array.", 2);
  const names = new Set<string>();
  for (const [index, target] of codegen.targets.entries()) {
    if (!isRecord(target)) throw new CliError(`Configuration target ${index} must be an object.`, 2);
    for (const field of ["name", "metadata", "outFile"] as const) {
      if (typeof target[field] !== "string" || target[field].length === 0) throw new CliError(`Configuration target ${index}.${field} must be a non-empty string.`, 2);
    }
    const name = target.name as string;
    if (names.has(name)) throw new CliError(`Configuration target name is duplicated: ${name}.`, 2);
    names.add(name);
    if (!target.typePolicy) throw new CliError(`Configuration target ${name} requires typePolicy.`, 2);
    validateConfigOptions(target);
  }
}

async function loadCodegenConfig(configPath: string | undefined): Promise<{ config: SqlBraidConfig; directory: string; path: string }> {
  const cwd = process.cwd();
  let path: string;
  if (configPath) {
    path = resolve(cwd, configPath);
  } else {
    const candidates = ["sqlbraid.config.mjs", "sqlbraid.config.js", "sqlbraid.config.cjs"]
      .map((candidate) => resolve(cwd, candidate))
      .filter((candidate) => existsSync(candidate));
    if (candidates.length > 1) throw new CliError(`Multiple configuration files found: ${candidates.map((candidate) => relative(cwd, candidate)).join(", ")}.`, 2);
    path = candidates[0] ?? "";
  }
  if (!path) throw new CliError("No sqlbraid.config.mjs, sqlbraid.config.js, or sqlbraid.config.cjs found.", 2);
  if (![".mjs", ".js", ".cjs"].includes(extname(path))) throw new CliError("Codegen configuration must be .mjs, .js, or .cjs; TypeScript configs are not supported.", 2);
  let imported: { default?: unknown };
  try {
    imported = await import(`${pathToFileURL(path).href}?sqlbraid=${Date.now()}`);
  } catch (error) {
    throw new CliError(`Could not load configuration ${path}: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  validateConfig(imported.default);
  return { config: imported.default, directory: dirname(path), path };
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

async function prepareCodegenTarget(target: CodegenTargetConfig, configDirectory: string, check: boolean): Promise<PreparedCodegenTarget> {
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
      : current === undefined ? (check ? "missing" : "missing") : current === generated.source ? "unchanged" : (check ? "stale" : "written");
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
  for (const result of results) for (const diagnostic of result.diagnostics) {
    const location = [diagnostic.relation, diagnostic.column].filter(Boolean).join(".");
    console.error(`${result.target} ${diagnostic.code}${location ? ` ${location}` : ""}: ${diagnostic.message}`);
  }
}

async function runCodegen(argv: readonly string[], json: boolean): Promise<void> {
  const loaded = await loadCodegenConfig(option(argv, "--config"));
  const targets = loaded.config.codegen?.targets;
  if (!targets) throw new CliError("Configuration must define codegen.targets.", 2);
  const requested = options(argv, "--target");
  const requestedSet = new Set(requested);
  for (const name of requested) if (!targets.some((target) => target.name === name)) throw new CliError(`Unknown codegen target: ${name}.`, 2);
  const selected = targets.filter((target) => requestedSet.size === 0 || requestedSet.has(target.name)).sort((left, right) => compareNames(left.name, right.name));
  const check = argv.includes("--check");
  const prepared = await Promise.all(selected.map((target) => prepareCodegenTarget(target, loaded.directory, check)));
  const paths = new Map<string, PreparedCodegenTarget>();
  let configurationError = false;
  for (const item of prepared) {
    const prior = paths.get(item.outputPath);
    if (prior) {
      configurationError = true;
      const message = `Output path collides with target ${prior.target.name}.`;
      item.result.status = "error";
      item.result.diagnostics = [...item.result.diagnostics, { code: "CODEGEN_OUTPUT_PATH_COLLISION", severity: "error", message }];
      prior.result.status = "error";
      prior.result.diagnostics = [...prior.result.diagnostics, { code: "CODEGEN_OUTPUT_PATH_COLLISION", severity: "error", message: `Output path collides with target ${item.target.name}.` }];
    } else paths.set(item.outputPath, item);
  }
  const hasGenerationError = prepared.some((item) => item.result.status === "error");
  if (!check && !configurationError && !hasGenerationError) {
    for (const item of prepared) {
      if (item.result.status !== "written" && item.result.status !== "missing") continue;
      if (item.source === undefined) continue;
      try {
        await atomicWrite(item.outputPath, item.source);
        item.result.status = "written";
      } catch (error) {
        item.result.status = "error";
        item.result.diagnostics = [...item.result.diagnostics, { code: "CODEGEN_OUTPUT_WRITE_FAILED", severity: "error", message: error instanceof Error ? error.message : String(error) }];
        break;
      }
    }
  }
  const results = prepared.map((item) => item.result).sort((left, right) => compareNames(left.target, right.target));
  reportCodegen(results, json);
  if (configurationError) throw new CliError("Codegen output paths must be unique.", 2);
  if (results.some((result) => result.status === "error" || result.status === "stale" || result.status === "missing")) process.exitCode = 1;
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
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
