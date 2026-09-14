import {
  normalizeExactInteger,
  ResultExactnessError,
  type TypePolicy,
} from "@sqlbraid/core";

const mappings = [
  { databaseType: "int2", inputType: "number | string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "int4", inputType: "number | string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "int8", inputType: "bigint | string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "oid", inputType: "number | string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "numeric", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-decimal", representation: "string", fidelity: "lossless" } },
  { databaseType: "decimal", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-decimal", representation: "string", fidelity: "lossless" } },
  { databaseType: "float4", inputType: "number", outputType: "number", nullable: true, numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 32 } },
  { databaseType: "float8", inputType: "number", outputType: "number", nullable: true, numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 64 } },
  { databaseType: "real", inputType: "number", outputType: "number", nullable: true, numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 32 } },
  { databaseType: "double precision", inputType: "number", outputType: "number", nullable: true, numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 64 } },
  { databaseType: "money", inputType: "string", outputType: "unknown", nullable: true, numeric: { semantics: "exact-decimal", representation: "string", fidelity: "unsupported" } },
  { databaseType: "text", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "bool", inputType: "boolean", outputType: "boolean", nullable: true },
  { databaseType: "json", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "jsonb", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "date", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "time", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "time with time zone", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "timestamp", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "timestamp with time zone", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "interval", inputType: "string", outputType: "string", nullable: true },
] as const;

function decode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = databaseType.trim().toLowerCase();
  if (type === "int2" || type === "int4" || type === "int8" || type === "oid") return normalizeExactInteger(value);
  if (type === "numeric" || type === "decimal") {
    if (typeof value !== "string") throw new ResultExactnessError("PostgreSQL exact decimal transport must remain text.");
    return value;
  }
  if (type === "money") {
    throw new ResultExactnessError("PostgreSQL money is locale-formatted; use an explicit user-authored numeric cast for exact text.");
  }
  return value;
}

function encode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = databaseType.trim().toLowerCase();
  if ((type === "int2" || type === "int4" || type === "int8" || type === "oid") && (typeof value === "bigint" || typeof value === "string")) {
    return normalizeExactInteger(value);
  }
  return value;
}

export const typePolicy: TypePolicy = {
  id: "postgres-default",
  hash: "postgres-default-v3",
  mappings,
  decode,
  encode,
};
