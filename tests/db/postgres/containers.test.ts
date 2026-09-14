import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { inject, test } from "vitest";
import { generateModels } from "@sqlbraid/codegen";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { createPostgresInspector } from "@sqlbraid/postgres/inspector";
import { representationProfiles, sql } from "@sqlbraid/postgres";
import { stampSupportEnvironment } from "../support-target.js";
import { assertCompilesGeneratedSource, assertGeneratedProperty } from "../codegen.js";

type Settings = { readonly connectionUri: string };

function profile(id: string) {
  const selected = representationProfiles.find((entry) => entry.id === id);
  assert.ok(selected, `missing PostgreSQL representation profile ${id}`);
  return selected;
}

test("postgres.pv18.environment.refresh-extra-float-digits", { timeout: 30_000 }, async () => {
  const client = new Client({ connectionString: (inject("postgres") as Settings).connectionUri });
  await client.connect();
  try {
    const db = createPgDatabase(client, { profile: profile("pg-lossless-text") });
    const original = Number((await client.query("SHOW extra_float_digits")).rows[0]?.extra_float_digits ?? 3);
    await client.query("SET extra_float_digits = 3");
    const initial = await db.environment({ refresh: true });
    await client.query("SET extra_float_digits = 0");
    const cached = await db.environment();
    const refreshed = await db.environment({ refresh: true });
    assert.equal(cached.capabilities["numeric.approximate-float"]?.status, initial.capabilities["numeric.approximate-float"]?.status);
    assert.equal(refreshed.capabilities["numeric.approximate-float"]?.status, "guarded");
    await client.query(`SET extra_float_digits = ${Number.isInteger(original) ? original : 3}`);
  } finally {
    await client.end();
  }
});

