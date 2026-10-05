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
import type { Database, Dialect } from "@sqlbraid/core";
import type { MetadataInspector } from "@sqlbraid/metadata";
import type { Cancellation } from "./types.js";

/** One offline codegen target loaded from project configuration. */
export interface CodegenTargetConfig {
  readonly name: string;
  readonly metadata: string;
  readonly outFile: string;
  readonly typePolicy: CodegenOptions["typePolicy"];
  readonly filters?: CodegenRelationFilter;
  readonly naming?: CodegenNamingOptions;
  readonly typeOverrides?: CodegenTypeOverrides;
}

/** Optional migration drift adapter, structurally compatible with @sqlbraid/migrate. */
export interface MigrationConfigDrift {
  inspect(): Promise<{ readonly hash: string; readonly snapshot: unknown; readonly differences?: readonly string[] }>;
}

/** The factory owns its connections; the CLI always calls cleanup after a database command. */
export interface MigrationDatabaseResource {
  readonly db: Database;
  cleanup(): void | Promise<void>;
  readonly inspector?: MetadataInspector;
  readonly drift?: MigrationConfigDrift;
}

/** Executable migration configuration; never transferred out of the inspection worker. */
export interface MigrationsConfig {
  readonly directory: string;
  readonly dialect: Dialect;
  readonly database: () => MigrationDatabaseResource | Promise<MigrationDatabaseResource>;
  readonly options?: {
    readonly scope?: string;
    readonly table?: string;
    readonly schema?: string;
    readonly appliedBy?: string;
    readonly busyTimeoutMs?: number;
    readonly ahead?: "allow" | "error";
    readonly schemaCheck?: "hash";
  };
  readonly inspector?: MetadataInspector;
  readonly drift?: MigrationConfigDrift;
  /** Committed snapshot path, relative to the config directory. */
  readonly snapshot?: string;
}

/** Project configuration consumed by CLI/tooling; config files execute as Node modules. */
export interface SqlBraidConfig {
  readonly codegen?: {
    readonly targets: readonly CodegenTargetConfig[];
  };
  readonly migrations?: MigrationsConfig;
}

/** Configuration failures are user input errors, not internal tooling failures. */
export class ConfigurationError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Raised when configuration loading is cancelled before worker completion. */
export class ConfigurationCancellationError extends Error {
  constructor() {
    super("Configuration load cancelled.");
    this.name = "ConfigurationCancellationError";
  }
}

