import assert from "node:assert/strict";
import { neon, neonConfig } from "@neondatabase/serverless";
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, test } from "vitest";
import { sql } from "@sqlbraid/postgres";
import { createNeonHttpDatabase } from "@sqlbraid/postgres/neon-http";
import { supportTarget } from "../support-target.js";

const image = supportTarget(process.env.SQLBRAID_POSTGRES_TARGET ?? "postgres").reproducibility.image;
const HTTP_PROXY_IMAGE = "ghcr.io/timowilhelm/local-neon-http-proxy:main";

let network: StartedNetwork;
let database: StartedPostgreSqlContainer;
let proxy: StartedTestContainer;
let db: ReturnType<typeof createNeonHttpDatabase>;

const codeOf = (error: unknown) => (error as { code?: string }).code;

beforeAll(async () => {
  assert.ok(image, "PostgreSQL support target has no reproducibility image.");
  network = await new Network().start();
  database = await new PostgreSqlContainer(image)
    .withNetwork(network)
    .withNetworkAliases("neon-http-pg")
    .withDatabase("sqlbraid")
    .withUsername("sqlbraid")
    .withPassword("sqlbraid")
    .start();
  proxy = await new GenericContainer(HTTP_PROXY_IMAGE)
    .withNetwork(network)
    .withEnvironment({ PG_CONNECTION_STRING: "postgres://sqlbraid:sqlbraid@neon-http-pg:5432/sqlbraid" })
    .withExposedPorts(4444)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  neonConfig.fetchEndpoint = () => `http://${proxy.getHost()}:${proxy.getMappedPort(4444)}/sql`;
  neonConfig.useSecureWebSocket = false;
  const client = neon("postgres://sqlbraid:sqlbraid@db.localtest.me:5432/sqlbraid");
  db = createNeonHttpDatabase(client);
  // The proxy listens before it can reach PostgreSQL, so retry the first request.
  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- retries must run in sequence
      await client.query("SELECT 1");
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      // oxlint-disable-next-line no-await-in-loop -- retries must run in sequence
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}, 180_000);

afterAll(async () => {
  await proxy?.stop();
  await database?.stop();
  await network?.stop();
}, 60_000);

test("neon-http.environment reports stateless capabilities", { timeout: 30_000 }, async () => {
  const environment = await db.environment();
  assert.equal(environment.driver.id, "neon-http");
  assert.equal(environment.driver.profile, "pg-lossless-text");
  for (const id of ["session.pinned", "transaction", "statement.stream", "statement.cancel", "routine.call"] as const) {
    assert.equal(environment.capabilities[id]?.status, "unsupported", id);
  }
  assert.equal(environment.capabilities["statement.bulk"]?.status, "guaranteed");
});

test("neon-http.lossless text results", { timeout: 30_000 }, async () => {
  const row = await db.one(sql.rows`
    SELECT 9007199254740993::int8 AS exact_id,
           7::int4 AS small,
           1.10::numeric(5,2) AS exact_decimal,
           '{"a":1}'::jsonb AS payload,
           TIMESTAMPTZ '2024-01-02 03:04:05.123456+00' AS stamped,
           ARRAY[1,2]::int4[] AS items,
           1.5::float8 AS ratio,
           2.5::float4 AS ratio32,
           true AS flag,
           decode('0102', 'hex') AS bytes
  `);
  assert.deepEqual(row, {
    exact_id: "9007199254740993",
    small: "7",
    exact_decimal: "1.10",
    payload: '{"a": 1}',
    stamped: "2024-01-02 03:04:05.123456+00",
    items: "{1,2}",
    ratio: 1.5,
    ratio32: 2.5,
    flag: true,
    bytes: new Uint8Array([1, 2]),
  });
});

test("neon-http.parameters and duplicate labels", { timeout: 30_000 }, async () => {
  const row = await db.one(sql.rows`SELECT ${9007199254740993n}::int8 AS big, ${"text"}::text AS label`);
  assert.deepEqual(row, { big: "9007199254740993", label: "text" });
  await assert.rejects(db.all(sql.rows`SELECT 1 AS a, 2 AS a`), /duplicate PostgreSQL result label/u);
});

test("neon-http.command results and atomic bulk", { timeout: 60_000 }, async () => {
  await db.execute(sql.command`DROP TABLE IF EXISTS nh_items`);
  await db.execute(sql.command`CREATE TABLE nh_items (id int PRIMARY KEY)`);
  const insert = await db.execute(sql.command`INSERT INTO nh_items VALUES (1), (2)`);
  assert.equal(insert.kind, "command");
  assert.equal(insert.command.affectedRows, 2);
  const bulk = await db.bulk([{ id: 3 }, { id: 4 }], ({ id }) => sql.command`INSERT INTO nh_items VALUES (${id})`);
  assert.equal(bulk.inputCount, 2);
  assert.equal(bulk.affectedRows, 2);
  // The batch is one server-side transaction: a duplicate key rolls back the new row too.
  await assert.rejects(db.bulk([{ id: 5 }, { id: 1 }], ({ id }) => sql.command`INSERT INTO nh_items VALUES (${id})`));
  assert.deepEqual(
    (await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM nh_items ORDER BY id`)).map((row) => row.id),
    ["1", "2", "3", "4"],
  );
});

test("neon-http.rejects transactions, sessions, streams, calls and signals", { timeout: 30_000 }, async () => {
  await assert.rejects(db.tx(async (tx) => tx.all(sql.rows`SELECT 1`)));
  await assert.rejects(db.session(async (session) => session.all(sql.rows`SELECT 1`)));
  await assert.rejects(
    db.all(sql.rows`SELECT 1`, { signal: new AbortController().signal }),
    (error: unknown) => codeOf(error) === "BRAID_CANCEL_UNSUPPORTED",
  );
  await assert.rejects(
    (async () => {
      for await (const row of db.stream(sql.rows`SELECT 1`)) assert.ok(row);
    })(),
    (error: unknown) => codeOf(error) === "BRAID_STREAM_UNSUPPORTED",
  );
});

test("neon-http.rejects an object that is not a neon() function", () => {
  assert.throws(() => createNeonHttpDatabase({} as never), /neon\(\) query function/u);
});
