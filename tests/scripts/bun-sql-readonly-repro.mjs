import assert from "node:assert/strict";
import { SQL } from "bun";

const dialect = process.argv[2] ?? "mysql";
assert.ok(dialect === "mysql" || dialect === "mariadb");
const prefix = dialect.toUpperCase();
const url = process.env[`SQLBRAID_BUN_SQL_${prefix}_URL`] ?? process.env[`SQLBRAID_${prefix}_URL`];
assert.ok(url, `Missing SQLBRAID_${prefix}_URL`);
assert.equal(Bun.version, process.env.BUN_SQL_DIAGNOSTIC_VERSION ?? "1.3.14",
  "Use the certified Bun version or explicitly identify a comparative diagnostic version");
const observer = new SQL(url, { bigint: true, max: 1 });
const version = (await observer.unsafe("SELECT VERSION() AS version", []))[0].version;
const errorInfo = (error) => ({ code: error.code, errno: error.errno, sqlState: error.sqlState });
const physicalId = async (sql) => String((await sql.unsafe("SELECT CONNECTION_ID() AS id", []))[0].id);
const tagged = (sql, value) => sql`INSERT INTO braid_bun_sql_readonly_repro (value) VALUES (${value})`;
const unsafe = (sql, value) => sql.unsafe("INSERT INTO braid_bun_sql_readonly_repro (value) VALUES (?)", [value]);
const variants = [
  { id: "A", description: "same connection, same tagged shape" },
  { id: "B", description: "same connection, different tagged shape", differentShape: true },
  { id: "C", description: "close reserved connection, fresh reserve", discard: true },
  { id: "D", description: "prepare:false, same tagged shape", prepare: false },
  { id: "E", description: "native begin helper, same tagged shape", begin: true },
  { id: "F", description: "unsafe with bound values, same shape", unsafe: true },
  { id: "G", description: "close entire client, new client, same tagged shape", newClient: true },
];
const selected = process.argv[3];
assert.ok(selected === undefined || variants.some((variant) => variant.id === selected), "Unknown variant");
const results = [];
try {
  for (const variant of variants.filter((item) => selected === undefined || item.id === selected)) {
    console.error(`[bun-sql:${dialect}] START native-${variant.id}`);
    let client;
    let reserved;
    const result = { variant: variant.id, description: variant.description };
    let phase = "setup";
    const watchdog = setTimeout(() => {
      console.log(JSON.stringify({ runtime: Bun.version, dialect, version, results: [...results, { ...result, hungAt: phase }] }, null, 2));
      process.exit(1);
    }, 10000);
    try {
      await observer.unsafe("DROP TABLE IF EXISTS braid_bun_sql_readonly_repro", []);
      await observer.unsafe("CREATE TABLE braid_bun_sql_readonly_repro (value VARCHAR(255))", []);
      client = new SQL(url, { bigint: true, max: 1, prepare: variant.prepare ?? true });
      const write = variant.unsafe ? unsafe : tagged;
      if (variant.begin) {
        result.before = await physicalId(client);
        await client.unsafe("SET SESSION TRANSACTION READ ONLY", []);
        await assert.rejects(client.begin("read only", async (tx) => write(tx, "rejected")), (error) => {
          result.rejected = errorInfo(error);
          return error.errno === 1792;
        });
        phase = "read-write";
        await client.begin("read write", async (tx) => {
          result.after = await physicalId(tx);
          result.affectedRows = Number((await write(tx, "accepted")).affectedRows);
        });
      } else {
        reserved = await client.reserve();
        result.before = await physicalId(reserved);
        await reserved.unsafe("SET SESSION TRANSACTION READ ONLY", []);
        await reserved.unsafe("START TRANSACTION READ ONLY", []);
        await assert.rejects(write(reserved, "rejected"), (error) => {
          result.rejected = errorInfo(error);
          return error.errno === 1792;
        });
        await reserved.unsafe("ROLLBACK", []);
        if (variant.discard) {
          phase = "reserved-close";
          await reserved.close({ timeout: 0 });
          reserved = undefined;
          phase = "fresh-reserve";
          reserved = await client.reserve();
        } else if (variant.newClient) {
          await reserved.release();
          reserved = undefined;
          await client.close({ timeout: 0 });
          client = new SQL(url, { bigint: true, max: 1 });
          reserved = await client.reserve();
        }
        result.after = await physicalId(reserved);
        phase = "read-write";
        await reserved.unsafe("START TRANSACTION READ WRITE", []);
        const written = variant.differentShape
          ? await reserved`INSERT INTO braid_bun_sql_readonly_repro (value) VALUES (${"accepted"}) /* different shape */`
          : await write(reserved, "accepted");
        result.affectedRows = Number(written.affectedRows);
        await reserved.unsafe("COMMIT", []);
      }
      assert.equal(result.affectedRows, 1);
      result.outcome = "write-committed";
    } catch (error) {
      result.outcome = "rejected";
      result.failurePhase = phase;
      result.error = errorInfo(error);
    } finally {
      phase = "cleanup";
      if (reserved) {
        await reserved.unsafe("ROLLBACK", []).catch(() => undefined);
        await reserved.release();
      }
      result.durableRows = (await observer.unsafe("SELECT value FROM braid_bun_sql_readonly_repro ORDER BY value", [])).map((row) => row.value);
      assert.deepEqual(result.durableRows, result.outcome === "write-committed" ? ["accepted"] : []);
      result.observer = await physicalId(observer);
      if (variant.discard) {
        assert.notEqual(result.before, result.after);
        assert.equal((await observer.unsafe("SELECT ID FROM information_schema.PROCESSLIST WHERE ID = ?", [result.before])).length, 0);
      }
      phase = "client-close";
      const closeStart = performance.now();
      // Bun 1.3.14 treats timeout:0 as unbounded, including after a reserved close.
      await client?.close({ timeout: Number(process.env.BUN_SQL_CLOSE_TIMEOUT ?? 1) });
      result.closeMs = Math.round(performance.now() - closeStart);
      phase = "cleanup";
      await observer.unsafe("DROP TABLE braid_bun_sql_readonly_repro", []);
      clearTimeout(watchdog);
    }
    results.push(result);
    console.error(`[bun-sql:${dialect}] END native-${variant.id}: ${result.outcome}`);
  }
} finally {
  await observer.close({ timeout: 0 });
}
console.log(JSON.stringify({ runtime: Bun.version, dialect, version, results }, null, 2));
