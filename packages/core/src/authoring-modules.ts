/** Data-only authoring identity shared by compiler, tooling, and editor consumers. */
export type AuthoringModuleCatalogEntry = {
  readonly moduleSpecifier: string;
  readonly dialectId?: "postgres" | "mysql" | "mariadb" | "sqlite" | "oracle" | "mssql";
};

export const AUTHORING_MODULE_CATALOG: readonly AuthoringModuleCatalogEntry[] = Object.freeze(
  (
    [
      { moduleSpecifier: "@sqlbraid/template" },
      { moduleSpecifier: "@sqlbraid/postgres", dialectId: "postgres" },
      { moduleSpecifier: "@sqlbraid/mysql", dialectId: "mysql" },
      { moduleSpecifier: "@sqlbraid/mariadb", dialectId: "mariadb" },
      { moduleSpecifier: "@sqlbraid/sqlite", dialectId: "sqlite" },
      { moduleSpecifier: "@sqlbraid/oracle", dialectId: "oracle" },
      { moduleSpecifier: "@sqlbraid/mssql", dialectId: "mssql" },
    ] as const
  ).map((entry) => Object.freeze(entry)),
);
