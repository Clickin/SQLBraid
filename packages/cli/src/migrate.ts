import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MigrationReport } from "@sqlbraid/migrate";
import { parseSnapshotJson } from "@sqlbraid/metadata";
import {
  ConfigurationError,
  resolveConfigPath,
  validateConfig,
  type MigrationDatabaseResource,
  type MigrationsConfig,
} from "@sqlbraid/tooling";
import { terminalText } from "./terminal.js";

/** The dialect suffixes that the migration loader accepts in file names. */
const MIGRATION_DIALECTS = ["postgres", "mysql", "mariadb", "sqlite", "oracle", "mssql"];

const HELP = `Usage: sqlbraid migrate <command> [--config <path>]
  new <name> [--dialect <id>]  Create the next versioned SQL file
  status [--json] [--check]   Report migration history without writes; --check exits 1 unless current
  up                         Apply pending migrations
  baseline <version>         Mark an existing database at a version
  repair                     Remove running/failed attempts after manual inspection
  accept-schema              Record the inspected schema hash as the expected schema
  manifest [--out-file <path>] Generate a manifest module with the SQL text
  snapshot [--out-file <path>] Write the inspected schema snapshot`;

/** Executable factories stay in the CLI process, never in the inspection worker protocol. */
async function loadMigrationConfig(configPath: string | undefined): Promise<{
  config: MigrationsConfig;
  directory: string;
}> {
  const path = resolveConfigPath(configPath, process.cwd());
  if (![".ts", ".mjs", ".js", ".cjs"].includes(extname(path)))
    throw new ConfigurationError("Configuration must be .ts, .mjs, .js, or .cjs.");
  let value: unknown;
  try {
    // The shared config path is selected by the user at runtime.
    const imported = await import(pathToFileURL(path).href);
    value = imported.default;
  } catch (error) {
    throw new ConfigurationError(
      `Could not load configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateConfig(value);
  if (!value.migrations) throw new ConfigurationError("Configuration must define migrations.");
  return { config: value.migrations, directory: dirname(path) };
}

/** @sqlbraid/migrate is an optional peer: only `sqlbraid migrate` loads it. */
async function loadMigrate(): Promise<{
  readonly migrate: typeof import("@sqlbraid/migrate");
  readonly node: typeof import("@sqlbraid/migrate/node");
  readonly drift: typeof import("@sqlbraid/migrate/drift");
}> {
  let migrate: typeof import("@sqlbraid/migrate");
  try {
    migrate = await import("@sqlbraid/migrate");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw error;
    throw new ConfigurationError(
      "sqlbraid migrate requires the optional @sqlbraid/migrate package. Install @sqlbraid/migrate in the project.",
    );
  }
  const [node, drift] = await Promise.all([import("@sqlbraid/migrate/node"), import("@sqlbraid/migrate/drift")]);
  return { migrate, node, drift };
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

function printReport(report: MigrationReport, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    console.log(terminalText(report.summary, true));
    for (const difference of report.differences)
      console.log(
        terminalText(
          `  ${difference.kind}${difference.version ? ` ${difference.version}` : ""}${difference.source ? ` ${difference.source}` : ""}${difference.path ? ` ${difference.path}` : ""}`,
        ),
      );
  }
}

async function newMigration(directory: string, name: string, dialect: string | undefined): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(name))
    throw new ConfigurationError("Migration names must contain only letters, digits, underscores, or hyphens.");
  if (dialect !== undefined && !MIGRATION_DIALECTS.includes(dialect))
    throw new ConfigurationError(`Migration dialect must be one of ${MIGRATION_DIALECTS.join(", ")}.`);
  await mkdir(directory, { recursive: true });
  let next = 1n;
  let width = 3;
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    const real = await realpath(path);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const kind = entry.isSymbolicLink() ? await stat(resolve(path, entry.name)) : entry;
      if (kind.isDirectory()) {
        await visit(resolve(path, entry.name));
        continue;
      }
      if (!kind.isFile() || !entry.name.endsWith(".sql")) continue;
      const match = /^V(\d+)(?:[._]\d+)*__/u.exec(entry.name);
      if (!match?.[1]) continue;
      const major = BigInt(match[1]);
      if (major >= next) next = major + 1n;
      width = Math.max(width, match[1].length);
    }
  }
  await visit(directory);
  const version = next.toString().padStart(width, "0");
  const path = resolve(directory, `V${version}__${name}${dialect ? `.${dialect}` : ""}.sql`);
  await writeFile(path, "", { flag: "wx" });
  return path;
}

/** Dispatch migration commands without changing the existing codegen/inspection config loader. */
export async function runMigrate(argv: readonly string[]): Promise<void> {
  if (argv.includes("--help") || argv[0] === "-h") {
    console.log(HELP);
    return;
  }
  const command = argv[0];
  if (
    !command ||
    !["new", "status", "up", "baseline", "repair", "accept-schema", "manifest", "snapshot"].includes(command)
  )
    throw new ConfigurationError(HELP);
  const values = new Map<string, string>();
  const positional: string[] = [];
  let json = false;
  let check = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json" && command === "status") {
      json = true;
      continue;
    }
    if (arg === "--check" && command === "status") {
      check = true;
      continue;
    }
    if (
      arg === "--config" ||
      (arg === "--dialect" && command === "new") ||
      (arg === "--out-file" && (command === "manifest" || command === "snapshot"))
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--") || values.has(arg))
        throw new ConfigurationError(`Expected one value for ${arg}.`);
      values.set(arg, value);
      index += 1;
    } else if (arg?.startsWith("-")) throw new ConfigurationError(`Unknown migration option: ${arg}.`);
    else if (arg) positional.push(arg);
  }
  if (positional.length !== (command === "new" || command === "baseline" ? 1 : 0)) throw new ConfigurationError(HELP);
  // `new` only writes a file; every other command needs the optional migrate package first.
  const modules = command === "new" ? undefined : await loadMigrate();
  const loaded = await loadMigrationConfig(values.get("--config"));
  const config = loaded.config;
  const directory = resolve(loaded.directory, config.directory);
  const snapshotPath = config.snapshot
    ? resolve(loaded.directory, config.snapshot)
    : resolve(directory, "schema.snapshot.json");
  if (command === "new") {
    console.log(await newMigration(directory, positional[0]!, values.get("--dialect")));
    return;
  }
  const { migrate, node, drift: driftModule } = modules!;
  if (command === "manifest") {
    const path = values.has("--out-file") ? resolve(values.get("--out-file")!) : resolve(directory, "manifest.mjs");
    const source = await node.generateManifestModule(directory, { dialects: [config.dialect.id] });
    await atomicWrite(path, source);
    console.log(path);
    return;
  }
  const manifest = await node.loadMigrations(directory, { dialects: [config.dialect.id] });
  const resource: MigrationDatabaseResource = await config.database();
  if (!resource || typeof resource.cleanup !== "function")
    throw new ConfigurationError(
      "Migration database factory must return { db, cleanup }. The factory owns cleanup if acquisition fails.",
    );
  try {
    if (!resource.db || typeof resource.db.execute !== "function")
      throw new ConfigurationError("Migration database factory returned an invalid db.");
    const inspector = resource.inspector ?? config.inspector;
    let drift = resource.drift ?? config.drift;
    if (!drift && inspector) {
      // snapshot rewrites the committed file, so it never reads or validates the existing file.
      if (command !== "snapshot") {
        try {
          drift = driftModule.createSchemaDrift({
            inspector,
            snapshot: parseSnapshotJson(await readFile(snapshotPath, "utf8")),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new ConfigurationError(
              `Cannot use the schema snapshot ${snapshotPath}: ${error instanceof Error ? error.message : String(error)} Run "sqlbraid migrate snapshot" to write it again.`,
            );
        }
      }
      drift ??= driftModule.createSchemaDrift({ inspector });
    }
    const { ahead, schemaCheck, ...options } = config.options ?? {};
    const migrator = migrate.createMigrator({
      manifest,
      dialect: config.dialect,
      ...options,
      ...(drift ? { drift } : {}),
    });
    if (command === "snapshot") {
      if (!drift) throw new ConfigurationError("migrate snapshot requires an inspector or drift adapter.");
      const path = values.has("--out-file") ? resolve(values.get("--out-file")!) : snapshotPath;
      await atomicWrite(path, `${JSON.stringify((await drift.inspect()).snapshot, null, 2)}\n`);
      console.log(path);
    } else {
      const report =
        command === "status"
          ? await migrator.startup(resource.db, {
              mode: "report",
              ...(ahead ? { ahead } : {}),
              ...(schemaCheck ? { schema: schemaCheck } : {}),
            })
          : command === "up"
            ? await migrator.startup(resource.db, {
                mode: "apply",
                ...(ahead ? { ahead } : {}),
                ...(schemaCheck ? { schema: schemaCheck } : {}),
              })
            : command === "baseline"
              ? await migrator.baseline(resource.db, positional[0]!)
              : command === "accept-schema"
                ? await migrator.acceptSchema(resource.db)
                : await migrator.repair(resource.db);
      printReport(report, json);
      // Mirror startup verification: only current, or ahead under the allow policy, passes.
      if (check && report.status !== "current" && !(report.status === "ahead" && ahead !== "error"))
        process.exitCode = 1;
    }
  } finally {
    await resource.cleanup();
  }
}
