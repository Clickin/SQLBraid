import assert from "node:assert/strict";
import { test } from "vitest";
import { ResultExactnessError } from "@sqlbraid/core";
import { createPgDatabase } from "@sqlbraid/postgres/pg";
import { representationProfiles, typePolicyForProfile } from "@sqlbraid/postgres";
import { sql } from "@sqlbraid/postgres";

function fakeClient(captured: {
  config?: { readonly types?: { getTypeParser(oid: number, format?: string): (value: string) => unknown } };
}) {
  return {
    escapeIdentifier(value: string) {
      return `"${value}"`;
    },
    escapeLiteral(value: string) {
      return `'${value}'`;
    },
    getTypeParser(oid: number) {
      if (oid === 114 || oid === 3802) return (value: string) => JSON.parse(value);
      if (oid === 1082 || oid === 1114 || oid === 1184) return (value: string) => new Date(value);
      return (value: string) => value;
    },
    async query(
      configOrText:
        | string
        | {
            readonly text: string;
            readonly values: readonly unknown[];
            readonly types?: { getTypeParser(oid: number, format?: string): (value: string) => unknown };
          },
      values: readonly unknown[] = [],
    ) {
      const config = typeof configOrText === "string" ? { text: configOrText, values } : configOrText;
      captured.config = config;
      if (config.text.includes("current_setting")) {
        return {
          rows: [{ server_version: "16.4", extra_float_digits: "3", timezone: "UTC" }],
          rowCount: 1,
          fields: [
            { name: "server_version", dataTypeID: 25 },
            { name: "extra_float_digits", dataTypeID: 25 },
            { name: "timezone", dataTypeID: 25 },
          ],
          command: "SELECT",
        };
      }
      return {
        rows: [],
        rowCount: 0,
        fields: [],
        command: "SELECT",
      };
    },
  };
}

test("postgres representation profiles are immutable and policy/codegen reusable", () => {
  assert.deepEqual(
    representationProfiles.map(({ id, json, temporal }) => ({ id, json, temporal })),
    [
      { id: "pg-lossless-text", json: "text", temporal: "text" },
      { id: "pg-native", json: "native", temporal: "native" },
      { id: "pg-json-native-temporal-text", json: "native", temporal: "text" },
      { id: "pg-json-text-temporal-native", json: "text", temporal: "native" },
    ],
  );
  assert.equal(typePolicyForProfile({ json: "text", temporal: "text" }), representationProfiles[0]!.typePolicy);
  assert.equal(typePolicyForProfile({ json: "native", temporal: "native" }), representationProfiles[1]!.typePolicy);
  assert.equal(Object.isFrozen(representationProfiles), true);
  for (const { typePolicy } of representationProfiles) {
    assert.equal(Object.isFrozen(typePolicy), true);
    assert.equal(Object.isFrozen(typePolicy.mappings), true);
    for (const mapping of typePolicy.mappings) {
      assert.equal(Object.isFrozen(mapping), true);
      if (mapping.numeric) assert.equal(Object.isFrozen(mapping.numeric), true);
    }
  }
  assert.equal(
    typePolicyForProfile({ json: "native", temporal: "text" }).mappings.find((m) => m.databaseType === "jsonb")
      ?.outputType,
    "unknown",
  );
  assert.equal(
    typePolicyForProfile({ json: "native", temporal: "text" }).mappings.find((m) => m.databaseType === "timestamp")
      ?.outputType,
    "string",
  );
  assert.throws(() => representationProfiles[0]!.typePolicy.decode("jsonb", { nested: true }), ResultExactnessError);
  assert.throws(
    () => representationProfiles[0]!.typePolicy.decode("_int8", ["9007199254740993"]),
    ResultExactnessError,
  );
  assert.throws(() => representationProfiles[0]!.typePolicy.decode("timestamp", new Date()), ResultExactnessError);
  assert.throws(() => representationProfiles[1]!.typePolicy.decode("timestamp", "2026-09-14"), ResultExactnessError);
});

