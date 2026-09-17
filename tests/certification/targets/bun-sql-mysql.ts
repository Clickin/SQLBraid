import { sql as tag } from "@sqlbraid/mysql";
import type { BunSqlClient } from "@sqlbraid/bun-sql";
import { createBunSqlCertificationTarget } from "./bun-sql.js";

export function createBunSqlMysqlTarget(sourceSha: string, createClient: () => BunSqlClient) {
  return createBunSqlCertificationTarget({ dialect: "mysql", sourceSha, tag, createClient });
}
