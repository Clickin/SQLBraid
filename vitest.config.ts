import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const sourceAliases = {
  "#async-context": resolve("packages/runtime/src/async-context.node.ts"),
  "@sqlbraid/core": resolve("packages/core/src/index.ts"),
  "@sqlbraid/codegen": resolve("packages/codegen/src/index.ts"),
  "@sqlbraid/template": resolve("packages/template/src/index.ts"),
  "@sqlbraid/metadata": resolve("packages/metadata/src/index.ts"),
  "@sqlbraid/compiler": resolve("packages/compiler/src/index.ts"),
  "@sqlbraid/vite": resolve("packages/vite/src/index.ts"),
  "@sqlbraid/tooling": resolve("packages/tooling/src/index.ts"),
  "@sqlbraid/cli": resolve("packages/cli/src/index.ts"),
  "@sqlbraid/cli/config": resolve("packages/cli/src/config.ts"),

  "@sqlbraid/runtime": resolve("packages/runtime/src/index.ts"),
  "@sqlbraid/operations": resolve("packages/operations/src/index.ts"),
  "@sqlbraid/language-server": resolve("packages/language-server/src/index.ts"),
  "@sqlbraid/postgres/pg": resolve("packages/postgres/src/pg.ts"),
  "@sqlbraid/postgres/inspector": resolve("packages/postgres/src/inspector.ts"),
  "@sqlbraid/postgres": resolve("packages/postgres/src/index.ts"),
  "@sqlbraid/oracle/oracledb": resolve("packages/oracle/src/oracledb.ts"),
  "@sqlbraid/oracle/inspector": resolve("packages/oracle/src/inspector.ts"),
  "@sqlbraid/oracle": resolve("packages/oracle/src/index.ts"),
  "@sqlbraid/mssql/tedious": resolve("packages/mssql/src/tedious.ts"),
  "@sqlbraid/mssql/inspector": resolve("packages/mssql/src/inspector.ts"),
  "@sqlbraid/mssql": resolve("packages/mssql/src/index.ts"),
  "@sqlbraid/mysql/mysql2": resolve("packages/mysql/src/mysql2.ts"),
  "@sqlbraid/mysql/inspector": resolve("packages/mysql/src/inspector.ts"),
  "@sqlbraid/mysql": resolve("packages/mysql/src/index.ts"),
  "@sqlbraid/mariadb/mariadb": resolve("packages/mariadb/src/mariadb.ts"),
  "@sqlbraid/mariadb": resolve("packages/mariadb/src/index.ts"),
  "@sqlbraid/sqlite/wasm": resolve("packages/sqlite/src/wasm.ts"),
  "@sqlbraid/sqlite/d1": resolve("packages/sqlite/src/d1.ts"),
  "@sqlbraid/sqlite/node-sqlite": resolve("packages/sqlite/src/node-sqlite.ts"),
  "@sqlbraid/sqlite/inspector": resolve("packages/sqlite/src/inspector.ts"),
  "@sqlbraid/sqlite": resolve("packages/sqlite/src/index.ts"),
};

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        resolve: { alias: sourceAliases },
        test: {
          name: "unit",
          include: ["tests/*.test.ts"],
          exclude: ["tests/consumer.test.ts", "tests/cli.test.ts", "tests/db/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "cli",
          include: ["tests/cli.test.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "db-sqlite",
          include: ["tests/db/sqlite/**/*.test.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "db-postgres",
          include: ["tests/db/postgres/**/*.test.ts"],
          globalSetup: ["./tests/db/postgres.global.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "db-mysql",
          include: ["tests/db/mysql/**/*.test.ts"],
          globalSetup: ["./tests/db/mysql.global.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "db-mariadb",
          include: ["tests/db/mariadb/**/*.test.ts"],
          globalSetup: ["./tests/db/mariadb.global.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "consumer",
          include: ["tests/consumer.test.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "db-oracle",
          include: ["tests/db/oracle/**/*.test.ts"],
          globalSetup: ["./tests/db/oracle.global.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "db-mssql",
          include: ["tests/db/mssql/**/*.test.ts"],
          globalSetup: ["./tests/db/mssql.global.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
