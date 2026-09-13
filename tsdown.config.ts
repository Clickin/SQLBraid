import { defineConfig, type UserConfig } from "tsdown";

const shared: UserConfig = {
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: { sourcemap: true },
  clean: true,
  minify: false,
  deps: { neverBundle: true },
  publint: { enabled: "ci-only", level: "error" },
  attw: { enabled: "ci-only", level: "error" },
  exports: false,

  tsconfig: "../../tsconfig.json",
};

function packageBuild(cwd: string, entry: Record<string, string>): UserConfig {
  return { ...shared, cwd, entry, outDir: "dist" };
}

export default defineConfig([
  packageBuild("packages/core", { index: "src/index.ts" }),
  packageBuild("packages/codegen", { index: "src/index.ts" }),
  packageBuild("packages/template", { index: "src/index.ts" }),

  packageBuild("packages/metadata", { index: "src/index.ts" }),
  packageBuild("packages/compiler", { index: "src/index.ts" }),
  packageBuild("packages/operations", { index: "src/index.ts" }),
  packageBuild("packages/runtime", { index: "src/index.ts" }),
  packageBuild("packages/postgres", { index: "src/index.ts", pg: "src/pg.ts", inspector: "src/inspector.ts" }),
  packageBuild("packages/mysql", { index: "src/index.ts", mysql2: "src/mysql2.ts", inspector: "src/inspector.ts" }),
  packageBuild("packages/sqlite", { index: "src/index.ts", "node-sqlite": "src/node-sqlite.ts", inspector: "src/inspector.ts" }),
  packageBuild("packages/language-server", { index: "src/index.ts", server: "src/server.ts", cli: "src/cli.ts" }),
  packageBuild("packages/cli", { index: "src/index.ts", config: "src/config.ts" }),
]);
