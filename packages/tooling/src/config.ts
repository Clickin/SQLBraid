import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  CodegenNamingOptions,
  CodegenOptions,
  CodegenRelationFilter,
  CodegenTypeOverrides,
} from "@sqlbraid/codegen";
import type { Cancellation } from "./types.js";

export interface CodegenTargetConfig {
  readonly name: string;
  readonly metadata: string;
  readonly outFile: string;
  readonly typePolicy: CodegenOptions["typePolicy"];
  readonly filters?: CodegenRelationFilter;
  readonly naming?: CodegenNamingOptions;
  readonly typeOverrides?: CodegenTypeOverrides;
}

export interface SqlBraidConfig {
  readonly codegen?: {
    readonly targets: readonly CodegenTargetConfig[];
  };
}

/** Configuration failures are user input errors, not internal tooling failures. */
export class ConfigurationError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class ConfigurationCancellationError extends Error {
  constructor() {
    super("Configuration load cancelled.");
    this.name = "ConfigurationCancellationError";
  }
}

export function defineConfig(config: SqlBraidConfig): SqlBraidConfig {
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfigOptions(target: Record<string, unknown>): void {
  const policy = target.typePolicy;
  if (!isRecord(policy) || typeof policy.id !== "string" || !policy.id || typeof policy.hash !== "string" || !policy.hash || !Array.isArray(policy.mappings)) {
    throw new ConfigurationError(`Configuration target ${String(target.name)} has an invalid typePolicy.`);
  }
  for (const [index, mapping] of policy.mappings.entries()) {
    if (!isRecord(mapping) || ["databaseType", "inputType", "outputType"].some((field) => typeof mapping[field] !== "string" || !mapping[field]) || typeof mapping.nullable !== "boolean") {
      throw new ConfigurationError(`Configuration target ${String(target.name)} has an invalid typePolicy mapping ${index}.`);
    }
  }
  const filters = target.filters;
  if (filters !== undefined && (!isRecord(filters)
    || ["includeNamespaces", "excludeNamespaces", "includeRelations", "excludeRelations", "kinds"]
      .some((field) => filters[field] !== undefined && (!Array.isArray(filters[field]) || filters[field].some((entry) => typeof entry !== "string"))))) {
    throw new ConfigurationError("Configuration target filters must contain only string arrays.");
  }
  const filterKinds = isRecord(filters) && Array.isArray(filters.kinds) ? filters.kinds : [];
  if (filterKinds.some((kind) => !["table", "view", "materialized", "foreign", "virtual", "unknown"].includes(String(kind)))) {
    throw new ConfigurationError("Configuration target filters.kinds contains an invalid relation kind.");
  }
  const naming = target.naming;
  if (naming !== undefined) {
    if (!isRecord(naming)) throw new ConfigurationError("Configuration target naming has invalid structure.");
    if (naming.relations !== undefined && (!isRecord(naming.relations) || Object.values(naming.relations).some((name) => typeof name !== "string"))) {
      throw new ConfigurationError("Configuration target naming.relations has invalid structure.");
    }
    const suffixes = naming.suffixes;
    if (suffixes !== undefined && (!isRecord(suffixes) || ["row", "insert", "update"].some((field) => suffixes[field] !== undefined && typeof suffixes[field] !== "string"))) {
      throw new ConfigurationError("Configuration target naming.suffixes has invalid structure.");
    }
  }
  const overrides = target.typeOverrides;
  if (overrides !== undefined && !isRecord(overrides)) throw new ConfigurationError("Configuration target typeOverrides must be an object.");
  if (isRecord(overrides)) {
    for (const field of ["databaseTypes", "columns"]) {
      if (overrides[field] !== undefined && !isRecord(overrides[field])) throw new ConfigurationError(`Configuration target typeOverrides.${field} must be an object.`);
    }
    const validateOverrideMap = (map: Record<string, unknown>, label: string): void => {
      for (const [key, value] of Object.entries(map)) {
        if (!isRecord(value)) throw new ConfigurationError(`Configuration ${label}.${key} must be an object.`);
        if (value.inputType === undefined && value.outputType === undefined) throw new ConfigurationError(`Configuration ${label}.${key} must specify a type.`);
        for (const side of ["inputType", "outputType"]) if (value[side] !== undefined && (typeof value[side] !== "string" || value[side].length === 0)) {
          throw new ConfigurationError(`Configuration ${label}.${key}.${side} must be a non-empty string.`);
        }
      }
    };
    if (isRecord(overrides.databaseTypes)) validateOverrideMap(overrides.databaseTypes, "typeOverrides.databaseTypes");
    if (isRecord(overrides.columns)) for (const [relation, columns] of Object.entries(overrides.columns)) {
      if (!isRecord(columns)) throw new ConfigurationError(`Configuration typeOverrides.columns.${relation} must be an object.`);
      validateOverrideMap(columns, `typeOverrides.columns.${relation}`);
    }
  }
}

export function validateConfig(value: unknown): asserts value is SqlBraidConfig {
  if (!isRecord(value)) throw new ConfigurationError("Configuration default export must be an object.");
  const codegen = value.codegen;
  if (codegen === undefined) return;
  if (!isRecord(codegen) || !Array.isArray(codegen.targets)) throw new ConfigurationError("Configuration codegen.targets must be an array.");
  const names = new Set<string>();
  for (const [index, target] of codegen.targets.entries()) {
    if (!isRecord(target)) throw new ConfigurationError(`Configuration target ${index} must be an object.`);
    for (const field of ["name", "metadata", "outFile"] as const) {
      if (typeof target[field] !== "string" || target[field].length === 0) throw new ConfigurationError(`Configuration target ${index}.${field} must be a non-empty string.`);
    }
    const name = target.name as string;
    if (names.has(name)) throw new ConfigurationError(`Configuration target name is duplicated: ${name}.`);
    names.add(name);
    if (!target.typePolicy) throw new ConfigurationError(`Configuration target ${name} requires typePolicy.`);
    validateConfigOptions(target);
  }
}

export interface LoadedConfig {
  readonly config: SqlBraidConfig;
  readonly directory: string;
  readonly path: string;
}

interface WorkerConfigMessage {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly configuration?: boolean;
}

const CONFIG_NAMES = ["sqlbraid.config.mjs", "sqlbraid.config.js", "sqlbraid.config.cjs"] as const;

function resolveConfigPath(configPath: string | undefined, rootPath: string): string {
  if (configPath) return resolve(rootPath, configPath);
  const candidates = CONFIG_NAMES.map((candidate) => resolve(rootPath, candidate)).filter((candidate) => existsSync(candidate));
  if (candidates.length > 1) throw new ConfigurationError(`Multiple configuration files found: ${candidates.map((candidate) => relative(rootPath, candidate)).join(", ")}.`);
  const path = candidates[0];
  if (!path) throw new ConfigurationError("No sqlbraid.config.mjs, sqlbraid.config.js, or sqlbraid.config.cjs found.");
  return path;
}

/**
 * Load one project config in a short-lived worker. The cache-busting token is
 * based on file evidence, while worker termination also refreshes dependencies.
 */
export async function loadConfig(configPath?: string, rootPath = process.cwd(), cancellation?: Cancellation): Promise<LoadedConfig> {
  if (cancellation?.isCancellationRequested) throw new ConfigurationCancellationError();
  const path = resolveConfigPath(configPath, rootPath);
  if (![".mjs", ".js", ".cjs"].includes(extname(path))) throw new ConfigurationError("Codegen configuration must be .mjs, .js, or .cjs; TypeScript configs are not supported.");
  let file;
  try {
    file = await stat(path, { bigint: true });
  } catch (error) {
    throw new ConfigurationError(`Could not load configuration ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const token = `${file.mtimeNs.toString(36)}-${file.size.toString(36)}`;
  const moduleUrl = `${pathToFileURL(path).href}?sqlbraid=${token}`;
  let imported: { default?: unknown };
  try {
    const workerPath = new URL("./config-worker.js", import.meta.url);
    const builtWorkerPath = resolve(process.cwd(), "packages/tooling/dist/config-worker.js");
    const worker = existsSync(fileURLToPath(workerPath)) ? workerPath : existsSync(builtWorkerPath) ? pathToFileURL(builtWorkerPath) : undefined;
    if (!worker) throw new Error("Tooling config worker is unavailable; build @sqlbraid/tooling before loading project configuration.");
    const value = await loadConfigInWorker(moduleUrl, cancellation, worker);
    imported = { default: value };
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof ConfigurationCancellationError) throw error;
    throw new ConfigurationError(`Could not load configuration ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (cancellation?.isCancellationRequested) throw new ConfigurationCancellationError();
  validateConfig(imported.default);
  return { config: imported.default, directory: dirname(path), path };
}

export { CONFIG_NAMES };

async function loadConfigInWorker(moduleUrl: string, cancellation: Cancellation | undefined, workerPath: URL): Promise<unknown> {
  if (cancellation?.isCancellationRequested) throw new ConfigurationCancellationError();
  const worker = new Worker(workerPath, { workerData: { url: moduleUrl }, stdout: true, stderr: true });
  worker.stdout?.resume();
  worker.stderr?.resume();
  return new Promise((resolveValue, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const settle = (error: Error | undefined, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (error) reject(error);
      else resolveValue(value);
      void worker.terminate();
    };
    timer = setInterval(() => {
      if (cancellation?.isCancellationRequested) settle(new ConfigurationCancellationError());
    }, 5);
    worker.once("message", (message: WorkerConfigMessage) => {
      if (!message.ok) settle(message.configuration ? new ConfigurationError(message.error ?? "Configuration worker rejected configuration.") : new Error(message.error ?? "Configuration worker failed."));
      else settle(undefined, message.value);
    });
    worker.once("error", (error) => settle(error));
    worker.once("exit", (code) => {
      if (!settled) settle(new Error(`Configuration worker exited with code ${code} before returning configuration.`));
    });
  });
}
