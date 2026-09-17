import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 1,
    projects: [
      {
        test: {
          name: "cert-pg",
          include: ["tests/certification/targets/postgres-pg.certification.ts"],
          globalSetup: ["./tests/db/postgres.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-mysql",
          include: ["tests/certification/targets/mysql-mysql2.certification.ts"],
          globalSetup: ["./tests/db/mysql.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-mariadb",
          include: ["tests/certification/targets/mariadb.certification.ts"],
          globalSetup: ["./tests/db/mariadb.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-oracle",
          include: ["tests/certification/targets/oracle-oracledb.certification.ts"],
          globalSetup: ["./tests/db/oracle.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-mssql",
          include: ["tests/certification/targets/mssql-tedious.certification.ts"],
          globalSetup: ["./tests/db/mssql.global.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "cert-sqlite",
          include: ["tests/certification/targets/sqlite-local.certification.ts"],
          fileParallelism: false,
        },
      },
      { test: { name: "cert-validate", include: ["tests/certification/validate.cert.ts"], fileParallelism: false } },
      { test: { name: "cert-aggregate", include: ["tests/certification/aggregate.cert.ts"], fileParallelism: false } },
    ],
  },
});
