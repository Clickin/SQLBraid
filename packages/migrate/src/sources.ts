import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MigrationError } from "./errors.js";
import { compareVersions, normalizeVersion } from "./manifest.js";
import type { DialectManifest, ManifestEntry, MigrationManifest } from "./types.js";

export interface LoadMigrationsOptions {
  /** With no target list, dialects resolve lazily when a migrator selects its target. */
  readonly dialects?: readonly string[];
}

export interface Source {
  readonly version: string | null;
  readonly description: string;
  readonly source: string;
  readonly dialect: string | null;
  readonly text: string;
  readonly checksum: string;
}

const DIALECTS = ["postgres", "mysql", "mariadb", "sqlite", "oracle", "mssql"];
/** A file with a migration name prefix. Only `.sql` files are migrations; other extensions fail, not skip. */
const MIGRATION_NAME = /^(?:V\d[\d._]*__|R__)/u;
/** A `.sql` name that looks like a mistyped migration name fails, so that a typo cannot skip a migration silently. */
const NEAR_MIGRATION_NAME = /^(?:[Vv]\d|R_|r__)/u;

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
      if (!kind.isFile()) continue;
      if (!MIGRATION_NAME.test(entry.name)) {
        if (entry.name.endsWith(".sql") && NEAR_MIGRATION_NAME.test(entry.name)) {
          throw sourceError(
            `Invalid migration filename: ${source}. Use V<version>__<description>.sql or R__<description>.sql, with an uppercase prefix and two underscores.`,
          );
        }
        continue;
      }
      if (!entry.name.endsWith(".sql"))
        throw sourceError(`Migration ${source} is not a .sql file. SQLBraid migrations are SQL files only.`);
      const match = /^(?:V(\d+(?:[._]\d+)*)__|R__)(.+)\.sql$/u.exec(entry.name);
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
      const text = normalizeSource(await readFile(join(directory, source), "utf8"));
      sources.push({ version, description, source, dialect, text, checksum: checksum(text) });
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
          sql: source.text,
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

/** Read trusted SQL migration files. No SQL runs until a migrator applies an entry. */
export async function loadMigrations(
  directory: string,
  options: LoadMigrationsOptions = {},
): Promise<MigrationManifest> {
  return manifestFromSources(await readSources(resolve(directory)), options);
}

/** Plain ESM with SQL text as string literals. The module has no imports, so any host or bundler can load it. */
export async function generateManifestModule(directory: string, options: LoadMigrationsOptions = {}): Promise<string> {
  const manifest = manifestFromSources(await readSources(resolve(directory)), options, true);
  return `// Generated by @sqlbraid/migrate. Do not edit.\nexport default ${JSON.stringify(manifest, null, 2)};\n`;
}
