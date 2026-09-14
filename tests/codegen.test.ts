import assert from "node:assert/strict";
import { test } from "vitest";
import { generateModels } from "@sqlbraid/codegen";
import type { TypePolicy } from "@sqlbraid/core";
import type { ColumnSnapshot, MetadataSnapshot, RelationSnapshot, TypeSnapshot } from "@sqlbraid/metadata";
import { SnapshotValidationError } from "@sqlbraid/metadata";
import { typePolicy as mysqlTypePolicy } from "@sqlbraid/mysql";
import { typePolicy as postgresTypePolicy } from "@sqlbraid/postgres";
import { typePolicy as sqliteTypePolicy } from "@sqlbraid/sqlite";
import {
  assertCompilesGeneratedSource,
  assertGeneratedProperty,
  assertGeneratedPropertyAbsent,
} from "./db/codegen.js";

type ColumnSeed = Pick<ColumnSnapshot, "name" | "type" | "nullable"> & Partial<ColumnSnapshot>;

const policy: TypePolicy = {
  id: "test-policy",
  hash: "test-policy-v1",
  mappings: [
    { databaseType: "int2", inputType: "number", outputType: "number", nullable: true },
    { databaseType: "int4", inputType: "number", outputType: "number", nullable: true },
    { databaseType: "int8", inputType: "bigint", outputType: "bigint", nullable: true },
    { databaseType: "numeric", inputType: "string | number", outputType: "string", nullable: true },
    { databaseType: "text", inputType: "string", outputType: "string", nullable: true },
    { databaseType: "bool", inputType: "boolean", outputType: "boolean", nullable: true },
    { databaseType: "json", inputType: "unknown", outputType: "unknown", nullable: true },
  ],
  decode: (_databaseType, value) => value,
  encode: (_databaseType, value) => value,
};

function relation(
  identity: string,
  name: string,
  kind: RelationSnapshot["kind"],
  columns: readonly ColumnSeed[],
  extra: { readonly namespace?: string; readonly strict?: boolean } = {},
): RelationSnapshot {
  return {
    identity,
    name,
    kind,
    columns: columns.map((column, ordinal) => ({ ...column, ordinal })),
    ...extra,
  };
}

function snapshot(
  relations: Readonly<Record<string, RelationSnapshot>>,
  options: { readonly dialect?: string; readonly types?: Readonly<Record<string, TypeSnapshot>> } = {},
): MetadataSnapshot {
  return {
    format: "sqlbraid-metadata",
    formatVersion: 1,
    dialect: options.dialect ?? "postgres",
    dialectVersion: "16",
    server: {},
    namespaces: {},
    types: options.types ?? {},
    relations,
    routines: {},
    metadata: {},
  };
}

