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
  packageBuild("packages/vite", { index: "src/index.ts" }),
  packageBuild("packages/tooling", { index: "src/index.ts", "config-worker": "src/config-worker.ts" }),
  packageBuild("packages/operations", { index: "src/index.ts" }),
  {
    ...packageBuild("packages/runtime", {
      index: "src/index.ts",
      "async-context": "src/async-context.ts",
      "async-context.node": "src/async-context.node.ts",
      "async-context.browser": "src/async-context.browser.ts",
    }),
    deps: { neverBundle: ["#async-context"] },
  },
  packageBuild("packages/postgres", { index: "src/index.ts", pg: "src/pg.ts", inspector: "src/inspector.ts" }),
  packageBuild("packages/oracle", { index: "src/index.ts", oracledb: "src/oracledb.ts", inspector: "src/inspector.ts" }),
  packageBuild("packages/mssql", { index: "src/index.ts", tedious: "src/tedious.ts", inspector: "src/inspector.ts" }),
  packageBuild("packages/sqlbraid", { index: "src/index.ts" }),
  packageBuild("packages/mysql", { index: "src/index.ts", mysql2: "src/mysql2.ts", inspector: "src/inspector.ts" }),
  packageBuild("packages/mariadb", { index: "src/index.ts", mariadb: "src/mariadb.ts", inspector: "src/inspector.ts" }),
  packageBuild("packages/sqlite", { index: "src/index.ts", "node-sqlite": "src/node-sqlite.ts", inspector: "src/inspector.ts", wasm: "src/wasm.ts", d1: "src/d1.ts" }),
  packageBuild("packages/language-server", { index: "src/index.ts", server: "src/server.ts", cli: "src/cli.ts" }),
  packageBuild("packages/cli", { index: "src/index.ts", config: "src/config.ts" }),
  packageBuild("packages/bun-sql", { index: "src/index.ts" }),
]);
