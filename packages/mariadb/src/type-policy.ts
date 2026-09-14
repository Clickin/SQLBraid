import {
  decodeExactDecimal,
  decodeExactInteger,
  type TypePolicy,
} from "@sqlbraid/core";

const mappings = [
  { databaseType: "TINYINT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "SMALLINT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "INT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "BIGINT", inputType: "bigint", outputType: "bigint", nullable: true, numericFidelity: "exact-integer" as const },
  { databaseType: "DECIMAL", inputType: "string | number", outputType: "string", nullable: true, numericFidelity: "exact-decimal" as const },
  { databaseType: "NEWDECIMAL", inputType: "string | number", outputType: "string", nullable: true, numericFidelity: "exact-decimal" as const },
  { databaseType: "FLOAT", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "DOUBLE", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "VARCHAR", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "TEXT", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "JSON", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

export const typePolicy: TypePolicy = {
  id: "mariadb-default",
  hash: "mariadb-default-v2",
  mappings,
  decode: (databaseType, value) => {
    if (value === null || value === undefined) return value;
    const type = databaseType.trim().toUpperCase();
    if (type === "BIGINT" || type === "LONGLONG") return decodeExactInteger(value);
    if (type === "DECIMAL" || type === "NEWDECIMAL") return decodeExactDecimal(value, { allowBigInt: true });
    return value;
  },
  encode: (_databaseType, value) => value,
};