test("generates Row, Insert, and Update with database evidence controlling nullability and write shape", async () => {
  const result = generateModels({
    ...snapshot({
      "public.users": relation("public.users", "users", "table", [
        { name: "id", type: "int4", nullable: false },
        { name: "nickname", type: "text", nullable: true },
        { name: "created_at", type: "text", nullable: false, defaultExpression: "now()" },
        { name: "identity_id", type: "int4", nullable: false, identity: true },
        { name: "computed", type: "text", nullable: false, generated: true },
        { name: "locked", type: "text", nullable: false, updatable: false },
        { name: "insert_forbidden", type: "text", nullable: false, insertable: false },
        { name: "explicit_identity", type: "int4", nullable: false, identity: true },
      ]),
    }),
  }, { typePolicy: policy });

  assert.equal(result.models[0]?.modelName, "Users");
  assert.equal(result.models[0]?.rowName, "UsersRow");
  assert.equal(result.models[0]?.insertName, "UsersInsert");
  assert.equal(result.models[0]?.updateName, "UsersUpdate");
  assertGeneratedProperty(result.source, "UsersRow", "id", "number", false);
  assertGeneratedProperty(result.source, "UsersRow", "nickname", "string | null", false);
  assertGeneratedProperty(result.source, "UsersInsert", "id", "number", false);
  assertGeneratedProperty(result.source, "UsersInsert", "nickname", "string | null", true);
  assertGeneratedProperty(result.source, "UsersInsert", "created_at", "string", true);
  assertGeneratedProperty(result.source, "UsersInsert", "identity_id", "number", true);
  assertGeneratedProperty(result.source, "UsersInsert", "locked", "string", false);
  assertGeneratedPropertyAbsent(result.source, "UsersInsert", "computed");
  assertGeneratedPropertyAbsent(result.source, "UsersInsert", "insert_forbidden");
  assertGeneratedProperty(result.source, "UsersUpdate", "explicit_identity", "number", true);
  assertGeneratedProperty(result.source, "UsersUpdate", "insert_forbidden", "string", true);
  assertGeneratedPropertyAbsent(result.source, "UsersUpdate", "computed");
  assertGeneratedPropertyAbsent(result.source, "UsersUpdate", "locked");
  assert.equal(result.diagnostics.length, 0);
  await assertCompilesGeneratedSource(result.source, "codegen-write-matrix");
});

test("keeps Row-only models for non-table relations and warns for unknown kinds", () => {
  const result = generateModels({
    ...snapshot({
      "public.v": relation("public.v", "v", "view", [{ name: "value", type: "text", nullable: false }]),
      "public.m": relation("public.m", "m", "materialized", [{ name: "value", type: "text", nullable: false }]),
      "public.f": relation("public.f", "f", "foreign", [{ name: "value", type: "text", nullable: false }]),
      "public.virtual": relation("public.virtual", "virtual", "virtual", [{ name: "value", type: "text", nullable: false }]),
      "public.u": relation("public.u", "u", "unknown", [{ name: "value", type: "text", nullable: false }]),
      "public.empty": relation("public.empty", "empty", "unknown", []),
    }),
  }, { typePolicy: policy });

  assert.deepEqual(result.models.map((model) => model.relationIdentity), [
    "public.f",
    "public.m",
    "public.u",
    "public.v",
    "public.virtual",
  ]);
  for (const model of result.models) {
    assert.equal(model.insertName, undefined);
    assert.equal(model.updateName, undefined);
    assert.match(result.source, new RegExp(`export interface ${model.rowName} \\{`, "u"));
  }
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "CODEGEN_UNKNOWN_RELATION_KIND").length, 2);
  assert.equal(result.models.some((model) => model.relationIdentity === "public.empty"), false);
});

test("resolves qualified and case-insensitive type evidence without suffix guessing", () => {
  const result = generateModels({
    ...snapshot({
      "public.values": relation("public.values", "values", "table", [
        { name: "small_id", type: "pg_catalog.int2", nullable: false },
        { name: "id", type: "pg_catalog.int4", nullable: false },
        { name: "big_id", type: "pg_catalog.int8", nullable: false },
        { name: "amount", type: "pg_catalog.numeric", nullable: false },
        { name: "label", type: "TEXT", nullable: false },
        { name: "enabled", type: "pg_catalog.bool", nullable: false },
        { name: "custom", type: "vendor.int4_custom", nullable: false },
      ]),
    }, {
      types: {
        "pg_catalog.int2": { identity: "pg_catalog.int2", name: "int2", kind: "scalar" },
        "pg_catalog.int4": { identity: "pg_catalog.int4", name: "int4", kind: "scalar" },
        "pg_catalog.int8": { identity: "pg_catalog.int8", name: "int8", kind: "scalar" },
        "pg_catalog.numeric": { identity: "pg_catalog.numeric", name: "numeric", kind: "scalar" },
        "pg_catalog.bool": { identity: "pg_catalog.bool", name: "bool", kind: "scalar" },
      },
    }),
  }, { typePolicy: postgresTypePolicy });

  assertGeneratedProperty(result.source, "ValuesRow", "small_id", "number", false);
  assertGeneratedProperty(result.source, "ValuesRow", "id", "number", false);
  assertGeneratedProperty(result.source, "ValuesRow", "big_id", "bigint", false);
  assertGeneratedProperty(result.source, "ValuesRow", "amount", "string", false);
  assertGeneratedProperty(result.source, "ValuesRow", "label", "string", false);
  assertGeneratedProperty(result.source, "ValuesRow", "enabled", "boolean", false);
  assertGeneratedProperty(result.source, "ValuesRow", "custom", "unknown", false);
  assertGeneratedProperty(result.source, "ValuesInsert", "amount", "string | number", false);
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "CODEGEN_UNKNOWN_DATABASE_TYPE").length, 1);
});

