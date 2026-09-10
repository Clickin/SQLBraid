import type { TypePolicy } from "../../core/src/index.js";

const mappings = [
  { databaseType: "INT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "BIGINT", inputType: "bigint | string", outputType: "bigint | string", nullable: true },
  { databaseType: "DECIMAL", inputType: "string | number", outputType: "string", nullable: true },
  { databaseType: "VARCHAR", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "JSON", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

export const typePolicy: TypePolicy = {
  id: "mysql-default",
  hash: "mysql-default-v1",
  mappings,
  decode: (_databaseType, value) => value,
  encode: (_databaseType, value) => value,
};
