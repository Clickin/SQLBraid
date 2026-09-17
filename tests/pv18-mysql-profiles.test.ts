import assert from "node:assert/strict";
import { test } from "vitest";
import { generateModels } from "@sqlbraid/codegen";
import { ResultExactnessError, type TypePolicy } from "@sqlbraid/core";
import {
  MYSQL2_LOSSLESS_TEXT,
  MYSQL2_NATIVE,
  representationProfiles as mysqlProfiles,
  sql as mysqlSql,
} from "@sqlbraid/mysql";
import { createMysql2Executor } from "@sqlbraid/mysql/mysql2";
import {
  MARIADB_LOSSLESS_TEXT,
  MARIADB_NATIVE,
  representationProfiles as mariaProfiles,
  sql as mariaSql,
} from "@sqlbraid/mariadb";
import { createMariaDbExecutor } from "@sqlbraid/mariadb/mariadb";
import type { MetadataSnapshot } from "@sqlbraid/metadata";
import { assertGeneratedProperty } from "./db/codegen.js";

function snapshot(dialect: string): MetadataSnapshot {
  return {
    format: "sqlbraid-metadata",
    formatVersion: 1,
    dialect,
    dialectVersion: "pv18",
    server: {},
    namespaces: {},
    types: {},
    relations: {
      "test.profile_values": {
        identity: "test.profile_values",
        name: "profile_values",
        namespace: "test",
        kind: "table",
        columns: [
          { name: "payload", ordinal: 0, type: "JSON", nullable: false },
          { name: "instant", ordinal: 1, type: "DATETIME", nullable: false },
          { name: "amount", ordinal: 2, type: "DECIMAL", nullable: false },
        ],
      },
    },
    routines: {},
    metadata: {},
  };
}

function mysqlConnection(
  config: Record<string, unknown>,
  payload: unknown,
  fields: readonly { readonly name?: string; readonly type?: string | number }[],
) {
  return {
    config,
    async execute() {
      return [payload, fields] as const;
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  };
}

function mysqlConnectionWithoutConfig(
  payload: unknown,
  fields: readonly { readonly name?: string; readonly type?: string | number }[],
) {
  return {
    async execute() {
      return [payload, fields] as const;
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  };
}

function mariaConnection(payload: unknown, fields: readonly Record<string, unknown>[]) {
  return {
    async execute() {
      if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        Object.hasOwn(payload, "affectedRows")
      )
        return payload;
      const rows = Array.isArray(payload) ? payload : [payload];
      Object.defineProperty(rows, "meta", { value: fields, enumerable: false });
      return rows;
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  };
}

function typePolicyContract(policy: TypePolicy): void {
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.mappings), true);
  for (const mapping of policy.mappings) {
    assert.equal(Object.isFrozen(mapping), true);
    if (mapping.numeric !== undefined) assert.equal(Object.isFrozen(mapping.numeric), true);
  }
}

test("unprofiled MariaDB connections cannot advertise a certified representation profile", () => {
  const connection = mariaConnection([], []);
  assert.equal(createMariaDbExecutor(connection).environment?.driver.profile, "mariadb-custom-profile");
  assert.equal(
    createMariaDbExecutor(connection, { profile: { dateStrings: true } }).environment?.driver.profile,
    "mariadb-custom-profile",
  );
  assert.equal(
    createMariaDbExecutor(connection, { profile: MARIADB_LOSSLESS_TEXT }).environment?.driver.profile,
    "mariadb-lossless-text",
  );
});

test("PV18 first-party MySQL and MariaDB profiles are immutable and policy-coherent", () => {
  assert.deepEqual(
    mysqlProfiles.map(({ id }) => id),
    ["mysql2-lossless-text", "mysql2-native", "mysql2-json-text", "mysql2-date-text"],
  );
  assert.deepEqual(
    mariaProfiles.map(({ id }) => id),
    ["mariadb-lossless-text", "mariadb-native", "mariadb-json-text", "mariadb-date-text"],
  );
  typePolicyContract(MYSQL2_LOSSLESS_TEXT.typePolicy);
  typePolicyContract(MYSQL2_NATIVE.typePolicy);
  typePolicyContract(MARIADB_LOSSLESS_TEXT.typePolicy);
  typePolicyContract(MARIADB_NATIVE.typePolicy);
  assert.equal(
    MYSQL2_LOSSLESS_TEXT.typePolicy.mappings.find((mapping) => mapping.databaseType === "JSON")?.outputType,
    "string",
  );
  assert.equal(
    MYSQL2_NATIVE.typePolicy.mappings.find((mapping) => mapping.databaseType === "JSON")?.outputType,
    "unknown",
  );
  assert.equal(
    MYSQL2_LOSSLESS_TEXT.typePolicy.mappings.find((mapping) => mapping.databaseType === "DATETIME")?.outputType,
    "string",
  );
  assert.equal(
    MYSQL2_NATIVE.typePolicy.mappings.find((mapping) => mapping.databaseType === "DATETIME")?.outputType,
    "Date",
  );
  assert.equal(MARIADB_LOSSLESS_TEXT.connectionOptions?.autoJsonMap, false);
  assert.equal(MARIADB_NATIVE.connectionOptions?.autoJsonMap, true);
});