test("uses unknown plus a stable diagnostic for conflicting normalized mappings", () => {
  const conflicting: TypePolicy = {
    ...policy,
    mappings: [
      { databaseType: "INT4", inputType: "number", outputType: "number", nullable: true },
      { databaseType: "int4", inputType: "bigint", outputType: "bigint", nullable: true },
    ],
  };
  const result = generateModels({
    ...snapshot({
      "public.values": relation("public.values", "values", "table", [{ name: "id", type: "int4", nullable: false }]),
    }),
  }, { typePolicy: conflicting });

  assertGeneratedProperty(result.source, "ValuesRow", "id", "unknown", false);
  assertGeneratedProperty(result.source, "ValuesInsert", "id", "unknown", false);
  const diagnostic = result.diagnostics.find((entry) => entry.code === "CODEGEN_AMBIGUOUS_TYPE_MAPPING");
  assert.equal(diagnostic?.severity, "error");
  assert.match(diagnostic?.message ?? "", /INT4.*int4/u);
  assert.deepEqual(
    generateModels(snapshot({}), { typePolicy: conflicting }).diagnostics,
    generateModels(snapshot({}), { typePolicy: { ...conflicting, mappings: [...conflicting.mappings].reverse() } }).diagnostics,
  );
  assert.equal(generateModels(snapshot({}), { typePolicy: conflicting }).diagnostics[0]?.severity, "error");
});

test("selected policy controls input and output while column evidence controls nullability", async () => {
  const metadata = snapshot({
    t: relation("t", "t", "table", [{ name: "amount", type: "numeric", nullable: true }]),
  });
  const custom: TypePolicy = {
    ...policy,
    mappings: [{ databaseType: "numeric", inputType: "string", outputType: "Readonly<{ amount: string }>", nullable: false }],
    encode: () => { throw new Error("codegen must not execute codecs"); },
    decode: () => { throw new Error("codegen must not execute codecs"); },
  };
  const result = generateModels(metadata, { typePolicy: custom });
  assertGeneratedProperty(result.source, "TRow", "amount", "Readonly<{ amount: string }> | null", false);
  assertGeneratedProperty(result.source, "TInsert", "amount", "string | null", true);
  assertGeneratedProperty(result.source, "TUpdate", "amount", "string | null", true);
  assert.notEqual(result.source, generateModels(metadata, { typePolicy: policy }).source);
  await assertCompilesGeneratedSource(result.source, "codegen-selected-policy");
});

test("type evidence must be an own metadata entry rather than an object prototype member", () => {
  const metadata = snapshot({ t: relation("t", "t", "table", [{ name: "value", type: "constructor", nullable: false }]) });
  const result = generateModels(metadata, { typePolicy: {
    ...policy,
    mappings: [{ databaseType: "Object", inputType: "string", outputType: "string", nullable: false }],
  } });
  assertGeneratedProperty(result.source, "TRow", "value", "unknown", false);
  assert.equal(result.diagnostics[0]?.code, "CODEGEN_UNKNOWN_DATABASE_TYPE");
});

