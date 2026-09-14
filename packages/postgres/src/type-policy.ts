import {
  decodeExactDecimal,
  decodeExactInteger,
  type TypePolicy,
} from "@sqlbraid/core";

const mappings = [
  { databaseType: "int2", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "int4", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "int8", inputType: "bigint", outputType: "bigint", nullable: true, numericFidelity: "exact-integer" as const },
  { databaseType: "numeric", inputType: "string | number", outputType: "string", nullable: true, numericFidelity: "exact-decimal" as const },
  { databaseType: "decimal", inputType: "string | number", outputType: "string", nullable: true, numericFidelity: "exact-decimal" as const },
  { databaseType: "float4", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "float8", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "real", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "double precision", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "text", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "bool", inputType: "boolean", outputType: "boolean", nullable: true },
  { databaseType: "json", inputType: "unknown", outputType: "unknown", nullable: true },
  { databaseType: "jsonb", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

function decode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = databaseType.trim().toLowerCase();
  if (type === "int8") return decodeExactInteger(value);
  if (type === "numeric" || type === "decimal") return decodeExactDecimal(value, { allowBigInt: true });
  return value;
}

function encode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (databaseType.trim().toLowerCase() === "int8" && typeof value === "bigint") return value.toString();
  return value;
}

export const typePolicy: TypePolicy = {
  id: "postgres-default",
  hash: "postgres-default-v3",
  mappings,
  decode,
  encode,
};
