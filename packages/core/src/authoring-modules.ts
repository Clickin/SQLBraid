/** Data-only authoring identity shared by compiler, tooling, and editor consumers. */
export type AuthoringModuleCatalogEntry = {
  readonly moduleSpecifier: string;
  readonly dialectId?: "postgres" | "mysql" | "mariadb" | "sqlite" | "oracle" | "mssql";
  readonly helperFamily: "template" | "facade";
};

export const AUTHORING_MODULE_CATALOG: readonly AuthoringModuleCatalogEntry[] = Object.freeze(
  (
    [
      { moduleSpecifier: "@sqlbraid/template", helperFamily: "template" },
      { moduleSpecifier: "@sqlbraid/postgres", dialectId: "postgres", helperFamily: "template" },
      { moduleSpecifier: "@sqlbraid/mysql", dialectId: "mysql", helperFamily: "template" },
      { moduleSpecifier: "@sqlbraid/mariadb", dialectId: "mariadb", helperFamily: "template" },
      { moduleSpecifier: "@sqlbraid/sqlite", dialectId: "sqlite", helperFamily: "template" },

      { moduleSpecifier: "@sqlbraid/oracle", dialectId: "oracle", helperFamily: "template" },
      { moduleSpecifier: "@sqlbraid/mssql", dialectId: "mssql", helperFamily: "template" },
      { moduleSpecifier: "sqlbraid/pg", dialectId: "postgres", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/mysql2", dialectId: "mysql", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/mariadb", dialectId: "mariadb", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/node-sqlite", dialectId: "sqlite", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/better-sqlite3", dialectId: "sqlite", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/libsql", dialectId: "sqlite", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/sqlite-wasm", dialectId: "sqlite", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/d1", dialectId: "sqlite", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/oracledb", dialectId: "oracle", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/tedious", dialectId: "mssql", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/postgres", dialectId: "postgres", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/mysql", dialectId: "mysql", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/sqlite", dialectId: "sqlite", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/oracle", dialectId: "oracle", helperFamily: "facade" },
      { moduleSpecifier: "sqlbraid/mssql", dialectId: "mssql", helperFamily: "facade" },
    ] as const
  ).map((entry) => Object.freeze(entry)),
);