test("matches MySQL metadata spellings to first-party case-normalized policy mappings", () => {
  const result = generateModels({
    ...snapshot({
      "app.values": relation("app.values", "values", "table", [
        { name: "id", type: "int", nullable: false },
        { name: "big_id", type: "bigint", nullable: false },
        { name: "amount", type: "decimal", nullable: false },
        { name: "label", type: "varchar", nullable: false },
        { name: "payload", type: "json", nullable: true },
      ]),
    }, { dialect: "mysql" }),
  }, { typePolicy: mysqlTypePolicy });
  assertGeneratedProperty(result.source, "ValuesRow", "id", "number", false);
  assertGeneratedProperty(result.source, "ValuesRow", "big_id", "bigint", false);
  assertGeneratedProperty(result.source, "ValuesRow", "amount", "string", false);
  assertGeneratedProperty(result.source, "ValuesRow", "label", "string", false);
  assertGeneratedProperty(result.source, "ValuesRow", "payload", "unknown | null", false);
  assert.equal(result.diagnostics.length, 0);
});

test("distinguishes exact, lossy, known-open, and unknown type mappings", () => {
  const result = generateModels({
    ...snapshot({
      "public.values": relation("public.values", "values", "table", [
        { name: "amount", type: "decimal", nullable: false },
        { name: "payload", type: "json", nullable: true },
        { name: "missing", type: "vendor_number", nullable: false },
      ]),
    }),
  }, {
    typePolicy: {
      ...policy,
      mappings: [
        { databaseType: "decimal", inputType: "string | number", outputType: "number", nullable: true, numericFidelity: "approximate-float" },
        { databaseType: "json", inputType: "unknown", outputType: "unknown", nullable: true },
        { databaseType: "int8", inputType: "bigint", outputType: "bigint", nullable: true, numericFidelity: "exact-integer" },
      ],
    },
    typeOverrides: {
      columns: { "public.values": { amount: { outputType: "string" } } },
    },
  });

  assertGeneratedProperty(result.source, "ValuesRow", "amount", "string", false);
  assertGeneratedProperty(result.source, "ValuesRow", "payload", "unknown | null", false);
  assertGeneratedProperty(result.source, "ValuesRow", "missing", "unknown", false);
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "CODEGEN_LOSSY_NUMERIC_REPRESENTATION").length, 1);
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "CODEGEN_UNKNOWN_DATABASE_TYPE").length, 1);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.databaseType === "json"), false);
});

test("keeps SQLite non-STRICT columns conservative but maps supported STRICT declarations", async () => {
  const strict = generateModels({
    ...snapshot({
      "main.strict_table": relation("main.strict_table", "strict_table", "table", [
        { name: "id", type: "INTEGER", nullable: false },
        { name: "ratio", type: "REAL", nullable: false },
        { name: "label", type: "TEXT", nullable: false },
        { name: "bytes", type: "BLOB", nullable: false },
        { name: "anything", type: "ANY", nullable: false },
      ], { strict: true }),
    }, { dialect: "sqlite" }),
  }, { typePolicy: sqliteTypePolicy });
  assertGeneratedProperty(strict.source, "StrictTableRow", "id", "number | bigint", false);
  assertGeneratedProperty(strict.source, "StrictTableRow", "ratio", "number", false);
  assertGeneratedProperty(strict.source, "StrictTableRow", "label", "string", false);
  assertGeneratedProperty(strict.source, "StrictTableRow", "bytes", "Uint8Array", false);
  assertGeneratedProperty(strict.source, "StrictTableRow", "anything", "unknown", false);
  assert.equal(strict.diagnostics.filter((diagnostic) => diagnostic.code === "CODEGEN_LOSSY_NUMERIC_REPRESENTATION").length, 1);
  await assertCompilesGeneratedSource(strict.source, "codegen-sqlite-strict");

  const dynamic = generateModels({
    ...snapshot({
      "main.dynamic": relation("main.dynamic", "dynamic", "table", [
        { name: "id", type: "INTEGER", nullable: false },
      ]),
    }, { dialect: "sqlite" }),
  }, {
    typePolicy: {
      ...policy,
      mappings: [{ databaseType: "INTEGER", inputType: "number", outputType: "number", nullable: true }],
    },
  });
  assertGeneratedProperty(dynamic.source, "DynamicRow", "id", "unknown", false);
  assert.equal(dynamic.diagnostics[0]?.code, "CODEGEN_SQLITE_DYNAMIC_TYPE");
});

