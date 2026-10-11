import assert from "node:assert/strict";
import ws from "ws";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, inject, test } from "vitest";
import { sql } from "@sqlbraid/postgres";
import { createNeonPoolDatabase } from "@sqlbraid/postgres/neon";

const WSPROXY_IMAGE = "ghcr.io/neondatabase/wsproxy:latest";

let proxy: StartedTestContainer;
let pool: Pool;

beforeAll(async () => {
  // The proxy reaches the shared PostgreSQL container through the host port.
  const database = new URL((inject("postgres") as { readonly connectionUri: string }).connectionUri);
  proxy = await new GenericContainer(WSPROXY_IMAGE)
    .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
    .withEnvironment({ ALLOW_ADDR_REGEX: ".*", APPEND_PORT: `host.docker.internal:${database.port}` })
    .withExposedPorts(80)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  neonConfig.webSocketConstructor = ws;
  neonConfig.wsProxy = () => `${proxy.getHost()}:${proxy.getMappedPort(80)}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  pool = new Pool({
    connectionString: `postgres://${database.username}:${database.password}@host.docker.internal/${database.pathname.slice(1)}`,
  });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await proxy?.stop();
}, 60_000);

test("neon.environment reports the neon driver and guards prepared statements", { timeout: 30_000 }, async () => {
  const db = createNeonPoolDatabase(pool);
  const environment = await db.environment();
  assert.equal(environment.driver.id, "neon-serverless");
  assert.equal(environment.capabilities["statement.prepare"]?.status, "guarded");
  assert.equal(environment.capabilities["statement.prepare"]?.conditionCode, "neon.pooler-transaction-mode");
  assert.equal(environment.capabilities["session.pinned"]?.status, "guaranteed");
});

test("neon.lossless text results", { timeout: 30_000 }, async () => {
  const db = createNeonPoolDatabase(pool);
  const row = await db.one(sql.rows`
    SELECT 9007199254740993::int8 AS exact_id,
           1.10::numeric(5,2) AS exact_decimal,
           '{"a":1}'::jsonb AS payload,
           TIMESTAMPTZ '2024-01-02 03:04:05.123456+00' AS stamped
  `);
  assert.deepEqual(row, {
    exact_id: "9007199254740993",
    exact_decimal: "1.10",
    payload: '{"a": 1}',
    stamped: "2024-01-02 03:04:05.123456+00",
  });
});

test("neon.transaction, savepoint, bulk and stream", { timeout: 60_000 }, async () => {
  const db = createNeonPoolDatabase(pool);
  await db.execute(sql.command`DROP TABLE IF EXISTS neon_items`);
  await db.execute(sql.command`CREATE TABLE neon_items (id int PRIMARY KEY)`);
  await db.tx(async (tx) => {
    await tx.execute(sql.command`INSERT INTO neon_items VALUES (1)`);
    await assert.rejects(
      tx.tx(async (nested) => {
        await nested.execute(sql.command`INSERT INTO neon_items VALUES (2)`);
        throw new Error("rollback the savepoint");
      }),
    );
  });
  assert.deepEqual(await db.all(sql.rows`SELECT id FROM neon_items ORDER BY id`), [{ id: "1" }]);

  const bulk = await db.bulk(
    [{ id: 3 }, { id: 4 }, { id: 5 }],
    ({ id }) => sql.command`INSERT INTO neon_items VALUES (${id})`,
  );
  assert.equal(bulk.inputCount, 3);
  assert.equal(bulk.affectedRows, 3);

  const seen: unknown[] = [];
  for await (const row of db.stream(sql.rows<{ readonly id: string }>`SELECT id FROM neon_items ORDER BY id`))
    seen.push(row.id);
  assert.deepEqual(seen, ["1", "3", "4", "5"]);
});

test("neon.abort ends the physical connection and the pool stays usable", { timeout: 60_000 }, async () => {
  const db = createNeonPoolDatabase(pool);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop")), 300);
  await assert.rejects(
    db.all(sql.rows`SELECT pg_sleep(10)`, { signal: controller.signal }),
    /terminated after statement abort/u,
  );
  assert.deepEqual(await db.all(sql.rows`SELECT 1 AS one`), [{ one: "1" }]);
});
