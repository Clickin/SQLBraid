import type { TypePolicy } from "@sqlbraid/core";

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
