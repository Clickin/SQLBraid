import type { DatabaseOptions } from "@sqlbraid/core";

/** Physical dialect selected by the application; Bun.SQL does not infer PostgreSQL/MySQL/MariaDB/SQLite. */
export type BunSqlDialect = "postgres" | "mysql" | "mariadb" | "sqlite";

export interface BunSqlClient {
  <T = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): PromiseLike<T>;
  unsafe<T = unknown>(text: string, values?: readonly unknown[]): PromiseLike<T>;
  reserve?: () => Promise<BunSqlReservedClient>;
  close?: (options?: { readonly timeout?: number }) => Promise<void>;
  readonly options?: { readonly bigint?: boolean; readonly prepare?: boolean; readonly adapter?: string };
}

export interface BunSqlReservedClient extends BunSqlClient {
  release(): void | Promise<void>;
}

/** Bun.SQL database options. `dialect` is mandatory because the same client shape serves multiple databases. */
export interface BunSqlDatabaseOptions extends DatabaseOptions {
  readonly dialect: BunSqlDialect;
}