test("postgres.pv18.profiles.runtime-codegen", { timeout: 30_000 }, async () => {
  const client = new Client({ connectionString: (inject("postgres") as Settings).connectionUri });
  await client.connect();
  try {
    const lossless = createPgDatabase(client, { profile: profile("pg-lossless-text") });
    const textRow = await lossless.one(sql.rows<{
      readonly exact_id: string;
      readonly exact_decimal: string;
      readonly payload: string;
      readonly stamped: string;
      readonly json_number: string;
    }>`
      SELECT 9007199254740993::int8 AS exact_id,
             12345678901234567890.123456789::numeric AS exact_decimal,
             '{"n":9007199254740993}'::jsonb AS payload,
             TIMESTAMP '2026-09-14 12:34:56.123456' AS stamped,
             '9007199254740993'::jsonb AS json_number
    `);
    assert.deepEqual(textRow, {
      exact_id: "9007199254740993",
      exact_decimal: "12345678901234567890.123456789",
      payload: '{"n": 9007199254740993}',
      stamped: "2026-09-14 12:34:56.123456",
      json_number: "9007199254740993",
    });
    const textEnvironment = await lossless.environment();
    assert.equal(textEnvironment.driver.profile, "pg-lossless-text");
    assert.equal(textEnvironment.typePolicy?.id, "postgres-lossless-text");

    const native = createPgDatabase(client, { profile: profile("pg-native") });
    const nativeRow = await native.one(sql.rows<{
      readonly payload: unknown;
      readonly stamped: unknown;
      readonly date_value: unknown;
      readonly time_value: unknown;
      readonly json_number: unknown;
      readonly json_string: unknown;
      readonly json_boolean: unknown;
      readonly json_null: unknown;
      readonly json_array: unknown;
    }>`
      SELECT '{"n":9007199254740993}'::jsonb AS payload,
             TIMESTAMP '2026-09-14 12:34:56.123456' AS stamped,
             DATE '2026-09-14' AS date_value,
             TIME '12:34:56.123456' AS time_value,
             '9007199254740993'::jsonb AS json_number,
             '"text-root"'::jsonb AS json_string,
             'true'::jsonb AS json_boolean,
             'null'::jsonb AS json_null,
             '[1, 2, 3]'::jsonb AS json_array
    `);
    assert.deepEqual(nativeRow.payload, { n: 9007199254740993 });
    assert.ok(nativeRow.stamped instanceof Date);
    assert.ok(nativeRow.date_value instanceof Date);
    assert.equal(nativeRow.time_value, "12:34:56.123456");
    assert.equal(typeof nativeRow.json_number, "number");
    assert.equal(nativeRow.json_string, "text-root");
    assert.equal(nativeRow.json_boolean, true);
    assert.equal(nativeRow.json_null, null);
    assert.deepEqual(nativeRow.json_array, [1, 2, 3]);
    const nativeEnvironment = await native.environment();
    assert.equal(nativeEnvironment.driver.profile, "pg-native");
    assert.equal(nativeEnvironment.typePolicy?.id, "postgres-native");

    const pool = new Pool({ connectionString: (inject("postgres") as Settings).connectionUri, max: 1 });
    try {
      const pooled = createPgPoolDatabase(pool, { profile: profile("pg-native") });
      const pooledEnvironment = await pooled.environment();
      assert.equal(pooledEnvironment.driver.profile, "pg-native");
      assert.equal(pooledEnvironment.typePolicy?.id, "postgres-native");
    } finally {
      await pool.end();
    }

    await client.query("DROP TABLE IF EXISTS braid_pv18_profiles");
    await client.query(`
      CREATE TABLE braid_pv18_profiles (
        id bigint NOT NULL,
        amount numeric(40, 20) NOT NULL,
        payload jsonb NOT NULL,
        stamped timestamp(6) NOT NULL,
        int8_values bigint[] NOT NULL,
        numeric_values numeric[] NOT NULL,
        json_values jsonb[] NOT NULL,
        timestamp_values timestamp[] NOT NULL
      )
    `);
    const snapshot = await createPostgresInspector(client).inspect();
    const relation = snapshot.relations["public.braid_pv18_profiles"];
    assert.ok(relation);
    assert.equal(snapshot.types["pg_catalog._int8"]?.kind, "array");
    assert.equal(snapshot.types["pg_catalog._int8"]?.elementType, "pg_catalog.int8");
    const textGenerated = generateModels(snapshot, { typePolicy: profile("pg-lossless-text").typePolicy });
    assertGeneratedProperty(textGenerated.source, "BraidPv18ProfilesRow", "payload", "string", false);
    assertGeneratedProperty(textGenerated.source, "BraidPv18ProfilesRow", "stamped", "string", false);
    assertGeneratedProperty(textGenerated.source, "BraidPv18ProfilesRow", "int8_values", "string", false);
    assertGeneratedProperty(textGenerated.source, "BraidPv18ProfilesRow", "numeric_values", "string", false);
    assertGeneratedProperty(textGenerated.source, "BraidPv18ProfilesRow", "json_values", "string", false);
    assertGeneratedProperty(textGenerated.source, "BraidPv18ProfilesRow", "timestamp_values", "string", false);
    await assertCompilesGeneratedSource(textGenerated.source, "postgres-pv18-lossless");

    const nativeGenerated = generateModels(snapshot, { typePolicy: profile("pg-native").typePolicy });
    assertGeneratedProperty(nativeGenerated.source, "BraidPv18ProfilesRow", "payload", "unknown", false);
    assertGeneratedProperty(nativeGenerated.source, "BraidPv18ProfilesRow", "stamped", "Date", false);
    assertGeneratedProperty(nativeGenerated.source, "BraidPv18ProfilesRow", "int8_values", "unknown", false);
    await assertCompilesGeneratedSource(nativeGenerated.source, "postgres-pv18-native");
    for (const selected of representationProfiles.filter((entry) => entry.json !== entry.temporal)) {
      const mixed = createPgDatabase(client, { profile: selected });
      const row = await mixed.one(sql.rows<{ payload: unknown; stamped: unknown }>`
        SELECT '{"n":1}'::jsonb AS payload, TIMESTAMP '2026-09-14 12:34:56.123456' AS stamped
      `);
      assert.equal(typeof row.payload, selected.json === "text" ? "string" : "object");
      assert.equal(row.stamped instanceof Date, selected.temporal === "native");
      if (selected.temporal === "text") assert.equal(typeof row.stamped, "string");
      const generated = generateModels(snapshot, { typePolicy: selected.typePolicy });
      assertGeneratedProperty(generated.source, "BraidPv18ProfilesRow", "payload", selected.json === "text" ? "string" : "unknown", false);
      assertGeneratedProperty(generated.source, "BraidPv18ProfilesRow", "stamped", selected.temporal === "text" ? "string" : "Date", false);
    }
    const server = (await client.query<{ version: string; banner: string }>("SELECT current_setting('server_version') AS version, version() AS banner")).rows[0]!;
    const pgVersion = JSON.parse(readFileSync(new URL("../../../node_modules/pg/package.json", import.meta.url), "utf8")).version as string;
    const edition = /alpine/iu.test(server.banner) ? "alpine" : server.banner;
    stampSupportEnvironment(process.env.SQLBRAID_POSTGRES_TARGET ?? "postgres", {
      ...textEnvironment,
      database: { product: "postgres", version: server.version.split(" ")[0]!, edition },
      driver: { ...textEnvironment.driver, version: pgVersion },
      runtime: { id: "node", version: process.versions.node },
    }, "postgres.data.profile-runtime-codegen");
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv18_profiles").catch(() => undefined);
    await client.end();
  }
});

