import { sql as tag } from "@sqlbraid/mariadb";
import type { BunSqlClient } from "@sqlbraid/bun-sql";
import { createBunSqlCertificationTarget } from "./bun-sql.js";

export function createBunSqlMariadbTarget(sourceSha: string, createClient: () => BunSqlClient) {
  return createBunSqlCertificationTarget({ dialect: "mariadb", sourceSha, tag, createClient });
}
