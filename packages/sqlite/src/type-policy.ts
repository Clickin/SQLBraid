import { normalizeExactInteger, type TypePolicy } from "@sqlbraid/core";

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

for (const mapping of mappings) {
  if ("numeric" in mapping) Object.freeze(mapping.numeric);
  Object.freeze(mapping);
}
Object.freeze(mappings);

export const typePolicy: TypePolicy = Object.freeze<TypePolicy>({
  id: "sqlite-default",
  hash: "2fa022b4d147e26bc070a1fa5c30e3d5d4b9ac9d1ab048993bdcf3f970c61563",
  mappings,
  decode: (databaseType, value) => {
    if (value === null || value === undefined) return value;
    if (databaseType.trim().toUpperCase() === "INTEGER") {
      return normalizeExactInteger(value);
    }
    return value;
  },
  encode: (_databaseType, value) => value,
});
