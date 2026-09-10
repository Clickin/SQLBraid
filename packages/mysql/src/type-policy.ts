import type { TypePolicy } from "@sqlbraid/core";

const mappings = [
  { databaseType: "INT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "BIGINT", inputType: "bigint | string", outputType: "bigint | string", nullable: true },
  { databaseType: "DECIMAL", inputType: "string | number", outputType: "string", nullable: true },
  { databaseType: "VARCHAR", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "JSON", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

export const typePolicy: TypePolicy = {
  id: "mysql-default",
  hash: "mysql-default-v2",
  mappings,
  decode: (databaseType, value) => databaseType === "DECIMAL" && value !== null && value !== undefined ? String(value) : value,
  encode: (_databaseType, value) => value,
};
