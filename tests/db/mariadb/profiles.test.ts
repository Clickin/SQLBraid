import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import mariadb from "mariadb";
import { inject, test } from "vitest";
import { generateModels } from "@sqlbraid/codegen";
import type { Database } from "@sqlbraid/core";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";
import { createMariaDbInspector } from "@sqlbraid/mariadb/inspector";
import { MARIADB_LOSSLESS_TEXT, MARIADB_NATIVE, representationProfiles, sql } from "@sqlbraid/mariadb";
import { assertCompilesGeneratedSource, assertGeneratedProperty } from "../codegen.js";
import { stampSupportEnvironment } from "../support-target.js";

const TABLE = "braid_pv18_mariadb_profiles";
const EXACT_INTEGER = "9223372036854775807";
const EXACT_DECIMAL = "12345678901234567890.12345678901234567890";
const DATETIME_TEXT = "2026-09-14 12:34:56.123456";
const DATE_TEXT = "2026-09-14";
const TIME_TEXT = "12:34:56.123456";
const BINARY = [0, 255, 16] as const;

const jsonSamples = [
  { id: 1, canonical: '{"kind":"object","enabled":true}', value: { kind: "object", enabled: true } },
  { id: 2, canonical: '[1,true,"array",null]', value: [1, true, "array", null] },
  { id: 3, canonical: '"string root"', value: "string root" },
  { id: 4, canonical: "123.4500", value: 123.45 },
  { id: 5, canonical: "true", value: true },
  { id: 6, canonical: "null", value: null },
] as const;

type JsonRoot = (typeof jsonSamples)[number]["value"];
type ProfileRow = {
  readonly id: string;
  readonly payload: JsonRoot;
  readonly instant: string | Date;
  readonly date_value: string | Date;
  readonly time_value: string;
  readonly text_value: string;
  readonly binary_value: Buffer;
  readonly big_value: string;
  readonly decimal_value: string;
};

type LosslessRow = Omit<ProfileRow, "payload" | "instant" | "date_value"> & {
  readonly payload: string | null;
  readonly instant: string;
  readonly date_value: string;
};

type NativeRow = Omit<ProfileRow, "payload" | "instant" | "date_value"> & {
  readonly payload: JsonRoot;
  readonly instant: Date;
  readonly date_value: Date;
};

type RawRow = Readonly<Record<string, unknown>>;

function connectorOptions(profile: typeof MARIADB_LOSSLESS_TEXT | typeof MARIADB_NATIVE) {
  const uri = new URL(inject("mariadb").connectionUri);
  return {
    ...profile.connectionOptions,
    host: uri.hostname,
    port: Number(uri.port || 3306),
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.slice(1)),
    connectionLimit: 1,
    idleTimeout: 0,
  };
}

async function connect(profile: typeof MARIADB_LOSSLESS_TEXT | typeof MARIADB_NATIVE) {
  return mariadb.createConnection(connectorOptions(profile));
}

async function close(connection: { end(): Promise<void> } | undefined): Promise<void> {
  await connection?.end().catch(() => undefined);
}

function installedConnectorVersion(): string {
  const packageUrl = new URL("../../node_modules/mariadb/package.json", import.meta.url);
  return (JSON.parse(readFileSync(packageUrl, "utf8")) as { readonly version: string }).version;
}

async function stamp(
  db: Pick<Database, "environment">,
  connection: { query(sql: string): Promise<unknown> },
  testId: string,
): Promise<void> {
  const environment = await db.environment();
  const probeRows = (await connection.query(
    "SELECT VERSION() AS version, @@version_comment AS edition",
  )) as readonly RawRow[];
  const probe = probeRows[0] ?? {};
  const version = typeof probe.version === "string" ? /^\d+\.\d+\.\d+/u.exec(probe.version)?.[0] : undefined;
  const edition = typeof probe.edition === "string" && /mariadb.org/iu.test(probe.edition) ? "community" : undefined;
  assert.ok(version && edition, "MariaDB release/edition probe must identify the tested community distribution.");
  stampSupportEnvironment(
    "mariadb-connector-node-11-8-9",
    {
      ...environment,
      database: { product: environment.database.product, version, edition },
      driver: { ...environment.driver, version: installedConnectorVersion() },
      runtime: { id: "node", version: process.versions.node },
    },
    testId,
  );
}

