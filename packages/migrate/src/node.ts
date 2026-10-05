import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { MigrationError } from "./errors.js";
import { compareVersions, isMigrationBody, normalizeVersion } from "./manifest.js";
import type { DialectManifest, ManifestEntry, MigrationBody, MigrationManifest } from "./types.js";

export { compareVersions, normalizeVersion } from "./manifest.js";

export interface LoadMigrationsOptions {
  /** With no target list, dialects resolve lazily when a migrator selects its target. */
  readonly dialects?: readonly string[];
}

export interface GenerateManifestOptions extends LoadMigrationsOptions {
  /** Output location used by the bundler. The caller writes the returned ESM source. */
  readonly outfile?: string;
  /** Lower guarded SQL with @sqlbraid/compiler; defaults to true. */
  readonly compile?: boolean;
}

interface Source {
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
const DIRECTIVE = /\/\*\s*@braid\b/u;

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

/** esbuild is an optional peer: SQL-only directories load without it. */
async function loadEsbuild(purpose: string): Promise<typeof import("esbuild")> {
  try {
    return await import("esbuild");
  } catch (error) {
    throw sourceError(`${purpose} requires the optional esbuild peer dependency. Install esbuild.`, error);
  }
}

async function readSources(directory: string): Promise<readonly Source[]> {
  const sources: Source[] = [];
  const visited = new Set<string>();
  async function visit(relative: string): Promise<void> {
    const real = await realpath(join(directory, relative));
    if (visited.has(real))
      throw sourceError(`Migration directory ${relative} is reached twice through a symbolic link.`);
    visited.add(real);
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const source = relative ? `${relative}/${entry.name}` : entry.name;
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

function manifestFromSources(
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

function typescriptPlugin(compile: boolean, snapshots?: ReadonlyMap<string, string>): EsbuildPlugin {
  return {
    name: "sqlbraid-migration-typescript",
    setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?ts|tsx)$/ }, async ({ path }) => {
        let contents = snapshots?.get(path) ?? normalizeSource(await readFile(path, "utf8"));
        if (DIRECTIVE.test(contents)) {
          if (!compile)
            throw sourceError(
              `Guarded SQL directives in ${path} require the Vite plugin or generateManifestModule(); the Node loader supports ordinary tags only.`,
            );
          // Optional tooling peer: a static import would raise the Node loader's runtime floor.
          const { transformSource } = await import("@sqlbraid/compiler");
          const result = transformSource(contents, path);
          const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
          if (errors.length > 0)
            throw sourceError(
              errors.map((diagnostic) => `${path}: ${diagnostic.code}: ${diagnostic.message}`).join("\n"),
            );
          contents = result.code;
        }
        return { contents, loader: extname(path) === ".tsx" ? "tsx" : "ts", resolveDir: dirname(path) };
      });
    },
  };
}

/** Resolve ESM-only dependencies before evaluating the generated data URL on Node 16. */
const nodeExternals: EsbuildPlugin = {
  name: "sqlbraid-migration-node-imports",
  setup(builder) {
    builder.onResolve({ filter: /^[^./]|^node:/ }, async (args) => {
      if (args.kind === "entry-point" || win32.isAbsolute(args.path) || args.pluginData === "sqlbraid-external")
        return undefined;
      const result = await builder.resolve(args.path, {
        importer: args.importer,
        kind: args.kind,
        resolveDir: args.resolveDir,
        pluginData: "sqlbraid-external",
      });
      if (result.errors.length) return { errors: result.errors };
      if (result.external) return { path: result.path, external: true };
      return { path: pathToFileURL(result.path).href, external: true };
    });
  },
};

async function loadTypeScript(source: Source): Promise<MigrationBody> {
  const { build } = await loadEsbuild(`TypeScript migration ${source.source}`);
  try {
    const result = await build({
      entryPoints: [source.path],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: "node16.20",
      logLevel: "silent",
      plugins: [typescriptPlugin(false, new Map([[source.path, source.text]])), nodeExternals],
    });
    const code = result.outputFiles[0]!.text;
    const module: { default?: unknown } = await import(
      `data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=${pathToFileURL(source.path).href}`).toString("base64")}`
    );
    if (typeof module.default === "string" || !isMigrationBody(module.default))
      throw sourceError(
        `TypeScript migration ${source.source} must export a default migration function or defineMigration() result.`,
      );
    return module.default;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw sourceError(
      `Cannot load TypeScript migration ${source.source}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/** Bundle a portable ESM manifest. SQL is embedded; TypeScript loaders retain source checksums. */
export async function generateManifestModule(
  directory: string,
  options: GenerateManifestOptions = {},
): Promise<string> {
  const root = resolve(directory);
  const sources = await readSources(root);
  const manifest = manifestFromSources(sources, options, true);
  const bySource = new Map(sources.map((source) => [source.source, source]));
  const imports: string[] = [];
  const loaders = new Map<string, string>();
  function entryCode(entry: ManifestEntry): string {
    const source = bySource.get(entry.source)!;
    let loader = loaders.get(source.source);
    if (!loader) {
      if (source.typescript) {
        const variable = `migration${imports.length}`;
        imports.push(`import ${variable} from ${JSON.stringify(source.path)};`);
        loader = `async () => ${variable}`;
      } else {
        loader = `async () => ${JSON.stringify(source.text)}`;
      }
      loaders.set(source.source, loader);
    }
    return `{version:${JSON.stringify(entry.version)},description:${JSON.stringify(entry.description)},source:${JSON.stringify(entry.source)},checksum:${JSON.stringify(entry.checksum)},load:${loader}}`;
  }
  const dialectCode = Object.entries(manifest.dialects).map(
    ([dialect, entries]) =>
      `${JSON.stringify(dialect)}:{hash:${JSON.stringify(entries.hash)},versioned:[${entries.versioned.map(entryCode).join(",")}],repeatable:[${entries.repeatable.map(entryCode).join(",")}]}`,
  );
  const source = `${imports.join("\n")}\nexport default {format:"sqlbraid-migrations",formatVersion:1,dialects:{${dialectCode.join(",")}}};`;
  const { build } = await loadEsbuild("Migration manifest generation");
  try {
    const result = await build({
      stdin: { contents: source, resolveDir: root, sourcefile: "sqlbraid-migrations.generated.js", loader: "js" },
      outfile: options.outfile === undefined ? undefined : resolve(options.outfile),
      bundle: true,
      write: false,
      packages: "external",
      platform: "neutral",
      format: "esm",
      target: "es2021",
      logLevel: "silent",
      plugins: [typescriptPlugin(options.compile ?? true, new Map(sources.map((entry) => [entry.path, entry.text])))],
    });
    return result.outputFiles[0]!.text;
  } catch (error) {
    throw sourceError(
      `Cannot generate migration manifest: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}
