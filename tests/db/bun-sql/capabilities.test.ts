import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inject, test } from "vitest";

const execute = promisify(execFile);

async function verifyBackend(dialect: string): Promise<void> {
  const postgres = inject("postgres") as { readonly connectionUri: string };
  const mysql = inject("mysql") as { readonly connectionUri: string };
  const mariadb = inject("mariadb") as { readonly connectionUri: string };
  const { stdout } = await execute("bun", ["scripts/bun-sql-matrix.mjs", dialect], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      SQLBRAID_BUN_SQL_POSTGRES_URL: postgres.connectionUri,
      SQLBRAID_BUN_SQL_MYSQL_URL: mysql.connectionUri,
      SQLBRAID_BUN_SQL_MARIADB_URL: mariadb.connectionUri,
    },
  });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.runtime, { id: "bun", version: "1.3.14" });
  assert.equal(result.results[0].dialect, dialect);
}

test("bun-sql-postgres.data.profile", { timeout: 65_000 }, () => verifyBackend("postgres"));
test("bun-sql-mysql.data.profile", { timeout: 65_000 }, () => verifyBackend("mysql"));
test("bun-sql-mariadb.data.profile", { timeout: 65_000 }, () => verifyBackend("mariadb"));
test("bun-sql-sqlite.data.profile", { timeout: 65_000 }, () => verifyBackend("sqlite"));
