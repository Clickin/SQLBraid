import assert from "node:assert/strict";
import { SQL } from "bun";

const dialect = process.argv[2] ?? "mysql";
assert.ok(dialect === "mysql" || dialect === "mariadb");
const prefix = dialect.toUpperCase();
const url = process.env[`SQLBRAID_BUN_SQL_${prefix}_URL`] ?? process.env[`SQLBRAID_${prefix}_URL`];
assert.ok(url, `Missing SQLBRAID_${prefix}_URL`);
const client = new SQL(url, { bigint: true });
const connection = await client.reserve();
try {
  await connection.unsafe("CREATE TABLE braid_bun_sql_readonly_repro (value TEXT)", []);
  await connection.unsafe("SET SESSION TRANSACTION READ ONLY", []);
  for (const begin of ["START TRANSACTION", "START TRANSACTION READ ONLY"]) {
    await connection.unsafe(begin, []);
    await assert.rejects(
      connection`INSERT INTO braid_bun_sql_readonly_repro (value) VALUES (${"rejected"})`,
      (error) => error.errno === 1792,
    );
    await connection.unsafe("ROLLBACK", []);
    console.error(`${dialect}: ${begin} write rejected and rolled back`);
  }
  await connection.unsafe("START TRANSACTION READ WRITE", []);
  console.error(`${dialect}: native READ WRITE started; reusing the previously rejected INSERT shape`);
  const result = await connection`INSERT INTO braid_bun_sql_readonly_repro (value) VALUES (${"accepted"})`;
  assert.equal(Number(result.affectedRows), 1);
  await connection.unsafe("COMMIT", []);
  console.log(`${dialect}: native read-write override passed`);
} finally {
  await connection.unsafe("ROLLBACK", []);
  await connection.unsafe("SET SESSION TRANSACTION READ WRITE", []);
  await connection.unsafe("DROP TABLE IF EXISTS braid_bun_sql_readonly_repro", []);
  await connection.release();
  await client.close({ timeout: 0 });
}