test("applies SQLite non-STRICT column and exact database-type overrides independently per side", () => {
  const result = generateModels({
    ...snapshot({
      "main.dynamic": relation("main.dynamic", "dynamic", "table", [
        { name: "column_only", type: "int4", nullable: false },
        { name: "database_only", type: "text", nullable: false },
        { name: "both", type: "text", nullable: false },
      ]),
    }, { dialect: "sqlite" }),
  }, {
    typePolicy: policy,
    typeOverrides: {
      databaseTypes: { text: { inputType: "DatabaseInput", outputType: "DatabaseOutput" } },
      columns: {
        "main.dynamic": {
          column_only: { outputType: "ColumnOutput" },
          both: { outputType: "ColumnOutput" },
        },
      },
    },
  });

  assertGeneratedProperty(result.source, "DynamicRow", "column_only", "ColumnOutput", false);
  assertGeneratedProperty(result.source, "DynamicInsert", "column_only", "unknown", false);
  assertGeneratedProperty(result.source, "DynamicRow", "database_only", "DatabaseOutput", false);
  assertGeneratedProperty(result.source, "DynamicInsert", "database_only", "DatabaseInput", false);
  assertGeneratedProperty(result.source, "DynamicRow", "both", "ColumnOutput", false);
  assertGeneratedProperty(result.source, "DynamicInsert", "both", "DatabaseInput", false);
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "CODEGEN_SQLITE_DYNAMIC_TYPE").length, 3);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "CODEGEN_UNKNOWN_DATABASE_TYPE"), false);
});

