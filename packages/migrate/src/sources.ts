import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { MigrationError } from "./errors.js";
import { compareVersions, isMigrationBody, normalizeVersion } from "./manifest.js";
import type { DialectManifest, ManifestEntry, MigrationBody, MigrationManifest } from "./types.js";

export interface LoadMigrationsOptions {
  /** With no target list, dialects resolve lazily when a migrator selects its target. */
  readonly dialects?: readonly string[];
}

export interface GenerateManifestOptions extends LoadMigrationsOptions {
  /** Location of the written module. Import specifiers are relative to it; defaults to `<directory>/manifest.mjs`. */
  readonly outfile?: string;
}

export interface Source {
  readonly version: string | null;
  readonly description: string;
  readonly source: string;
  readonly dialect: string | null;
  readonly text: string;
  readonly checksum: string;
  readonly path: string;
  readonly typescript: boolean;
}

const DIALECTS = ["postgres", "mysql", "mariadb", "sqlite", "oracle", "mssql"];
export const DIRECTIVE = /\/\*\s*@braid\b/u;

/** Source identity deliberately preserves all whitespace other than BOM and CRLF. */
export function normalizeSource(source: string): string {
  return source.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
}

function checksum(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function sourceError(message: string, cause?: unknown): MigrationError {
  return new MigrationError("BRAID_MIGRATE_SOURCE", message, cause === undefined ? undefined : { cause });
}

export async function readSources(directory: string): Promise<readonly Source[]> {
  const sources: Source[] = [];
  const visited = new Set<string>();
  async function visit(folder: string): Promise<void> {
    const real = await realpath(join(directory, folder));
    if (visited.has(real)) throw sourceError(`Migration directory ${folder} is reached twice through a symbolic link.`);
    visited.add(real);
    for (const entry of await readdir(join(directory, folder), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const source = folder ? `${folder}/${entry.name}` : entry.name;
      // Follow symbolic links; a broken link fails as an unreadable directory entry.
      const kind = entry.isSymbolicLink() ? await stat(join(directory, source)) : entry;
      if (kind.isDirectory()) {
        await visit(source);
        continue;
      }
      if (!kind.isFile() || !/\.(?:sql|ts)$/u.test(entry.name) || !/^(?:V.*__|R__)/u.test(entry.name)) continue;
      const match = /^(?:V(\d+(?:[._]\d+)*)__|R__)(.+)\.(sql|ts)$/u.exec(entry.name);
      if (!match) throw sourceError(`Invalid migration filename: ${source}`);
      const version = match[1] ?? null;
      const stem = match[2]!;
      const dot = stem.indexOf(".");
      const description = dot < 0 ? stem : stem.slice(0, dot);
      const dialect = dot < 0 ? null : stem.slice(dot + 1);
      if (!description) throw sourceError(`Invalid migration description: ${source}`);
      if (dialect !== null && !DIALECTS.includes(dialect)) {
        throw sourceError(
          `Invalid migration filename ${source}: the part after the first dot must be one dialect id (${DIALECTS.join(", ")}). Descriptions must not contain dots.`,
        );
      }
      const path = resolve(directory, source);
      const text = normalizeSource(await readFile(path, "utf8"));
      sources.push({
        version,
        description,
        source,
        dialect,
        text,
        checksum: checksum(text),
        path,
        typescript: match[3] === "ts",
      });
    }
  }
  try {
    await visit("");
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw sourceError(`Cannot read migrations directory ${directory}`, error);
  }
  sources.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return sources;
}

function sourceGroups(sources: readonly Source[]): readonly (readonly Source[])[] {
  const groups = new Map<string, Source[]>();
  for (const source of sources) {
    const key = source.version === null ? `R:${source.description}` : `V:${normalizeVersion(source.version)}`;
    const group = groups.get(key) ?? [];
    const duplicate = group.find((other) => other.dialect === source.dialect);
    if (duplicate) throw sourceError(`Duplicate migration identity: ${duplicate.source} and ${source.source}`);
    group.push(source);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function identity(entry: ManifestEntry): readonly (string | null)[] {
  return [entry.version, entry.description, entry.source, entry.checksum];
}

export function manifestFromSources(
  sources: readonly Source[],
  options: LoadMigrationsOptions,
  availableOnly = false,
): MigrationManifest {
  const groups = sourceGroups(sources);
  const targets = options.dialects ?? DIALECTS;
  const dialects: Record<string, DialectManifest> = Object.create(null);
  for (const dialect of targets) {
    if (!/^[a-z][a-z0-9-]*$/u.test(dialect)) throw sourceError(`Invalid target dialect: ${dialect}`);
    if (Object.hasOwn(dialects, dialect)) continue;
    if (
      availableOnly &&
      options.dialects === undefined &&
      groups.some((group) => !group.some((source) => source.dialect === dialect || source.dialect === null))
    )
      continue;
    let cached: DialectManifest | undefined;
    const select = (): DialectManifest => {
      if (cached) return cached;
      const entries: ManifestEntry[] = groups.map((group) => {
        const source =
          group.find((entry) => entry.dialect === dialect) ?? group.find((entry) => entry.dialect === null);
        if (!source)
          throw sourceError(
            `No ${dialect} or generic source for ${group[0]!.version === null ? `repeatable ${group[0]!.description}` : `version ${group[0]!.version}`}`,
          );
        return {
          version: source.version,
          description: source.description,
          source: source.source,
          checksum: source.checksum,
          load: source.typescript ? () => loadTypeScript(source) : async () => source.text,
        };
      });
      const versioned = entries
        .filter((entry) => entry.version !== null)
        .sort((a, b) => compareVersions(a.version!, b.version!));
      const repeatable = entries
        .filter((entry) => entry.version === null)
        .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
      cached = {
        hash: checksum(JSON.stringify([versioned.map(identity), repeatable.map(identity)])),
        versioned,
        repeatable,
      };
      return cached;
    };
    Object.defineProperty(dialects, dialect, { enumerable: true, get: select });
    if (options.dialects) select();
  }
  return { format: "sqlbraid-migrations", formatVersion: 1, dialects };
}

/** Read trusted migration files. No migration code runs until an entry is loaded. */
export async function loadMigrations(
  directory: string,
  options: LoadMigrationsOptions = {},
): Promise<MigrationManifest> {
  return manifestFromSources(await readSources(resolve(directory)), options);
}

async function loadTypeScript(source: Source): Promise<MigrationBody> {
  if (DIRECTIVE.test(source.text))
    throw sourceError(
      `Guarded SQL directives in ${source.source} need a bundler that lowers them with @sqlbraid/vite. Use a generated manifest or the Vite plugin; the Node loader supports ordinary tags only.`,
    );
  let module: { default?: unknown };
  try {
    module = await import(pathToFileURL(source.path).href);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ERR_UNKNOWN_FILE_EXTENSION" || code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING")
      throw sourceError(
        `Cannot import TypeScript migration ${source.source}: run with a runtime or loader that handles TypeScript, or use a generated manifest.`,
        error,
      );
    throw sourceError(
      `Cannot load TypeScript migration ${source.source}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (typeof module.default === "string" || !isMigrationBody(module.default))
    throw sourceError(
      `TypeScript migration ${source.source} must export a default migration function or defineMigration() result.`,
    );
  return module.default;
}

/** Relative ESM specifier with forward slashes; `paths` is injectable so Windows behavior is testable. */
export function relativeSpecifier(
  fromDirectory: string,
  file: string,
  paths: { relative(from: string, to: string): string; isAbsolute(path: string): boolean; sep: string } = {
    relative,
    isAbsolute,
    sep,
  },
): string {
  const path = paths.relative(fromDirectory, file);
  if (paths.isAbsolute(path))
    throw sourceError(`Migration ${file} must be on the same drive as the generated manifest.`);
  const portable = path.split(paths.sep).join("/");
  return portable.startsWith("../") ? portable : `./${portable}`;
}

/** Plain ESM: SQL as string literals, TypeScript as lazy imports that the host runtime or bundler resolves. */
export async function manifestModuleSource(
  directory: string,
  options: LoadMigrationsOptions,
  specifier: (file: string) => string,
): Promise<{ readonly code: string; readonly sources: readonly Source[] }> {
  const sources = await readSources(resolve(directory));
  const manifest = manifestFromSources(sources, options, true);
  const bySource = new Map(sources.map((source) => [source.source, source]));
  const loaders = new Map<string, string>();
  const entryCode = (entry: ManifestEntry): string => {
    const source = bySource.get(entry.source)!;
    let loader = loaders.get(source.source);
    if (!loader) {
      loader = source.typescript
        ? `async () => (await import(${JSON.stringify(specifier(source.path))})).default`
        : `async () => ${JSON.stringify(source.text)}`;
      loaders.set(source.source, loader);
    }
    return `{ version: ${JSON.stringify(entry.version)}, description: ${JSON.stringify(entry.description)}, source: ${JSON.stringify(entry.source)}, checksum: ${JSON.stringify(entry.checksum)}, load: ${loader} }`;
  };
  const dialectCode = Object.entries(manifest.dialects).map(
    ([dialect, entries]) =>
      `    ${JSON.stringify(dialect)}: {\n      hash: ${JSON.stringify(entries.hash)},\n      versioned: [${entries.versioned.map((entry) => `\n        ${entryCode(entry)}`).join(",")}\n      ],\n      repeatable: [${entries.repeatable.map((entry) => `\n        ${entryCode(entry)}`).join(",")}\n      ],\n    }`,
  );
  return {
    code: `// Generated by @sqlbraid/migrate. Do not edit.\nexport default {\n  format: "sqlbraid-migrations",\n  formatVersion: 1,\n  dialects: {\n${dialectCode.join(",\n")}\n  },\n};\n`,
    sources,
  };
}

/** Generate a plain ESM manifest. The caller writes it at `outfile`; a bundler or the host runtime loads TypeScript. */
export async function generateManifestModule(
  directory: string,
  options: GenerateManifestOptions = {},
): Promise<string> {
  const from = dirname(resolve(options.outfile ?? join(directory, "manifest.mjs")));
  return (await manifestModuleSource(directory, options, (file) => relativeSpecifier(from, file))).code;
}
