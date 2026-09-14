import {
  decodeExactInteger,
  type TypeMapping,
  type TypePolicy,
} from "@sqlbraid/core";

import type { SqliteIntegerMode } from "./node-sqlite.js";

const integerMappings = {
  number: { databaseType: "INTEGER", inputType: "number", outputType: "number", nullable: true },
  bigint: { databaseType: "INTEGER", inputType: "bigint", outputType: "bigint", nullable: true, numericFidelity: "exact-integer" as const },
  union: { databaseType: "INTEGER", inputType: "number | bigint", outputType: "number | bigint", nullable: true },
} as const;

const SQLITE_SAFE_INTEGER_RANGE = {
  min: BigInt(Number.MIN_SAFE_INTEGER),
  max: BigInt(Number.MAX_SAFE_INTEGER),
} as const;

function decodeInteger(mode: SqliteIntegerMode | undefined, value: unknown): unknown {
  if (mode === "bigint") return decodeExactInteger(value);
  if (mode !== "number") return value;
  return Number(decodeExactInteger(value, SQLITE_SAFE_INTEGER_RANGE));
}

function mappingsFor(mode: SqliteIntegerMode | undefined): readonly TypeMapping[] {
  return [
    integerMappings[mode ?? "union"],
    { databaseType: "REAL", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
    { databaseType: "TEXT", inputType: "string", outputType: "string", nullable: true },
    { databaseType: "BLOB", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
    { databaseType: "ANY", inputType: "unknown", outputType: "unknown", nullable: true },
  ];
}

function makeTypePolicy(mode: SqliteIntegerMode | undefined): TypePolicy {
  const suffix = mode ?? "union";
  return {
    id: `sqlite-${suffix}`,
    hash: `sqlite-${suffix}-v2`,
    mappings: mappingsFor(mode),
    decode: (databaseType, value) => {
      if (value === null || value === undefined) return value;
      if (databaseType.trim().toUpperCase() === "INTEGER") return decodeInteger(mode, value);
      return value;
    },
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
  { databaseType: "REAL", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
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