test("disambiguates every final exported declaration name, including same-relation and cross-relation collisions", () => {
  const sameRelation = generateModels({
    ...snapshot({
      "public.users": relation("public.users", "users", "table", [
        { name: "id", type: "int4", nullable: false },
      ]),
    }),
  }, {
    typePolicy: policy,
    naming: { suffixes: { row: "Model", insert: "Model", update: "Patch" } },
  });
  const sameRelationNames = sameRelation.models.flatMap((model) =>
    [model.rowName, model.insertName, model.updateName].filter((name): name is string => name !== undefined),
  );
  assert.equal(new Set(sameRelationNames).size, sameRelationNames.length);
  assert.equal(sameRelation.diagnostics.some((diagnostic) => diagnostic.code === "CODEGEN_MODEL_NAME_COLLISION" && diagnostic.severity === "error"), true);

  const crossRelation = generateModels({
    ...snapshot({
      "public.user": relation("public.user", "user", "table", [{ name: "id", type: "int4", nullable: false }]),
      "public.user_row": relation("public.user_row", "user_row", "view", [{ name: "id", type: "int4", nullable: false }]),
    }),
  }, {
    typePolicy: policy,
    naming: { suffixes: { row: "X", insert: "Create", update: "RowX" } },
  });
  const crossRelationNames = crossRelation.models.flatMap((model) =>
    [model.rowName, model.insertName, model.updateName].filter((name): name is string => name !== undefined),
  );
  assert.equal(new Set(crossRelationNames).size, crossRelationNames.length);
  assert.equal(crossRelation.diagnostics.some((diagnostic) => diagnostic.code === "CODEGEN_MODEL_NAME_COLLISION" && diagnostic.severity === "error"), true);
  assert.match(crossRelation.source, /export interface UserRowX_[0-9a-f]{12} \{/u);
});

test("sanitizes arbitrary names, preserves exact property keys, and resolves collisions independent of map order", async () => {
  const relations = {
    "public.users": relation("public.users", "users", "table", [{ name: "select", type: "text", nullable: false }], { namespace: "public" }),
    "audit.users": relation("audit.users", "users", "table", [{ name: "patient-id", type: "text", nullable: false }], { namespace: "audit" }),
    "main.123_table": relation("main.123_table", "123_table", "table", [{ name: "환자 번호", type: "text", nullable: false }], { namespace: "main" }),
    "main.order-items": relation("main.order-items", "order-items", "table", [{ name: "class", type: "text", nullable: false }], { namespace: "main" }),
  };
  const first = generateModels({ ...snapshot(relations) }, { typePolicy: policy });
  const second = generateModels({
    ...snapshot({
      "main.order-items": relations["main.order-items"],
      "main.123_table": relations["main.123_table"],
      "audit.users": relations["audit.users"],
      "public.users": relations["public.users"],
    }),
  }, { typePolicy: policy });

  assert.equal(first.source, second.source);
  assert.deepEqual(first.models.map((model) => model.modelName), ["AuditUsers", "_123Table", "OrderItems", "PublicUsers"]);
  assertGeneratedProperty(first.source, "PublicUsersRow", "select", "string", false);
  assertGeneratedProperty(first.source, "AuditUsersRow", "patient-id", "string", false);
  assertGeneratedProperty(first.source, "_123TableRow", "환자 번호", "string", false);
  assertGeneratedProperty(first.source, "OrderItemsRow", "class", "string", false);
  await assertCompilesGeneratedSource(first.source, "codegen-golden");
});

test("handles reserved, Unicode, punctuation-only, and namespace/hash collisions without renaming unrelated models", async () => {
  const coreRelations = {
    "public.class": relation("public.class", "class", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "public" }),
    "public.default": relation("public.default", "default", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "public" }),
    "public.function": relation("public.function", "function", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "public" }),
    "public.interface": relation("public.interface", "interface", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "public" }),
    "public.korean": relation("public.korean", "환자/번호", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "public" }),
    "public.numeric": relation("public.numeric", "123", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "public" }),
    "public.unicode-number": relation("public.unicode-number", "x²", "table", [{ name: "quote\"\\\n\u2028", type: "text", nullable: false }]),
    "public.combining": relation("public.combining", "\u0301x", "table", [{ name: "value", type: "text", nullable: false }]),
    "public.punctuation": relation("public.punctuation", "---", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "public" }),
    "a.first": relation("a.first", "---", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "a" }),
    "a.second": relation("a.second", "---", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "a" }),
  };
  const result = generateModels({ ...snapshot(coreRelations) }, { typePolicy: policy });
  const byIdentity = new Map(result.models.map((model) => [model.relationIdentity, model.modelName]));
  assert.equal(byIdentity.get("public.class"), "Class");
  assert.equal(byIdentity.get("public.default"), "Default");
  assert.equal(byIdentity.get("public.function"), "Function");
  assert.equal(byIdentity.get("public.interface"), "Interface");
  assert.equal(byIdentity.get("public.korean"), "환자번호");
  assert.equal(byIdentity.get("public.numeric"), "_123");
  assert.equal(byIdentity.get("public.punctuation"), "PublicRelation");
  assert.match(byIdentity.get("a.first") ?? "", /^ARelation_[0-9a-f]{12}$/u);
  assert.match(byIdentity.get("a.second") ?? "", /^ARelation_[0-9a-f]{12}$/u);
  assert.notEqual(byIdentity.get("a.first"), byIdentity.get("a.second"));
  assert.equal(result.models.filter((model) => model.modelName === "ARelation").length, 0);

  const extended = generateModels({
    ...snapshot({
      ...coreRelations,
      "public.unrelated": relation("public.unrelated", "unrelated", "table", [{ name: "value", type: "text", nullable: false }], { namespace: "public" }),
    }),
  }, { typePolicy: policy });
  for (const model of result.models) {
    assert.equal(extended.models.find((candidate) => candidate.relationIdentity === model.relationIdentity)?.modelName, model.modelName);
  }
  await assertCompilesGeneratedSource(result.source, "codegen-identifiers");
});

