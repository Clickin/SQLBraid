import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { loadMigrations } from "../packages/migrate/src/node.js";

interface ResolveArgs {
  readonly path: string;
  readonly importer: string;
  readonly namespace: string;
  readonly resolveDir: string;
  readonly kind: string;
  readonly pluginData: unknown;
  readonly with: Record<string, string>;
}
type ResolveResult = { readonly external?: boolean } | null | undefined;
interface ResolveHandler {
  readonly filter: RegExp;
  readonly callback: (args: ResolveArgs) => ResolveResult | Promise<ResolveResult>;
}
interface Plugin {
  readonly name: string;
  setup(builder: unknown): unknown;
}
interface BuildOptions {
  readonly plugins?: readonly Plugin[];
}

const builds = vi.hoisted((): BuildOptions[] => []);

// esbuild belongs to @sqlbraid/migrate, so mock the copy that the migration loader resolves.
vi.mock("../packages/migrate/node_modules/esbuild", async (importOriginal) => {
  const actual = await importOriginal<{ build(options: BuildOptions): Promise<unknown> }>();
  return {
    ...actual,
    build: (options: BuildOptions) => {
      builds.push(options);
      return actual.build(options);
    },
  };
});

async function resolveHandlers(plugins: readonly Plugin[]): Promise<ResolveHandler[]> {
  const handlers: ResolveHandler[] = [];
  const builder = {
    onResolve: (options: { filter: RegExp }, callback: ResolveHandler["callback"]) => {
      handlers.push({ filter: options.filter, callback });
    },
    onLoad: () => undefined,
    onStart: () => undefined,
    onEnd: () => undefined,
    onDispose: () => undefined,
    resolve: async (path: string) => ({
      path,
      external: false,
      errors: [],
      warnings: [],
      namespace: "file",
      suffix: "",
      sideEffects: true,
      pluginData: undefined,
    }),
    initialOptions: {},
  };
  await Promise.all(plugins.map((plugin) => plugin.setup(builder)));
  return handlers;
}

test("TypeScript migration loading keeps Windows absolute entry paths inside the bundle", async () => {
  const path = await mkdtemp(join(tmpdir(), "sqlbraid-migrations-windows-"));
  try {
    await writeFile(join(path, "V1__ts.ts"), "export default async () => {};");
    const manifest = await loadMigrations(path, { dialects: ["sqlite"] });
    builds.length = 0;
    assert.equal(typeof (await manifest.dialects.sqlite!.versioned[0]!.load()), "function");
    const plugins = builds.flatMap((options) => options.plugins ?? []);
    assert.ok(plugins.length > 0, "the Node loader must bundle through esbuild plugins");
    const handlers = await resolveHandlers(plugins);
    const cases = ["C:\\proj\\migrations\\V2__x.ts", "D:/proj/migrations/V2__x.ts"].flatMap((windowsPath) =>
      (["entry-point", "import-statement"] as const).flatMap((kind) =>
        handlers
          .filter((handler) => handler.filter.test(windowsPath))
          .map(async (handler) => {
            const result = await handler.callback({
              path: windowsPath,
              importer: kind === "entry-point" ? "" : "C:\\proj\\migrations\\V1__ts.ts",
              namespace: "file",
              resolveDir: "C:\\proj\\migrations",
              kind,
              pluginData: undefined,
              with: {},
            });
            assert.notEqual(result?.external, true, `${kind} ${windowsPath} must not become an external import`);
          }),
      ),
    );
    await Promise.all(cases);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
