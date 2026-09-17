import { sql as tag } from "@sqlbraid/postgres";
import type { BunSqlClient } from "@sqlbraid/bun-sql";
import { createBunSqlCertificationTarget } from "./bun-sql.js";

export function createBunSqlPostgresTarget(sourceSha: string, createClient: () => BunSqlClient) {
  return createBunSqlCertificationTarget({ dialect: "postgres", sourceSha, tag, createClient });
}