test("reordered metadata maps and capture timestamps preserve bytes without mutating inputs", () => {
  const types: Record<string, TypeSnapshot> = {
    "pg_catalog.text": { identity: "pg_catalog.text", name: "text", kind: "scalar" },
    "pg_catalog.int4": { identity: "pg_catalog.int4", name: "int4", kind: "scalar" },
  };
  const metadata = snapshot({ t: relation("t", "t", "table", [
    { name: "first", type: "pg_catalog.int4", nullable: false },
    { name: "second", type: "pg_catalog.text", nullable: true },
  ]) }, { types });
  const before = JSON.stringify(metadata);
  const first = generateModels(metadata, { typePolicy: policy });
  const reordered = { ...metadata, types: Object.fromEntries(Object.entries(types).reverse()), metadata: { generatedAt: "later" } };
  const second = generateModels(reordered, { typePolicy: policy });
  assert.equal(first.source, second.source);
  assert.equal(first.metadataHash, second.metadataHash);
  assert.deepEqual(first.models, second.models);
  assert.equal(JSON.stringify(metadata), before);
  assert.ok(first.source.endsWith("\n"));
  assert.ok(!first.source.includes("\r"));
});

test("returns provenance and keeps policy comments single-line", () => {
  const result = generateModels({
    ...snapshot({
      "public.values": relation("public.values", "values", "table", [{ name: "value", type: "text", nullable: false }]),
    }),
  }, { typePolicy: { ...policy, id: "policy\nid", hash: "hash\u2028value" } });
  assert.equal(result.typePolicyId, "policy\nid");
  assert.equal(result.typePolicyHash, "hash\u2028value");
  assert.match(result.source, /\/\/ Metadata: [0-9a-f]{64}\n/u);
  assert.match(result.source, /\/\/ TypePolicy: policy\\u000aid \(hash\\u2028value\)\n/u);
  assert.equal(result.source.split("\n").filter((line) => line.startsWith("// TypePolicy:")).length, 1);
});

test("filters exact relations, applies naming and type override precedence, and hashes policy options canonically", () => {
  const metadata = snapshot({
    "public.users": relation("public.users", "users", "table", [
      { name: "id", type: "int4", nullable: false },
      { name: "created_at", type: "text", nullable: false },
    ], { namespace: "public" }),
    "audit.users": relation("audit.users", "users", "table", [
      { name: "id", type: "int4", nullable: false },
    ], { namespace: "audit" }),
    "public.view": relation("public.view", "view", "view", [
      { name: "id", type: "int4", nullable: false },
    ], { namespace: "public" }),
  });
  const first = generateModels(metadata, {
    typePolicy: policy,
    filters: { includeNamespaces: ["public"], excludeRelations: ["public.view"] },
    naming: { relations: { "public.users": "User" }, suffixes: { row: "Record", insert: "Create", update: "Patch" } },
    typeOverrides: {
      databaseTypes: { text: { inputType: "string", outputType: "DbText" } },
      columns: { "public.users": { created_at: { inputType: "DomainDate", outputType: "DomainDate" } } },
    },
  });
  assert.deepEqual(first.models.map((model) => model.modelName), ["User"]);
  assert.match(first.source, /export interface UserRecord/u);
  assert.match(first.source, /export interface UserCreate/u);
  assertGeneratedProperty(first.source, "UserRecord", "created_at", "DomainDate", false);
  assertGeneratedProperty(first.source, "UserCreate", "created_at", "DomainDate", false);
  assert.equal(first.diagnostics.length, 0);
  const second = generateModels(metadata, {
    typePolicy: policy,
    filters: { excludeRelations: ["public.view"], includeNamespaces: ["public"] },
    naming: { suffixes: { update: "Patch", insert: "Create", row: "Record" }, relations: { "public.users": "User" } },
    typeOverrides: {
      columns: { "public.users": { created_at: { outputType: "DomainDate", inputType: "DomainDate" } } },
      databaseTypes: { text: { outputType: "DbText", inputType: "string" } },
    },
  });
  assert.equal(first.optionsHash, second.optionsHash);
  assert.equal(first.source, second.source);

  const partial = generateModels(metadata, {
    typePolicy: { ...policy, mappings: policy.mappings.filter((mapping) => mapping.databaseType !== "text") },
    filters: { includeNamespaces: ["public"] },
    typeOverrides: { columns: { "public.users": { created_at: { outputType: "DomainDate" } } } },
  });
  assertGeneratedProperty(partial.source, "UsersRow", "created_at", "DomainDate", false);
  assertGeneratedProperty(partial.source, "UsersInsert", "created_at", "unknown", false);
  assert.equal(partial.diagnostics.some((diagnostic) => diagnostic.code === "CODEGEN_UNKNOWN_INPUT_TYPE"), true);
});

