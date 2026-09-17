import assert from "node:assert/strict";
import { SQL } from "bun";

assert.equal(Bun.version, process.env.BUN_SQL_DIAGNOSTIC_VERSION ?? "1.3.14");
const url = process.env.SQLBRAID_BUN_SQL_POSTGRES_URL ?? process.env.SQLBRAID_POSTGRES_URL;
assert.ok(url, "Missing SQLBRAID_POSTGRES_URL");
const client = new SQL(url, { bigint: true, max: 1 });
const observer = new SQL(url, { bigint: true, max: 1 });
const result = { runtime: Bun.version };
let phase = "setup";
const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ...result, hungAt: phase }, null, 2));
  process.exit(1);
}, 5000);
try {
  result.version = (await observer.unsafe("SHOW server_version", []))[0].server_version;
  await observer.unsafe("DROP TABLE IF EXISTS braid_bun_discard_repro", []);
  await observer.unsafe("CREATE TABLE braid_bun_discard_repro (id TEXT PRIMARY KEY)", []);
  const reserved = await client.reserve();
  result.before = String((await reserved.unsafe("SELECT pg_backend_pid() AS id", []))[0].id);
  await reserved.unsafe("BEGIN", []);
  await reserved`INSERT INTO braid_bun_discard_repro VALUES (${"A"})`;
  await assert.rejects(reserved`INSERT INTO braid_bun_discard_repro VALUES (${"A"})`, (error) => error.errno === "23505");
  result.terminalCommand = (await reserved.unsafe("COMMIT", [])).command;
  assert.equal(result.terminalCommand, "ROLLBACK");
  phase = "reserved-close";
  await reserved.close({ timeout: 0 });
  phase = "pool-reuse";
  result.after = String((await client.unsafe("SELECT pg_backend_pid() AS id", []))[0].id);
  assert.notEqual(result.before, result.after);
  assert.equal((await observer.unsafe("SELECT pid FROM pg_stat_activity WHERE pid = $1", [result.before])).length, 0);
  assert.equal((await observer.unsafe("SELECT id FROM braid_bun_discard_repro", [])).length, 0);
  await client`INSERT INTO braid_bun_discard_repro VALUES (${"B"})`;
  result.durableRows = (await observer.unsafe("SELECT id FROM braid_bun_discard_repro", [])).map((row) => row.id);
  assert.deepEqual(result.durableRows, ["B"]);
  phase = "client-close";
  const start = performance.now();
  await client.close({ timeout: Number(process.env.BUN_SQL_CLOSE_TIMEOUT ?? 1) });
  result.closeMs = Math.round(performance.now() - start);
} finally {
  await observer.unsafe("DROP TABLE IF EXISTS braid_bun_discard_repro", []);
  await observer.close({ timeout: 1 });
  clearTimeout(watchdog);
}
console.log(JSON.stringify(result, null, 2));
