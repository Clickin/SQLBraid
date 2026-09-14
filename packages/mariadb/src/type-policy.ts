import {
  decodeExactDecimal,
  normalizeExactInteger,
  type TypePolicy,
} from "@sqlbraid/core";

const mappings = [
  { databaseType: "TINYINT", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "SMALLINT", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "MEDIUMINT", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "INT", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "BIGINT", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "LONGLONG", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" } },
  { databaseType: "DECIMAL", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-decimal", representation: "string", fidelity: "lossless" } },
  { databaseType: "NEWDECIMAL", inputType: "string", outputType: "string", nullable: true, numeric: { semantics: "exact-decimal", representation: "string", fidelity: "lossless" } },
  { databaseType: "FLOAT", inputType: "number", outputType: "number", nullable: true, numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 32 } },
  { databaseType: "DOUBLE", inputType: "number", outputType: "number", nullable: true, numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 64 } },
  { databaseType: "VARCHAR", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "TEXT", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "JSON", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

export const typePolicy: TypePolicy = {
  id: "mariadb-default",
  hash: "mariadb-default-v3",
  mappings,
  decode: (databaseType, value) => {
    if (value === null || value === undefined) return value;
    const type = databaseType.trim().toUpperCase();
    if (type === "TINYINT" || type === "SMALLINT" || type === "MEDIUMINT" || type === "INT" || type === "BIGINT" || type === "LONGLONG") {
      return normalizeExactInteger(value);
    }
    if (type === "DECIMAL" || type === "NEWDECIMAL") return decodeExactDecimal(value);
    return value;
  },
  encode: (_databaseType, value) => value,
};