/** Identity helper for typed config files; it performs no loading or validation. */
export function defineConfig(config: SqlBraidConfig): SqlBraidConfig {
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfigOptions(target: Record<string, unknown>): void {
  const policy = target.typePolicy;
  if (
    !isRecord(policy) ||
    typeof policy.id !== "string" ||
    !policy.id ||
    typeof policy.hash !== "string" ||
    !policy.hash ||
    !Array.isArray(policy.mappings)
  ) {
    throw new ConfigurationError(`Configuration target ${String(target.name)} has an invalid typePolicy.`);
  }
  for (const [index, mapping] of policy.mappings.entries()) {
    if (
      !isRecord(mapping) ||
      ["databaseType", "inputType", "outputType"].some(
        (field) => typeof mapping[field] !== "string" || !mapping[field],
      ) ||
      typeof mapping.nullable !== "boolean"
    ) {
      throw new ConfigurationError(
        `Configuration target ${String(target.name)} has an invalid typePolicy mapping ${index}.`,
      );
    }
    if ("numericFidelity" in mapping) {
      throw new ConfigurationError(
        "TypePolicy numericFidelity was replaced by the numeric semantics/representation/fidelity contract.",
      );
    }
    if (mapping.numeric !== undefined && !isRecord(mapping.numeric)) {
      throw new ConfigurationError(
        `Configuration target ${String(target.name)} has an invalid numeric contract at mapping ${index}.`,
      );
    }
  }
  const filters = target.filters;
  if (
    filters !== undefined &&
    (!isRecord(filters) ||
      ["includeNamespaces", "excludeNamespaces", "includeRelations", "excludeRelations", "kinds"].some(
        (field) =>
          filters[field] !== undefined &&
          (!Array.isArray(filters[field]) || filters[field].some((entry) => typeof entry !== "string")),
      ))
  ) {
    throw new ConfigurationError("Configuration target filters must contain only string arrays.");
  }
  const filterKinds = isRecord(filters) && Array.isArray(filters.kinds) ? filters.kinds : [];
  if (
    filterKinds.some(
      (kind) => !["table", "view", "materialized", "foreign", "virtual", "unknown"].includes(String(kind)),
    )
  ) {
    throw new ConfigurationError("Configuration target filters.kinds contains an invalid relation kind.");
  }
  const naming = target.naming;
  if (naming !== undefined) {
    if (!isRecord(naming)) throw new ConfigurationError("Configuration target naming has invalid structure.");
    if (
      naming.relations !== undefined &&
      (!isRecord(naming.relations) || Object.values(naming.relations).some((name) => typeof name !== "string"))
    ) {
      throw new ConfigurationError("Configuration target naming.relations has invalid structure.");
    }
    const suffixes = naming.suffixes;
    if (
      suffixes !== undefined &&
      (!isRecord(suffixes) ||
        ["row", "insert", "update"].some(
          (field) => suffixes[field] !== undefined && typeof suffixes[field] !== "string",
        ))
    ) {
      throw new ConfigurationError("Configuration target naming.suffixes has invalid structure.");
    }
  }
  const overrides = target.typeOverrides;
  if (overrides !== undefined && !isRecord(overrides))
    throw new ConfigurationError("Configuration target typeOverrides must be an object.");
  if (isRecord(overrides)) {
    for (const field of ["databaseTypes", "columns"]) {
      if (overrides[field] !== undefined && !isRecord(overrides[field]))
        throw new ConfigurationError(`Configuration target typeOverrides.${field} must be an object.`);
    }
    const validateOverrideMap = (map: Record<string, unknown>, label: string): void => {
      for (const [key, value] of Object.entries(map)) {
        if (!isRecord(value)) throw new ConfigurationError(`Configuration ${label}.${key} must be an object.`);
        if (value.inputType === undefined && value.outputType === undefined)
          throw new ConfigurationError(`Configuration ${label}.${key} must specify a type.`);
        for (const side of ["inputType", "outputType"])
          if (value[side] !== undefined && (typeof value[side] !== "string" || value[side].length === 0)) {
            throw new ConfigurationError(`Configuration ${label}.${key}.${side} must be a non-empty string.`);
          }
      }
    };
    if (isRecord(overrides.databaseTypes)) validateOverrideMap(overrides.databaseTypes, "typeOverrides.databaseTypes");
    if (isRecord(overrides.columns))
      for (const [relation, columns] of Object.entries(overrides.columns)) {
        if (!isRecord(columns))
          throw new ConfigurationError(`Configuration typeOverrides.columns.${relation} must be an object.`);
        validateOverrideMap(columns, `typeOverrides.columns.${relation}`);
      }
  }
}

function validateMigrations(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigurationError("Configuration migrations must be an object.");
  if (typeof value.directory !== "string" || !value.directory)
    throw new ConfigurationError("Configuration migrations.directory must be a non-empty string.");
  if (!isRecord(value.dialect) || typeof value.dialect.id !== "string" || !value.dialect.id)
    throw new ConfigurationError("Configuration migrations.dialect must be a dialect object.");
  if (typeof value.database !== "function")
    throw new ConfigurationError("Configuration migrations.database must be a factory returning { db, cleanup }.");
  if (value.snapshot !== undefined && (typeof value.snapshot !== "string" || !value.snapshot))
    throw new ConfigurationError("Configuration migrations.snapshot must be a non-empty path.");
  for (const key of ["inspector", "drift"]) {
    const adapter = value[key];
    if (adapter !== undefined && (!isRecord(adapter) || typeof adapter.inspect !== "function"))
      throw new ConfigurationError(`Configuration migrations.${key} must have an inspect method.`);
  }
  const options = value.options;
  if (options === undefined) return;
  if (!isRecord(options)) throw new ConfigurationError("Configuration migrations.options must be an object.");
  for (const key of ["scope", "table", "schema", "appliedBy"]) {
    if (options[key] !== undefined && (typeof options[key] !== "string" || !options[key]))
      throw new ConfigurationError(`Configuration migrations.options.${key} must be a non-empty string.`);
  }
  if (options.ahead !== undefined && options.ahead !== "allow" && options.ahead !== "error")
    throw new ConfigurationError("Configuration migrations.options.ahead must be allow or error.");
  if (options.schemaCheck !== undefined && options.schemaCheck !== "hash")
    throw new ConfigurationError("Configuration migrations.options.schemaCheck must be hash.");
  if (
    options.busyTimeoutMs !== undefined &&
    (typeof options.busyTimeoutMs !== "number" ||
      !Number.isSafeInteger(options.busyTimeoutMs) ||
      options.busyTimeoutMs < 0 ||
      options.busyTimeoutMs > 2_147_483_647)
  )
    throw new ConfigurationError(
      "Configuration migrations.options.busyTimeoutMs must be a nonnegative integer no greater than 2147483647.",
    );
}

/** Validate config shape and target uniqueness before codegen or filesystem writes. */
export function validateConfig(value: unknown): asserts value is SqlBraidConfig {
  if (!isRecord(value)) throw new ConfigurationError("Configuration default export must be an object.");
  validateMigrations(value.migrations);
  const codegen = value.codegen;
  if (codegen === undefined) return;
  if (!isRecord(codegen) || !Array.isArray(codegen.targets))
    throw new ConfigurationError("Configuration codegen.targets must be an array.");
  const names = new Set<string>();
  for (const [index, target] of codegen.targets.entries()) {
    if (!isRecord(target)) throw new ConfigurationError(`Configuration target ${index} must be an object.`);
    for (const field of ["name", "metadata", "outFile"] as const) {
      if (typeof target[field] !== "string" || target[field].length === 0)
        throw new ConfigurationError(`Configuration target ${index}.${field} must be a non-empty string.`);
    }
    const name = target.name as string;
    if (names.has(name)) throw new ConfigurationError(`Configuration target name is duplicated: ${name}.`);
    names.add(name);
    if (!target.typePolicy) throw new ConfigurationError(`Configuration target ${name} requires typePolicy.`);
    validateConfigOptions(target);
  }
}

/** Loaded config plus the resolved file path and directory used for relative targets. */
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

const CONFIG_NAMES = [
  "sqlbraid.config.ts",
  "sqlbraid.config.mjs",
  "sqlbraid.config.js",
  "sqlbraid.config.cjs",
] as const;

/** Resolve the single shared project config without executing it. */
export function resolveConfigPath(configPath: string | undefined, rootPath: string): string {
  if (configPath) return resolve(rootPath, configPath);
  const candidates = CONFIG_NAMES.map((candidate) => resolve(rootPath, candidate)).filter((candidate) =>
    existsSync(candidate),
  );
  if (candidates.length > 1)
    throw new ConfigurationError(
      `Multiple configuration files found: ${candidates.map((candidate) => relative(rootPath, candidate)).join(", ")}.`,
    );
  const path = candidates[0];
  if (!path) throw new ConfigurationError(`No ${CONFIG_NAMES.join(", ")} found.`);
  return path;
}

/**
 * Load one project config in a short-lived worker. The cache-busting token is
 * based on file evidence, while worker termination also refreshes dependencies.
 */
export async function loadConfig(
  configPath?: string,
  rootPath = process.cwd(),
  cancellation?: Cancellation,
): Promise<LoadedConfig> {
  if (cancellation?.isCancellationRequested) throw new ConfigurationCancellationError();
  const path = resolveConfigPath(configPath, rootPath);
  if (![".ts", ".mjs", ".js", ".cjs"].includes(extname(path)))
    throw new ConfigurationError("Configuration must be .ts, .mjs, .js, or .cjs.");
  let file;
  try {
    file = await stat(path, { bigint: true });
  } catch (error) {
    throw new ConfigurationError(
      `Could not load configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const token = `${file.mtimeNs.toString(36)}-${file.size.toString(36)}`;
  const moduleUrl = `${pathToFileURL(path).href}?sqlbraid=${token}`;
  let imported: { default?: unknown };
  try {
    const workerPath = new URL("./config-worker.js", import.meta.url);
    const builtWorkerPath = resolve(process.cwd(), "packages/tooling/dist/config-worker.js");
    const worker = existsSync(fileURLToPath(workerPath))
      ? workerPath
      : existsSync(builtWorkerPath)
        ? pathToFileURL(builtWorkerPath)
        : undefined;
    if (!worker)
      throw new Error(
        "Tooling config worker is unavailable; build @sqlbraid/tooling before loading project configuration.",
      );
    const value = await loadConfigInWorker(moduleUrl, cancellation, worker);
    imported = { default: value };
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof ConfigurationCancellationError) throw error;
    throw new ConfigurationError(
      `Could not load configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (cancellation?.isCancellationRequested) throw new ConfigurationCancellationError();
  validateConfig(imported.default);
  return { config: imported.default, directory: dirname(path), path };
}

export { CONFIG_NAMES };

async function loadConfigInWorker(
  moduleUrl: string,
  cancellation: Cancellation | undefined,
  workerPath: URL,
): Promise<unknown> {
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
      if (!message.ok)
        settle(
          message.configuration
            ? new ConfigurationError(message.error ?? "Configuration worker rejected configuration.")
            : new Error(message.error ?? "Configuration worker failed."),
        );
      else settle(undefined, message.value);
    });
    worker.once("error", (error) => settle(error));
    worker.once("exit", (code) => {
      if (!settled) settle(new Error(`Configuration worker exited with code ${code} before returning configuration.`));
    });
  });
}