test("postgres.pv18.containers.lossless-text", { timeout: 30_000 }, async () => {
  const client = new Client({ connectionString: (inject("postgres") as Settings).connectionUri });
  await client.connect();
  try {
    const db = createPgDatabase(client, { profile: profile("pg-lossless-text") });
    const row = await db.one(sql.rows<Record<string, unknown>>`
      SELECT ARRAY[9007199254740993::int8] AS int8_values,
             ARRAY[32767::int2] AS int2_values,
             ARRAY[2147483647::int4] AS int4_values,
             ARRAY[12345678901234567890.123456789::numeric] AS numeric_values,
             ARRAY[1.25::real] AS real_values,
             ARRAY[1.25::double precision] AS float8_values,
             ARRAY['{"n":9007199254740993}'::json] AS json_values,
             ARRAY['{"n":9007199254740993}'::jsonb] AS jsonb_values,
             ARRAY[TIME '12:34:56.123456'] AS time_values,
             ARRAY[TIMETZ '12:34:56.123456+00'] AS timetz_values,
             ARRAY[INTERVAL '1 day 02:03:04.123456'] AS interval_values,
             ARRAY[TIMESTAMP '2026-09-14 12:34:56.123456'] AS timestamp_values,
             ARRAY[TIMESTAMPTZ '2026-09-14 12:34:56.123456+00'] AS timestamptz_values,
             ARRAY[DATE '2026-09-14'] AS date_values,
             ARRAY['550e8400-e29b-41d4-a716-446655440000'::uuid] AS uuid_values,
             ARRAY[decode('00ff10', 'hex')::bytea] AS bytea_values
    `);
    for (const key of ["int8_values", "int2_values", "int4_values", "numeric_values", "real_values", "float8_values", "json_values", "jsonb_values", "time_values", "timetz_values", "interval_values", "timestamp_values", "timestamptz_values", "date_values", "uuid_values", "bytea_values"] as const) {
      assert.equal(typeof row[key], "string", `${key} must remain one raw text carrier`);
    }
    assert.match(String(row.int8_values), /9007199254740993/u);
    assert.match(String(row.numeric_values), /12345678901234567890\.123456789/u);
    assert.match(String(row.jsonb_values), /9007199254740993/u);
    assert.match(String(row.timestamp_values), /2026-09-14 12:34:56\.123456/u);
  } finally {
    await client.end();
  }
});

