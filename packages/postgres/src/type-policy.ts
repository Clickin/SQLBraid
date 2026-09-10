import type { TypePolicy } from "../../core/src/index.js";

const mappings = [
  { databaseType: "int2", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "int4", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "int8", inputType: "bigint", outputType: "bigint", nullable: true },
  { databaseType: "numeric", inputType: "string | number", outputType: "string", nullable: true },
  { databaseType: "text", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "bool", inputType: "boolean", outputType: "boolean", nullable: true },
] as const;

export const typePolicy: TypePolicy = {
  id: "postgres-default",
  hash: "postgres-default-v1",
  mappings,
  decode: (_databaseType, value) => value,
  encode: (_databaseType, value) => value,
};
