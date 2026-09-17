import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  AdapterError,
  createRenderedStatement,
  isWellKnownCapabilityId,
  isPublicUnsupportedFeatureError,
  ResultExactnessError,
  PUBLIC_ERROR_DEFINITIONS,
  RoutineMappingError,
  SqlRenderError,
  UnsupportedFeatureError,
  WELL_KNOWN_CAPABILITIES,
  WELL_KNOWN_CAPABILITY_IDS,
} from "@sqlbraid/core";
import { createMysql2Executor } from "@sqlbraid/mysql/mysql2";
import { createPgExecutor } from "@sqlbraid/postgres/pg";
import { createD1Executor } from "@sqlbraid/sqlite/d1";
import { createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { createSqliteWasmExecutor } from "@sqlbraid/sqlite/wasm";
import {
  DatabaseResultKindError,
  DatabaseResultValidationError,
  DatabaseScopeError,
} from "@sqlbraid/runtime";

const docs = [
  new URL("../website/src/content/docs/reference/errors.md", import.meta.url),
  new URL("../website/src/content/docs/ko/reference/errors.md", import.meta.url),
];

function documentedCodes(url: URL): Set<string> {
  const rows = readFileSync(url, "utf8").split("\n").filter((line) => line.startsWith("|"));
  return new Set(rows.flatMap((line) => line.match(/BRAID_[A-Z0-9_]+/gu) ?? []));
}

test("the public registry links to exported owner classes and both error references", () => {
  const registryCodes = PUBLIC_ERROR_DEFINITIONS.map(({ code }) => code);
  assert.equal(new Set(registryCodes).size, registryCodes.length);
  assert.ok(registryCodes.includes("BRAID_BATCH_ABORTED"));
  assert.ok(registryCodes.includes("BRAID_PREPARE_UNSUPPORTED"));
  const fixedClassCodes = new Map<string, readonly string[]>([
    ["ResultExactnessError", [ResultExactnessError.code]],
    ["RoutineMappingError", [RoutineMappingError.code]],
    ["@sqlbraid/runtime:DatabaseResultKindError", [DatabaseResultKindError.code]],
    ["@sqlbraid/runtime:DatabaseResultValidationError", [DatabaseResultValidationError.code]],
    ["@sqlbraid/runtime:DatabaseScopeError", DatabaseScopeError.codes],
  ]);
  for (const [owner, codes] of fixedClassCodes) {
    const registryCodesForOwner = PUBLIC_ERROR_DEFINITIONS
      .filter((definition) => definition.owner === owner)
      .map((definition) => definition.code);
    assert.deepEqual([...registryCodesForOwner].sort(), [...codes].sort(), `${owner} registry linkage changed`);
  }
  const dynamicOwners = [UnsupportedFeatureError.name, AdapterError.name, SqlRenderError.name];
  const nonClassOwners = new Set([
    "TypeError with code",
    "prepared query validation",
    "adapter cleanup error with code",
    "compiler diagnostic",
    "runtime batch lifecycle/synthetic observer error",
  ]);
  const knownOwners = new Set([...fixedClassCodes.keys(), ...dynamicOwners, ...nonClassOwners]);
  assert.deepEqual(
    [...new Set(PUBLIC_ERROR_DEFINITIONS.map(({ owner }) => owner))].sort(),
    [...knownOwners].sort(),
  );
  for (const url of docs) {
    assert.deepEqual([...documentedCodes(url)].sort(), [...registryCodes].sort(), String(url));
  }
});

test("the machine-readable capability vocabulary matches support data and classifies evidence", () => {
  const catalog = JSON.parse(readFileSync(new URL("../support/capabilities.json", import.meta.url), "utf8")) as {
    capabilities: readonly { readonly id: string }[];
  };
  const catalogIds = catalog.capabilities.map(({ id }) => id);
  assert.deepEqual([...WELL_KNOWN_CAPABILITY_IDS], catalogIds);
  assert.deepEqual(
    WELL_KNOWN_CAPABILITIES.map(({ id }) => id),
    catalogIds,
  );
  assert.equal(new Set(WELL_KNOWN_CAPABILITY_IDS).size, WELL_KNOWN_CAPABILITY_IDS.length);
  assert.deepEqual(
    new Set(WELL_KNOWN_CAPABILITIES.map(({ family }) => family)),
    new Set(["support", "representation", "metadata"]),
  );
});

test("first-party executor declarations use known capability IDs while custom IDs remain available", () => {
  const prepared = {
    bind() { return prepared; },
    async raw() { return []; },
  };
  const executors = [
    createNodeSqliteExecutor({ prepare() { throw new Error("not called"); } }),
    createD1Executor({ prepare() { return prepared; }, batch: async () => [] }),
    createSqliteWasmExecutor({ prepare() { throw new Error("not called"); }, exec() {} }),
  ];
  for (const [index, executor] of executors.entries()) {
    const ids = Object.keys(executor.environment?.capabilities ?? {});
    assert.ok(ids.length > 0, `executor ${index} did not declare capabilities`);
    for (const id of ids) assert.equal(isWellKnownCapabilityId(id), true, `unknown first-party capability ${id}`);
  }
  const customId = "vendor.custom-capability";
  assert.equal(isWellKnownCapabilityId(customId), false);
});

test("public unsupported-feature conformance rejects semantically mismatched pairs", () => {
  assert.equal(
    isPublicUnsupportedFeatureError(new UnsupportedFeatureError(
      "statement.stream",
      "BRAID_STREAM_UNSUPPORTED",
      "streaming is unavailable",
    )),
    true,
  );
  assert.equal(
    isPublicUnsupportedFeatureError(new UnsupportedFeatureError(
      "statement.stream",
      "BRAID_BULK_UNSUPPORTED",
      "wrong feature/code pair",
    )),
    false,
  );
  assert.equal(
    isPublicUnsupportedFeatureError(new UnsupportedFeatureError(
      "statement.prepare",
      "BRAID_PREPARE_UNSUPPORTED",
      "prepared statements are unavailable",
    )),
    true,
  );
  assert.equal(
    isPublicUnsupportedFeatureError(new UnsupportedFeatureError(
      "statement.prepare",
      "BRAID_BULK_UNSUPPORTED",
      "bulk is a different capability",
    )),
    false,
  );
});

function hinted(dialectId: string) {
  return createRenderedStatement({
    segments: ["SELECT ", ""],
    parameters: [{ value: 1, hint: { databaseType: "INTEGER" } }],
    dialectId,
    resultKind: "rows",
  });
}

test("adapter-owned unsupported paths expose UnsupportedFeatureError and a code", async () => {
  const pg = createPgExecutor({
    async query() { throw new Error("must not execute"); },
    escapeIdentifier(value: string) { return value; },
    escapeLiteral(value: string) { return value; },
  });
  await assert.rejects(
    async () => pg.query(hinted("postgres")),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.bind-hint"
      && error.code === "BRAID_BIND_HINT_UNSUPPORTED",
  );

  const mysql = createMysql2Executor({
    async execute() { throw new Error("must not execute"); },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  });
  await assert.rejects(
    async () => mysql.query(hinted("mysql")),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.bind-hint"
      && error.code === "BRAID_BIND_HINT_UNSUPPORTED",
  );
  assert.throws(
    () => mysql.statementBinding.describeBulk!({
      statement: createRenderedStatement({
        segments: ["INSERT INTO example VALUES (", ")"],
        parameters: [{ value: 1 }],
        dialectId: "mysql",
        resultKind: "command",
      }),
      parameterSets: [[() => undefined]],
    }, { dialectId: "mysql", requestedReuse: "auto", transactionScoped: false }),
    (error: unknown) => error instanceof AdapterError && error.code === "BRAID_BIND_VALUE_UNSUPPORTED",
  );

  let prepares = 0;
  const sqlite = createNodeSqliteExecutor({
    prepare() {
      prepares += 1;
      throw new Error("must not prepare");
    },
  });
  await assert.rejects(
    async () => sqlite.query(hinted("sqlite")),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.bind-hint"
      && error.code === "BRAID_BIND_HINT_UNSUPPORTED",
  );
  assert.equal(prepares, 0);
});