function modelFor(snapshot: Parameters<typeof generateModels>[0], policy: typeof MARIADB_LOSSLESS_TEXT.typePolicy) {
  const generated = generateModels(snapshot, { typePolicy: policy });
  const relation = generated.models.find((model) => model.relationIdentity.endsWith(`.${TABLE}`));
  assert.ok(relation, `missing generated model for ${TABLE}`);
  return { generated, model: relation };
}

test("mariadb.data.profile-conformance", { timeout: 120_000 }, async () => {
  const losslessConnection = await connect(MARIADB_LOSSLESS_TEXT);
  const nativeConnection = await connect(MARIADB_NATIVE);
  const losslessDb = createMariaDbDatabase(losslessConnection, { profile: MARIADB_LOSSLESS_TEXT });
  const nativeDb = createMariaDbDatabase(nativeConnection, { profile: MARIADB_NATIVE });
  try {
    await losslessConnection.query("SET time_zone = '+00:00'");
    await nativeConnection.query("SET time_zone = '+00:00'");
    await losslessConnection.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await losslessConnection.query(`
      CREATE TABLE ${TABLE} (
        id INT NOT NULL PRIMARY KEY,
        payload JSON,
        instant DATETIME(6) NOT NULL,
        date_value DATE NOT NULL,
        time_value TIME(6) NOT NULL,
        text_value TEXT NOT NULL,
        binary_value BINARY(3) NOT NULL,
        big_value BIGINT NOT NULL,
        decimal_value DECIMAL(40,20) NOT NULL
      )
    `);
    await losslessConnection.query(`
      INSERT INTO ${TABLE}
        (id, payload, instant, date_value, time_value, text_value, binary_value, big_value, decimal_value)
      VALUES
        (1, '{"kind":"object","enabled":true}', '${DATETIME_TEXT}', '${DATE_TEXT}', '${TIME_TEXT}', 'profile text', UNHEX('00FF10'), '${EXACT_INTEGER}', '${EXACT_DECIMAL}'),
        (2, '[1,true,"array",null]', '${DATETIME_TEXT}', '${DATE_TEXT}', '${TIME_TEXT}', 'profile text', UNHEX('00FF10'), '${EXACT_INTEGER}', '${EXACT_DECIMAL}'),
        (3, '"string root"', '${DATETIME_TEXT}', '${DATE_TEXT}', '${TIME_TEXT}', 'profile text', UNHEX('00FF10'), '${EXACT_INTEGER}', '${EXACT_DECIMAL}'),
        (4, '123.4500', '${DATETIME_TEXT}', '${DATE_TEXT}', '${TIME_TEXT}', 'profile text', UNHEX('00FF10'), '${EXACT_INTEGER}', '${EXACT_DECIMAL}'),
        (5, 'true', '${DATETIME_TEXT}', '${DATE_TEXT}', '${TIME_TEXT}', 'profile text', UNHEX('00FF10'), '${EXACT_INTEGER}', '${EXACT_DECIMAL}'),
        (6, 'null', '${DATETIME_TEXT}', '${DATE_TEXT}', '${TIME_TEXT}', 'profile text', UNHEX('00FF10'), '${EXACT_INTEGER}', '${EXACT_DECIMAL}')
    `);

    const rawLossless = (await losslessConnection.query(
      `SELECT id, payload, instant, date_value, time_value, text_value, binary_value, big_value, decimal_value FROM ${TABLE} ORDER BY id`,
    )) as readonly RawRow[];
    assert.equal(rawLossless.length, jsonSamples.length);
    assert.deepEqual(
      rawLossless.map((row) => row.payload),
      jsonSamples.map((sample) => sample.canonical),
    );
    assert.ok(rawLossless.every((row) => typeof row.payload === "string"));
    assert.ok(
      rawLossless.every(
        (row) =>
          typeof row.instant === "string" && typeof row.date_value === "string" && typeof row.time_value === "string",
      ),
    );
    assert.ok(rawLossless.every((row) => Buffer.isBuffer(row.binary_value)));
    assert.ok(rawLossless.every((row) => typeof row.big_value === "bigint" || typeof row.big_value === "string"));
    assert.ok(rawLossless.every((row) => typeof row.decimal_value === "string"));

    const losslessRows = await losslessDb.all(sql.rows<LosslessRow>`
      SELECT id, payload, instant, date_value, time_value, text_value, binary_value, big_value, decimal_value
      FROM ${sql.ident(TABLE)} ORDER BY id
    `);
    assert.deepEqual(
      losslessRows.map((row) => row.payload),
      jsonSamples.map((sample) => sample.canonical),
    );
    assert.ok(
      losslessRows.every(
        (row) => typeof row.instant === "string" && typeof row.date_value === "string" && row.time_value === TIME_TEXT,
      ),
    );
    assert.ok(losslessRows.every((row) => row.text_value === "profile text" && Buffer.isBuffer(row.binary_value)));
    assert.ok(losslessRows.every((row) => row.big_value === EXACT_INTEGER && row.decimal_value === EXACT_DECIMAL));
    assert.deepEqual([...losslessRows[0]!.binary_value], BINARY);

    const rawNative = (await nativeConnection.query(
      `SELECT id, payload, instant, date_value, time_value FROM ${TABLE} ORDER BY id`,
    )) as readonly RawRow[];
    assert.deepEqual(
      rawNative.map((row) => row.payload),
      jsonSamples.map((sample) => sample.value),
    );
    assert.ok(
      rawNative.every(
        (row) => row.instant instanceof Date && row.date_value instanceof Date && typeof row.time_value === "string",
      ),
    );
    const nativeRows = await nativeDb.all(sql.rows<NativeRow>`
      SELECT id, payload, instant, date_value, time_value, text_value, binary_value, big_value, decimal_value
      FROM ${sql.ident(TABLE)} ORDER BY id
    `);
    assert.deepEqual(
      nativeRows.map((row) => row.payload),
      jsonSamples.map((sample) => sample.value),
    );
    assert.ok(
      nativeRows.every(
        (row) => row.instant instanceof Date && row.date_value instanceof Date && row.time_value === TIME_TEXT,
      ),
    );
    assert.equal(nativeRows[0]!.instant.getTime(), new Date(2026, 8, 14, 12, 34, 56, 123).getTime());
    assert.equal(nativeRows[0]!.date_value.getTime(), new Date(2026, 8, 14).getTime());
    assert.ok(nativeRows.every((row) => row.big_value === EXACT_INTEGER && row.decimal_value === EXACT_DECIMAL));

    const inspector = createMariaDbInspector(losslessConnection);
    const snapshot = await inspector.inspect();
    const relation = Object.values(snapshot.relations).find((entry) => entry.name === TABLE);
    assert.ok(relation, `inspector did not find ${TABLE}`);
    assert.deepEqual(
      relation.columns.map((column) => column.name),
      [
        "id",
        "payload",
        "instant",
        "date_value",
        "time_value",
        "text_value",
        "binary_value",
        "big_value",
        "decimal_value",
      ],
    );
    const columns = new Map(relation.columns.map((column) => [column.name, column]));
    const metadataEvidence = (await losslessConnection.query(`
      SELECT DATA_TYPE AS data_type, COLUMN_TYPE AS column_type
      FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${TABLE}' AND COLUMN_NAME = 'payload'
    `)) as readonly RawRow[];
    assert.equal(metadataEvidence.length, 1);
    // MariaDB exposes JSON as LONGTEXT in information_schema; the inspector recovers
    // the JSON extended-format signal from the field metadata instead of guessing.
    assert.equal(String(metadataEvidence[0]!.data_type).toLowerCase(), "longtext");
    assert.match(String(metadataEvidence[0]!.column_type).toLowerCase(), /longtext/u);
    assert.equal(columns.get("payload")?.type, "json");
    assert.equal(columns.get("instant")?.type, "datetime");
    assert.equal(columns.get("date_value")?.type, "date");
    assert.equal(columns.get("time_value")?.type, "time");
    assert.equal(columns.get("binary_value")?.type, "binary");
    assert.equal(columns.get("big_value")?.type, "bigint");
    assert.equal(columns.get("decimal_value")?.type, "decimal");

    const losslessGenerated = modelFor(snapshot, MARIADB_LOSSLESS_TEXT.typePolicy);
    assertGeneratedProperty(
      losslessGenerated.generated.source,
      losslessGenerated.model.rowName,
      "payload",
      "string | null",
      false,
    );
    assertGeneratedProperty(
      losslessGenerated.generated.source,
      losslessGenerated.model.rowName,
      "instant",
      "string",
      false,
    );
    assertGeneratedProperty(
      losslessGenerated.generated.source,
      losslessGenerated.model.rowName,
      "date_value",
      "string",
      false,
    );
    assertGeneratedProperty(
      losslessGenerated.generated.source,
      losslessGenerated.model.rowName,
      "time_value",
      "string",
      false,
    );
    assertGeneratedProperty(
      losslessGenerated.generated.source,
      losslessGenerated.model.rowName,
      "text_value",
      "string",
      false,
    );
    assertGeneratedProperty(
      losslessGenerated.generated.source,
      losslessGenerated.model.rowName,
      "binary_value",
      "Uint8Array",
      false,
    );
    assertGeneratedProperty(
      losslessGenerated.generated.source,
      losslessGenerated.model.rowName,
      "big_value",
      "string",
      false,
    );
    assertGeneratedProperty(
      losslessGenerated.generated.source,
      losslessGenerated.model.rowName,
      "decimal_value",
      "string",
      false,
    );
    await assertCompilesGeneratedSource(losslessGenerated.generated.source, "mariadb-pv18-lossless");

    const nativeGenerated = modelFor(snapshot, MARIADB_NATIVE.typePolicy);
    // The native descriptor and recovered JSON metadata agree on the unknown runtime root type.
    assertGeneratedProperty(
      nativeGenerated.generated.source,
      nativeGenerated.model.rowName,
      "payload",
      "unknown | null",
      false,
    );
    assertGeneratedProperty(nativeGenerated.generated.source, nativeGenerated.model.rowName, "instant", "Date", false);
    assertGeneratedProperty(
      nativeGenerated.generated.source,
      nativeGenerated.model.rowName,
      "date_value",
      "Date",
      false,
    );
    assertGeneratedProperty(
      nativeGenerated.generated.source,
      nativeGenerated.model.rowName,
      "time_value",
      "string",
      false,
    );
    assertGeneratedProperty(
      nativeGenerated.generated.source,
      nativeGenerated.model.rowName,
      "text_value",
      "string",
      false,
    );
    assertGeneratedProperty(
      nativeGenerated.generated.source,
      nativeGenerated.model.rowName,
      "binary_value",
      "Uint8Array",
      false,
    );
    assertGeneratedProperty(
      nativeGenerated.generated.source,
      nativeGenerated.model.rowName,
      "big_value",
      "string",
      false,
    );
    assertGeneratedProperty(
      nativeGenerated.generated.source,
      nativeGenerated.model.rowName,
      "decimal_value",
      "string",
      false,
    );
    await assertCompilesGeneratedSource(nativeGenerated.generated.source, "mariadb-pv18-native");

    for (const selected of representationProfiles.filter((entry) => entry.json !== entry.temporal)) {
      const connection = await connect(selected);
      try {
        const mixed = createMariaDbDatabase(connection, { profile: selected });
        const row = await mixed.one(sql.rows<{ payload: unknown; instant: unknown }>`
          SELECT payload, instant FROM ${sql.ident(TABLE)} WHERE id = ${1}
        `);
        assert.equal(typeof row.payload, selected.json === "text" ? "string" : "object");
        assert.equal(row.instant instanceof Date, selected.temporal === "native");
        if (selected.temporal === "text") assert.equal(typeof row.instant, "string");
        const { generated, model } = modelFor(snapshot, selected.typePolicy);
        assertGeneratedProperty(
          generated.source,
          model.rowName,
          "payload",
          selected.json === "text" ? "string | null" : "unknown | null",
          false,
        );
        assertGeneratedProperty(
          generated.source,
          model.rowName,
          "instant",
          selected.temporal === "text" ? "string" : "Date",
          false,
        );
      } finally {
        await connection.end();
      }
    }
    const losslessEnvironment = await losslessDb.environment();
    assert.equal(losslessEnvironment.driver.profile, MARIADB_LOSSLESS_TEXT.id);
    assert.equal(losslessEnvironment.capabilities["data.json-lossless-text"]?.status, "guarded");
    assert.equal(losslessEnvironment.capabilities["data.temporal-lossless"]?.status, "guarded");
    const nativeEnvironment = await nativeDb.environment();
    assert.equal(nativeEnvironment.driver.profile, MARIADB_NATIVE.id);
    assert.equal(nativeEnvironment.capabilities["data.json-parsed"]?.status, "guarded");
    assert.equal(nativeEnvironment.capabilities["data.temporal-native"]?.status, "guarded");
    await stamp(losslessDb, losslessConnection, "mariadb.data.profile-conformance.lossless");
    await stamp(nativeDb, nativeConnection, "mariadb.data.profile-conformance.native");
  } finally {
    await losslessConnection.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
    await close(nativeConnection);
    await close(losslessConnection);
  }
});