test("PV18 MySQL auto-recognition selects matching native policy and codegen", async () => {
  const connection = mysqlConnection(
    {
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      rowsAsArray: false,
      jsonStrings: false,
      dateStrings: false,
      typeCast: true,
    },
    [{ payload: { nested: [1, true] }, instant: new Date("2026-09-14T12:34:56.000Z"), amount: "123.4500" }],
    [
      { name: "payload", type: "JSON" },
      { name: "instant", type: "DATETIME" },
      { name: "amount", type: "DECIMAL" },
    ],
  );
  const executor = createMysql2Executor(connection);
  const result = await executor.query(mysqlSql.rows`SELECT payload, instant, amount`.render());
  assert.deepEqual(result.rows, [
    { payload: { nested: [1, true] }, instant: new Date("2026-09-14T12:34:56.000Z"), amount: "123.4500" },
  ]);
  const environment = executor.environment;
  assert.ok(environment);
  assert.equal(environment.driver.profile, "mysql2-native");
  const typePolicy = (
    environment as typeof environment & { readonly typePolicy?: { readonly id: string; readonly hash: string } }
  ).typePolicy;
  assert.deepEqual(typePolicy, { id: MYSQL2_NATIVE.typePolicy.id, hash: MYSQL2_NATIVE.typePolicy.hash });
  const generated = generateModels(snapshot("mysql"), { typePolicy: MYSQL2_NATIVE.typePolicy });
  assertGeneratedProperty(generated.source, "ProfileValuesRow", "payload", "unknown", false);
  assertGeneratedProperty(generated.source, "ProfileValuesRow", "instant", "Date", false);
  assertGeneratedProperty(generated.source, "ProfileValuesRow", "amount", "string", false);
});

test("PV18 MySQL declarative profiles stay guarded without config observation", async () => {
  const executor = createMysql2Executor(
    mysqlConnectionWithoutConfig([{ payload: '{"nested":true}' }], [{ name: "payload", type: "JSON" }]),
    { profile: MYSQL2_LOSSLESS_TEXT },
  );
  const result = await executor.query(mysqlSql.rows`SELECT payload`.render());
  assert.deepEqual(result.rows, [{ payload: '{"nested":true}' }]);
  const environment = executor.environment;
  assert.ok(environment);
  assert.equal(environment.driver.profile, "mysql2-custom-profile");
  assert.equal(environment.capabilities["data.json-lossless-text"]?.status, "guarded");
});

test("PV18 text profiles fail closed on parsed MySQL and MariaDB representations", async () => {
  const mysql = createMysql2Executor(
    mysqlConnection(
      {
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        rowsAsArray: false,
        jsonStrings: false,
        dateStrings: false,
        typeCast: true,
      },
      [{ payload: { nested: true } }],
      [{ name: "payload", type: "JSON" }],
    ),
    { profile: MYSQL2_LOSSLESS_TEXT },
  );
  await assert.rejects(
    async () => mysql.query(mysqlSql.rows`SELECT payload`.render()),
    (error: unknown) => error instanceof ResultExactnessError,
  );

  const maria = createMariaDbExecutor(
    mariaConnection([{ payload: { nested: true } }], [{ name: "payload", columnType: 245 }]),
    { profile: MARIADB_LOSSLESS_TEXT },
  );
  await assert.rejects(
    async () => maria.query(mariaSql.rows`SELECT payload`.render()),
    (error: unknown) => error instanceof ResultExactnessError,
  );
});

test("PV18 MariaDB declarative native profile keeps parsed roots and Date values open", async () => {
  const executor = createMariaDbExecutor(
    mariaConnection(
      [{ payload: [1, { enabled: true }], instant: new Date("2026-09-14T12:34:56.000Z") }],
      [
        { name: "payload", columnType: 245 },
        { name: "instant", columnType: 12 },
      ],
    ),
    { profile: MARIADB_NATIVE },
  );
  const result = await executor.query(mariaSql.rows`SELECT payload, instant`.render());
  assert.deepEqual(result.rows, [{ payload: [1, { enabled: true }], instant: new Date("2026-09-14T12:34:56.000Z") }]);
  const environment = executor.environment;
  assert.ok(environment);
  assert.equal(environment.driver.profile, "mariadb-native");
  const generated = generateModels(snapshot("mariadb"), { typePolicy: MARIADB_NATIVE.typePolicy });
  assertGeneratedProperty(generated.source, "ProfileValuesRow", "payload", "unknown", false);
  assertGeneratedProperty(generated.source, "ProfileValuesRow", "instant", "Date", false);
});

test("PV18 MariaDB command metadata guards warningStatus and exact insertId", async () => {
  const warning = createMariaDbExecutor(
    mariaConnection({ affectedRows: 1, insertId: 9007199254740993n, warningStatus: 9007199254740992 }, []),
    { profile: MARIADB_LOSSLESS_TEXT },
  );
  await assert.rejects(
    async () => warning.query(mariaSql.command`UPDATE profile_values SET amount = ${"1.00"}`.render()),
    (error: unknown) => error instanceof ResultExactnessError,
  );
});
