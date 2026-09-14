import {
  decodeExactDecimal,
  decodeExactInteger,
  type TypePolicy,
} from "@sqlbraid/core";

const mappings = [
  { databaseType: "INT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "BIGINT", inputType: "bigint | string", outputType: "bigint", nullable: true, numericFidelity: "exact-integer" as const },
  { databaseType: "LONGLONG", inputType: "bigint | string", outputType: "bigint", nullable: true, numericFidelity: "exact-integer" as const },
  { databaseType: "DECIMAL", inputType: "string | number", outputType: "string", nullable: true, numericFidelity: "exact-decimal" as const },
  { databaseType: "NEWDECIMAL", inputType: "string | number", outputType: "string", nullable: true, numericFidelity: "exact-decimal" as const },
  { databaseType: "FLOAT", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "DOUBLE", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "VARCHAR", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "JSON", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

function decode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = databaseType.trim().toUpperCase();
  if (type === "BIGINT" || type === "LONGLONG") return decodeExactInteger(value);
  if (type === "DECIMAL" || type === "NEWDECIMAL") return decodeExactDecimal(value, { allowBigInt: true });
  return value;
}

export const typePolicy: TypePolicy = {
  id: "mysql-default",
  hash: "mysql-default-v3",
  mappings,
  decode,
  encode: (_databaseType, value) => value,
};
