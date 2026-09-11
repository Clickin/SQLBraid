import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/*.test.ts"],
          exclude: ["tests/consumer.test.ts", "tests/db/**"],
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
