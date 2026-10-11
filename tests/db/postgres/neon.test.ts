import assert from "node:assert/strict";
import ws from "ws";
import { Client, Pool, neonConfig } from "@neondatabase/serverless";
import { Client as PgClient } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, inject, test } from "vitest";
import { sql } from "@sqlbraid/postgres";
import { createNeonDatabase, createNeonPoolDatabase } from "@sqlbraid/postgres/neon";
import { transactionIntegrationTests } from "../../contracts/transaction.integration.js";
import { affectedRowsContract, affectedRowsTitle } from "../command-metadata.js";

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

function neonConnectionString(): string {
  const database = new URL((inject("postgres") as { readonly connectionUri: string }).connectionUri);
  return `postgres://${database.username}:${database.password}@host.docker.internal/${database.pathname.slice(1)}`;
}

async function endPool(target: Pick<Pool, "end">): Promise<void> {
  const ending = target.end().catch(() => undefined);
  const timeout = Promise.withResolvers<void>();
  const timer = setTimeout(timeout.resolve, 500);
  await Promise.race([ending, timeout.promise]);
  clearTimeout(timer);
}

for (const mode of ["direct", "pooled"] as const) {
  for (const contract of transactionIntegrationTests(
    "neon-serverless",
    mode,
    async () => {
      const connectionString = neonConnectionString();
      const observer = new PgClient({
        connectionString: (inject("postgres") as { connectionUri: string }).connectionUri,
      });
      const client = mode === "direct" ? new Client({ connectionString }) : undefined;
      const contractPool = mode === "pooled" ? new Pool({ connectionString, max: 1 }) : undefined;
      try {
        await observer.connect();
        await client?.connect();
        const db = client
          ? createNeonDatabase(client, { streamBatchSize: 1 })
          : createNeonPoolDatabase(contractPool!, { streamBatchSize: 1 });
        await observer.query("DROP TABLE IF EXISTS braid_contract_tx");
        await observer.query("CREATE TABLE braid_contract_tx (id VARCHAR(255) PRIMARY KEY)");
        return {
          db,
          caughtStatementOutcome: "rollback",
          streamQuery: sql.rows<{ id: string }>`SELECT id FROM braid_contract_tx ORDER BY id`,
          physicalId: async (scope) => (await scope.one(sql.rows<{ id: string }>`SELECT pg_backend_pid() AS id`)).id,
          write: (tx, id) => tx.execute(sql.command`INSERT INTO braid_contract_tx (id) VALUES (${id})`),
          committedRows: async () =>
            (await observer.query<{ id: string }>("SELECT id FROM braid_contract_tx ORDER BY id")).rows.map(
              (row) => row.id,
            ),
          accessMode: {
            inheritedReadOnly: true,
            setDefault: async () => {
              await db.execute(sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
            },
            restoreDefault: async () => {
              await db.execute(sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`);
            },
          },
          close: async () => {
            try {
              await observer.query("DROP TABLE braid_contract_tx");
            } finally {
              await Promise.all([client?.end(), contractPool && endPool(contractPool), observer.end()]);
            }
          },
        };
      } catch (error) {
        await Promise.allSettled([client?.end(), contractPool && endPool(contractPool), observer.end()]);
        throw error;
      }
    },
    { accessMode: true, pooledLease: mode === "pooled", stream: true },
  ))
    test(contract.title, { timeout: 60_000 }, contract.run);
}

test(`${affectedRowsTitle("neon-serverless")} command affected rows are exact`, { timeout: 60_000 }, async () => {
  const observer = new PgClient({ connectionString: (inject("postgres") as { connectionUri: string }).connectionUri });
  await observer.connect();
  try {
    await observer.query("DROP TABLE IF EXISTS braid_contract_affected");
    await observer.query("CREATE TABLE braid_contract_affected (id VARCHAR(255) PRIMARY KEY, name TEXT NOT NULL)");
    await affectedRowsContract(createNeonPoolDatabase(pool), sql, async () =>
      (await observer.query<{ id: string }>("SELECT id FROM braid_contract_affected ORDER BY id")).rows.map(
        (row) => row.id,
      ),
    );
  } finally {
    await observer.query("DROP TABLE IF EXISTS braid_contract_affected");
    await observer.end();
  }
});