test("rejects invalid or colliding explicit model names and reports unused exact overrides", () => {
  const metadata = snapshot({
    "public.first": relation("public.first", "first", "table", [{ name: "id", type: "int4", nullable: false }], { namespace: "public" }),
    "public.second": relation("public.second", "second", "table", [{ name: "id", type: "int4", nullable: false }], { namespace: "public" }),
    "public.third": relation("public.third", "third", "table", [{ name: "id", type: "int4", nullable: false }], { namespace: "public" }),
  });
  const result = generateModels(metadata, {
    typePolicy: policy,
    naming: { relations: { "public.first": "1Bad", "public.second": "Same", "public.third": "Same" } },
    typeOverrides: {
      columns: { "missing.relation": { id: { outputType: "Id" } }, "public.first": { missing: { outputType: "Missing" } } },
      databaseTypes: { missing_type: { outputType: "Missing" } },
    },
  });
  assert.equal(result.diagnostics.find((diagnostic) => diagnostic.code === "CODEGEN_INVALID_MODEL_NAME")?.severity, "error");
  assert.equal(result.diagnostics.find((diagnostic) => diagnostic.code === "CODEGEN_MODEL_NAME_COLLISION")?.severity, "error");
  assert.equal(result.diagnostics.find((diagnostic) => diagnostic.code === "CODEGEN_TYPE_RELATION_NOT_FOUND")?.severity, "warning");
  assert.equal(result.diagnostics.find((diagnostic) => diagnostic.code === "CODEGEN_TYPE_COLUMN_NOT_FOUND")?.severity, "warning");
  assert.equal(result.diagnostics.find((diagnostic) => diagnostic.code === "CODEGEN_DATABASE_TYPE_OVERRIDE_UNUSED")?.severity, "warning");
});

test("rejects malformed policies before generation", () => {
  const value = snapshot({
    "public.values": relation("public.values", "values", "table", [{ name: "id", type: "int4", nullable: false }]),
  });
  assert.throws(
    () => generateModels(value, { typePolicy: { ...policy, id: "" } }),
    (error: unknown) => error instanceof TypeError && /id/u.test(error.message),
  );
  assert.throws(
    () => generateModels(value, { typePolicy: { ...policy, mappings: [{ databaseType: "int4", inputType: "", outputType: "number", nullable: true }] } }),
    TypeError,
  );
  assert.throws(
    () => generateModels(JSON.parse(JSON.stringify({ ...value, format: "wrong" })), { typePolicy: policy }),
    SnapshotValidationError,
  );
});