test("postgres.pv18.containers.native-classification", { timeout: 30_000 }, async () => {
  const client = new Client({ connectionString: (inject("postgres") as Settings).connectionUri });
  await client.connect();
  try {
    await client.query("DROP DOMAIN IF EXISTS braid_pv18_json_domain CASCADE");
    await client.query("DROP DOMAIN IF EXISTS braid_pv18_numeric_domain CASCADE");
    await client.query("DROP TYPE IF EXISTS braid_pv18_composite CASCADE");
    await client.query("CREATE DOMAIN braid_pv18_json_domain AS jsonb");
    await client.query("CREATE DOMAIN braid_pv18_numeric_domain AS numeric");
    await client.query("CREATE TYPE braid_pv18_composite AS (id bigint, payload jsonb)");
    await client.query(`
      CREATE TABLE braid_pv18_containers (
        domain_json braid_pv18_json_domain,
        domain_numeric braid_pv18_numeric_domain,
        range_value int8range,
        multirange_value int8multirange,
        composite_value braid_pv18_composite
      )
    `);
    const db = createPgDatabase(client, { profile: profile("pg-native") });
    const row = await db.one(sql.rows<Record<string, unknown>>`
      SELECT ARRAY[9007199254740993::int8] AS int8_values,
             ARRAY['{"n":9007199254740993}'::jsonb] AS jsonb_values,
             TIMESTAMP '2026-09-14 12:34:56.123456' AS stamped,
             '9007199254740993'::braid_pv18_numeric_domain AS domain_value,
             int8range(1, 3) AS range_value,
             '{[1,3)}'::int8multirange AS multirange_value,
             ROW(9007199254740993::bigint, '{"n":1}'::jsonb)::braid_pv18_composite AS composite_value
    `);
    assert.ok(Array.isArray(row.int8_values));
    assert.ok(Array.isArray(row.jsonb_values));
    assert.deepEqual(row.jsonb_values, [{ n: 9007199254740993 }]);
    assert.ok(row.stamped instanceof Date);
    assert.equal(typeof row.domain_value, "string");
    assert.equal(typeof row.range_value, "string");
    assert.equal(typeof row.multirange_value, "string");
    assert.equal(typeof row.composite_value, "string");

    const snapshot = await createPostgresInspector(client).inspect();
    assert.equal(snapshot.types["public.braid_pv18_json_domain"]?.kind, "domain");
    assert.equal(snapshot.types["public.braid_pv18_numeric_domain"]?.kind, "domain");
    assert.equal(snapshot.types["public.braid_pv18_composite"]?.kind, "composite");
    assert.equal(snapshot.types["pg_catalog.int8range"]?.kind, "range");
    assert.equal(snapshot.types["pg_catalog.int8multirange"]?.kind, "multirange");
    const generated = generateModels(snapshot, { typePolicy: profile("pg-native").typePolicy });
    assertGeneratedProperty(generated.source, "BraidPv18ContainersRow", "domain_json", "unknown | null", false);
    assertGeneratedProperty(generated.source, "BraidPv18ContainersRow", "range_value", "unknown | null", false);
    assertGeneratedProperty(generated.source, "BraidPv18ContainersRow", "multirange_value", "unknown | null", false);
    assertGeneratedProperty(generated.source, "BraidPv18ContainersRow", "composite_value", "unknown | null", false);
    await assertCompilesGeneratedSource(generated.source, "postgres-pv18-containers");
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv18_containers CASCADE").catch(() => undefined);
    await client.query("DROP DOMAIN IF EXISTS braid_pv18_json_domain CASCADE").catch(() => undefined);
    await client.query("DROP DOMAIN IF EXISTS braid_pv18_numeric_domain CASCADE").catch(() => undefined);
    await client.query("DROP TYPE IF EXISTS braid_pv18_composite CASCADE").catch(() => undefined);
    await client.end();
  }
});
