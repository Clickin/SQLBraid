import {
  normalizeExactInteger,
  type TypePolicy,
} from "@sqlbraid/core";

const mappings = [
  {
    databaseType: "INTEGER",
    inputType: "string | number | bigint",
    outputType: "string",
    nullable: true,
    numeric: {
      semantics: "exact-integer",
      representation: "string",
      fidelity: "lossless",
    },
  },
  {
    databaseType: "REAL",
    inputType: "number",
    outputType: "number",
    nullable: true,
    numeric: {
      semantics: "approximate-binary",
      representation: "number",
      fidelity: "lossless",
      binaryPrecision: 64,
    },
  },
  { databaseType: "TEXT", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "BLOB", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "ANY", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

export const typePolicy: TypePolicy = {
  id: "sqlite-default",
  hash: "sqlite-default-v3",
  mappings,
  decode: (databaseType, value) => {
    if (value === null || value === undefined) return value;
    if (databaseType.trim().toUpperCase() === "INTEGER") {
      return normalizeExactInteger(value);
    }
    return value;
  },
  encode: (_databaseType, value) => value,
};
