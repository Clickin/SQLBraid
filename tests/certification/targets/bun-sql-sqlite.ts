import { sql as tag } from "@sqlbraid/sqlite";
import type { BunSqlClient } from "@sqlbraid/bun-sql";
import { createBunSqlCertificationTarget } from "./bun-sql.js";

export function createBunSqlSqliteTarget(sourceSha: string, createClient: () => BunSqlClient) {
  return createBunSqlCertificationTarget({ dialect: "sqlite", sourceSha, tag, createClient });
}
