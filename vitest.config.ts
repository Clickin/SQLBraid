import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const sourceAliases = {
  "@sqlbraid/core": resolve("packages/core/src/index.ts"),
  "@sqlbraid/template": resolve("packages/template/src/index.ts"),
  "@sqlbraid/schema": resolve("packages/schema/src/index.ts"),
  "@sqlbraid/compiler": resolve("packages/compiler/src/index.ts"),

  "@sqlbraid/runtime": resolve("packages/runtime/src/index.ts"),
  "@sqlbraid/operations": resolve("packages/operations/src/index.ts"),
  "@sqlbraid/language-server": resolve("packages/language-server/src/index.ts"),
  "@sqlbraid/postgres/pg": resolve("packages/postgres/src/pg.ts"),
  "@sqlbraid/postgres": resolve("packages/postgres/src/index.ts"),
  "@sqlbraid/mysql/mysql2": resolve("packages/mysql/src/mysql2.ts"),
  "@sqlbraid/mysql": resolve("packages/mysql/src/index.ts"),
  "@sqlbraid/sqlite/node-sqlite": resolve("packages/sqlite/src/node-sqlite.ts"),
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
          name: "consumer",
          include: ["tests/consumer.test.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
