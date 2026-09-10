import type { TypePolicy } from "@sqlbraid/core";

const mappings = [
  { databaseType: "int2", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "int4", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "int8", inputType: "bigint", outputType: "bigint", nullable: true },
  { databaseType: "numeric", inputType: "string | number", outputType: "string", nullable: true },
  { databaseType: "text", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "bool", inputType: "boolean", outputType: "boolean", nullable: true },
] as const;

function decode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (databaseType === "int8") {
    if (typeof value === "bigint") return value;
    if (typeof value === "string" && /^-?\d+$/u.test(value)) return BigInt(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    throw new TypeError("PostgreSQL int8 value is not an exact integer representation.");
  }
  if (databaseType === "numeric" && typeof value !== "string") return String(value);
  return value;
}

function encode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (databaseType === "int8" && typeof value === "bigint") return value.toString();
  return value;
}

export const typePolicy: TypePolicy = {
  id: "postgres-default",
  hash: "postgres-default-v2",
  mappings,
  decode,
  encode,
};
