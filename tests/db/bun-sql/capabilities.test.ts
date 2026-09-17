import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, inject, test } from "vitest";
import { commandMetadataTitle } from "../command-metadata.js";

const execute = promisify(execFile);

async function verifyBackend(dialect: string): Promise<{
  readonly contractAssertions: readonly { readonly fullName: string; readonly status: string }[];
  readonly representations: { readonly exact_integer: string };
  readonly bulk: { readonly inputCount: number; readonly affectedRows: number };
}> {
  const postgres = inject("postgres") as { readonly connectionUri: string };
  const mysql = inject("mysql") as { readonly connectionUri: string };
  const mariadb = inject("mariadb") as { readonly connectionUri: string };
  const { stdout } = await execute("bun", ["tests/scripts/bun-sql-matrix.mjs", dialect], {
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
  return result.results[0];
}

const results = new Map<string, ReturnType<typeof verifyBackend>>();
function backend(dialect: string): ReturnType<typeof verifyBackend> {
  let result = results.get(dialect);
  if (!result) {
    result = verifyBackend(dialect);
    results.set(dialect, result);
  }
  return result;
}

async function verifyProfile(dialect: string): Promise<void> {
  const result = await backend(dialect);
  assert.equal(result.representations.exact_integer, "9007199254740993");
  assert.deepEqual(result.bulk, { inputCount: 2, affectedRows: 2 });
}

test("bun-sql-postgres.data.profile", { timeout: 65_000 }, () => verifyProfile("postgres"));
test("bun-sql-mysql.data.profile", { timeout: 65_000 }, () => verifyProfile("mysql"));
test("bun-sql-mariadb.data.profile", { timeout: 65_000 }, () => verifyProfile("mariadb"));
test("bun-sql-sqlite.data.profile", { timeout: 65_000 }, () => verifyProfile("sqlite"));

for (const dialect of ["postgres", "mysql", "mariadb", "sqlite"]) {
  describe(`Bun SQL ${dialect}`, () => {
    let result: Awaited<ReturnType<typeof verifyBackend>>;
    beforeAll(async () => {
      result = await backend(dialect);
    }, 65_000);
    const scenarios = [
      "transaction.commit-confirmed",
      "transaction.callback-rollback",
      "transaction.statement-rollback",
      "transaction.caught-error-terminal-outcome",
      "transaction.savepoint-recovery",
      ...(dialect === "sqlite"
        ? []
        : ["transaction.access-mode", "resource.session-lease", "resource.transaction-lease"]),
    ];
    for (const scenario of scenarios) {
      const title = `[contract:bun-sql-${dialect}:${scenario}:integration] [ownership:${dialect === "sqlite" ? "direct" : "pooled"}]`;
      test(title, () => {
        assert.deepEqual(
          result.contractAssertions.find((entry) => entry.fullName === title),
          {
            fullName: title,
            status: "passed",
          },
        );
      });
    }
    const metadataTitle =
      dialect === "postgres"
        ? "[contract:bun-sql-postgres:metadata.affected-rows:integration]"
        : commandMetadataTitle(`bun-sql-${dialect}`);
    test(metadataTitle, () => {
      assert.deepEqual(
        result.contractAssertions.find((entry) => entry.fullName === metadataTitle),
        {
          fullName: metadataTitle,
          status: "passed",
        },
      );
    });
  });
}
