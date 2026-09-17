import { defineConfig } from "vitest/config";

const targetDir = "tests/certification/targets";

export default defineConfig({
  test: {
    maxWorkers: process.env.CI ? 1 : undefined,
    projects: [
      {
        test: {
          name: "cert-pg",
          include: [`${targetDir}/postgres-*.certification.ts`],
          globalSetup: ["./tests/db/postgres.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-mysql",
          include: [`${targetDir}/mysql-*.certification.ts`],
          globalSetup: ["./tests/db/mysql.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-mariadb",
          include: [`${targetDir}/mariadb*.certification.ts`],
          globalSetup: ["./tests/db/mariadb.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-oracle",
          include: [`${targetDir}/oracle-*.certification.ts`],
          globalSetup: ["./tests/db/oracle.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-mssql",
          include: [`${targetDir}/mssql-*.certification.ts`],
          globalSetup: ["./tests/db/mssql.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-sqlite",
          include: [`${targetDir}/sqlite-*.certification.ts`],
          fileParallelism: false,
        },
      },
    ],
  },
});
