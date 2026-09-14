import type { TypePolicy } from "@sqlbraid/core";

const mappings = [
  { databaseType: "TINYINT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "SMALLINT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "INT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "BIGINT", inputType: "bigint", outputType: "bigint", nullable: true },
  { databaseType: "DECIMAL", inputType: "string | number", outputType: "string", nullable: true },
  { databaseType: "FLOAT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "DOUBLE", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "VARCHAR", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "TEXT", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "JSON", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

export const typePolicy: TypePolicy = {
  id: "mariadb-default",
  hash: "mariadb-default-v1",
  mappings,
  decode: (databaseType, value) => /^(?:DECIMAL|NEWDECIMAL)$/iu.test(databaseType) && value !== null && value !== undefined
    ? String(value)
    : value,
  encode: (_databaseType, value) => value,
};