test("postgres type-name normalization preserves exactness for canonical and qualified names", () => {
  const policy = typePolicyForProfile();
  for (const name of ["int8", "INT8", " pg_catalog.int8 ", " PG_CATALOG.BIGINT "]) {
    assert.equal(policy.decode(name, 9007199254740993n), "9007199254740993");
    assert.equal(policy.encode(name, 9007199254740993n), "9007199254740993");
    assert.equal(policy.decode(name, null), null);
    assert.equal(policy.decode(name, undefined), undefined);
  }
  for (const name of ["numeric", " PG_CATALOG.DECIMAL "]) {
    assert.equal(policy.decode(name, "1.000000000000000001"), "1.000000000000000001");
    assert.throws(() => policy.decode(name, 1.1), ResultExactnessError);
  }
  for (const name of ["jsonb", " PG_CATALOG.JSONB ", "_int8", " PG_CATALOG.INT8[] "]) {
    assert.throws(() => policy.decode(name, []), ResultExactnessError);
  }
  const timestamp = new Date("2026-01-02T03:04:05.123Z");
  assert.throws(() => policy.decode(" PG_CATALOG.TIMESTAMPTZ ", timestamp), ResultExactnessError);
  assert.equal(typePolicyForProfile({ temporal: "native" }).decode(" PG_CATALOG.TIMESTAMPTZ ", timestamp), timestamp);
  const opaque = { value: 1 };
  assert.equal(policy.decode("custom_schema.unknown_type", opaque), opaque);
});

test("postgres parser profiles select matching query-local contracts", async () => {
  const losslessCapture: {
    config?: { readonly types?: { getTypeParser(oid: number, format?: string): (value: string) => unknown } };
  } = {};
  const losslessClient = fakeClient(losslessCapture);
  const lossless = createPgDatabase(losslessClient, { parserProfile: { json: "text", temporal: "text" } });
  const losslessEnvironment = await lossless.environment();
  assert.equal(losslessEnvironment.driver.profile, "pg-lossless-text");
  assert.equal(losslessEnvironment.typePolicy?.id, "postgres-lossless-text");
  await lossless.all(sql.rows`SELECT 1`);
  assert.equal(losslessCapture.config?.types?.getTypeParser(1016)("{9007199254740993}"), "{9007199254740993}");
  assert.equal(losslessCapture.config?.types?.getTypeParser(3802)('{"n":1}'), '{"n":1}');
  assert.equal(losslessCapture.config?.types?.getTypeParser(1184)("2026-09-14"), "2026-09-14");

  const nativeCapture: {
    config?: { readonly types?: { getTypeParser(oid: number, format?: string): (value: string) => unknown } };
  } = {};
  const nativeClient = fakeClient(nativeCapture);
  const native = createPgDatabase(nativeClient, { parserProfile: { json: "native", temporal: "native" } });
  const nativeEnvironment = await native.environment();
  assert.equal(nativeEnvironment.driver.profile, "pg-native");
  assert.equal(nativeEnvironment.typePolicy?.id, "postgres-native");
  await native.all(sql.rows`SELECT 1`);
  assert.deepEqual(nativeCapture.config?.types?.getTypeParser(3802)('{"n":1}'), { n: 1 });
  assert.ok(nativeCapture.config?.types?.getTypeParser(1184)("2026-09-14") instanceof Date);
  assert.equal(nativeCapture.config?.types?.getTypeParser(1016)("{9007199254740993}"), "{9007199254740993}");
  assert.throws(
    () => createPgDatabase(nativeClient, { profile: representationProfiles[0]!, parserProfile: { json: "native" } }),
    (error: unknown) => error instanceof ResultExactnessError,
  );
});

const rejects = (run: () => unknown) => assert.throws(run, (error: unknown) => error instanceof ResultExactnessError);

test("PostgreSQL decoder applies each type's exactness rule in every profile", () => {
  const text = typePolicyForProfile({ json: "text", temporal: "text" });
  const native = typePolicyForProfile({ json: "native", temporal: "native" });
  const date = new Date(0);

  assert.equal(text.decode("int8", 5), "5");
  assert.equal(text.decode(" PG_CATALOG.Int4 ", 7n), "7");
  rejects(() => text.decode("int4", 1.5));
  assert.equal(text.decode("numeric", "1.10"), "1.10");
  rejects(() => text.decode("decimal", 1.1));
  rejects(() => native.decode("money", "$1.00"));

  assert.equal(text.decode("jsonb", "{}"), "{}");
  rejects(() => text.decode("json", {}));
  assert.deepEqual(native.decode("jsonb", {}), {});

  assert.equal(text.decode("_int4", "{1}"), "{1}");
  assert.equal(text.decode("int4[]", "{1}"), "{1}");
  rejects(() => text.decode("_int4", [1]));
  assert.deepEqual(native.decode("_int4", [1]), [1]);

  assert.equal(text.decode("timestamptz", "2026-01-01"), "2026-01-01");
  rejects(() => text.decode("timestamptz", date));
  rejects(() => text.decode("interval", {}));
  assert.equal(native.decode("interval", {}) !== undefined, true);
  assert.equal(native.decode("date", date), date);
  rejects(() => native.decode("date", "2026-01-01"));

  assert.equal(text.decode("text", 1), 1);
  assert.equal(text.decode("constructor", 1), 1);
  assert.equal(text.decode("int4", null), null);
});
