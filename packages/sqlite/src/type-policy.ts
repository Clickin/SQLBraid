import type { TypeMapping, TypePolicy } from "@sqlbraid/core";

import type { SqliteIntegerMode } from "./node-sqlite.js";

const integerMappings = {
  number: { databaseType: "INTEGER", inputType: "number", outputType: "number", nullable: true },
  bigint: { databaseType: "INTEGER", inputType: "bigint", outputType: "bigint", nullable: true },
  union: { databaseType: "INTEGER", inputType: "number | bigint", outputType: "number | bigint", nullable: true },
} as const;

function mappingsFor(mode: SqliteIntegerMode | undefined): readonly TypeMapping[] {
  return [
    integerMappings[mode ?? "union"],
    { databaseType: "REAL", inputType: "number", outputType: "number", nullable: true },
    { databaseType: "TEXT", inputType: "string", outputType: "string", nullable: true },
    { databaseType: "BLOB", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
    { databaseType: "ANY", inputType: "unknown", outputType: "unknown", nullable: true },
  ];
}

function makeTypePolicy(mode: SqliteIntegerMode | undefined): TypePolicy {
  const suffix = mode ?? "union";
  return {
    id: `sqlite-${suffix}`,
    hash: `sqlite-${suffix}-v1`,
    mappings: mappingsFor(mode),
    decode: (_databaseType, value) => value,
    encode: (_databaseType, value) => value,
  };
}

export function typePolicyForIntegerMode(mode: SqliteIntegerMode): TypePolicy {
  if (mode !== "number" && mode !== "bigint") {
    throw new TypeError('SQLite integerMode must be "number" or "bigint".');
  }
  return makeTypePolicy(mode);
}

const mappings = [
  { databaseType: "INTEGER", inputType: "number | bigint", outputType: "number | bigint", nullable: true },
  { databaseType: "REAL", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "TEXT", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "BLOB", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "ANY", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

export const typePolicy: TypePolicy = {
  id: "sqlite-default",
  hash: "sqlite-default-v2",
  mappings,
  decode: (_databaseType, value) => value,
  encode: (_databaseType, value) => value,
};
