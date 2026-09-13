import type { ParameterTypeHint, TypePolicy } from "@sqlbraid/core";

export type OracleNumberInput = number | string | bigint;
export type OracleBinaryInput = Uint8Array;
type OracleNullable<Input> = Input | null;

const mappings = [
  { databaseType: "VARCHAR2", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "NVARCHAR2", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "NUMBER", inputType: "string | number | bigint", outputType: "string", nullable: true },
  { databaseType: "BINARY_FLOAT", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "BINARY_DOUBLE", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "DATE", inputType: "Date", outputType: "Date", nullable: true },
  { databaseType: "TIMESTAMP", inputType: "Date", outputType: "Date", nullable: true },
  { databaseType: "TIMESTAMP WITH TIME ZONE", inputType: "Date", outputType: "Date", nullable: true },
  { databaseType: "TIMESTAMP WITH LOCAL TIME ZONE", inputType: "Date", outputType: "Date", nullable: true },
  { databaseType: "RAW", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "BLOB", inputType: "unknown", outputType: "unknown", nullable: true },
  { databaseType: "CLOB", inputType: "unknown", outputType: "unknown", nullable: true },
  { databaseType: "NCLOB", inputType: "unknown", outputType: "unknown", nullable: true },
] as const;

function normalize(databaseType: string): string {
  return databaseType.trim().toUpperCase().replaceAll(/\s+/gu, " ");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function encode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = normalize(databaseType);
  if ((type === "VARCHAR2" || type === "NVARCHAR2") && typeof value !== "string") {
    throw new TypeError(`Oracle ${type} parameters require a string value.`);
  }
  if (type === "NUMBER" && typeof value !== "string" && typeof value !== "bigint" && !isFiniteNumber(value)) {
    throw new TypeError("Oracle NUMBER parameters require a finite number, bigint, or decimal string.");
  }
  if ((type === "BINARY_FLOAT" || type === "BINARY_DOUBLE") && !isFiniteNumber(value)) {
    throw new TypeError(`Oracle ${type} parameters require a finite number.`);
  }
  if ((type === "DATE" || type.startsWith("TIMESTAMP")) && !(value instanceof Date)) {
    throw new TypeError(`Oracle ${type} parameters require a Date value.`);
  }
  if (type === "RAW" && !(value instanceof Uint8Array)) {
    throw new TypeError("Oracle RAW parameters require a Uint8Array or Buffer value.");
  }
  return value;
}

function decode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = normalize(databaseType);
  // NUMBER is intentionally represented as text. JavaScript Number cannot preserve
  // Oracle NUMBER precision, and the adapter requests string fetching for columns.
  if (type === "NUMBER") {
    if (typeof value === "string") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    throw new TypeError("Oracle NUMBER result is not an exact numeric representation.");
  }
  return value;
}

export const typePolicy: TypePolicy = {
  id: "oracle-default",
  hash: "oracle-default-v1",
  mappings,
  decode,
  encode,
};

function hint<Input>(databaseType: string, options: Omit<ParameterTypeHint<Input>, "databaseType" | "__input"> = {}): ParameterTypeHint<Input> {
  if (options.length !== undefined && options.length !== "max" && (!Number.isInteger(options.length) || options.length <= 0)) {
    throw new RangeError("Oracle parameter length must be a positive integer or \"max\".");
  }
  if (options.precision !== undefined && (!Number.isInteger(options.precision) || options.precision < 1 || options.precision > 38)) {
    throw new RangeError("Oracle NUMBER precision must be an integer from 1 through 38.");
  }
  if (options.scale !== undefined && (!Number.isInteger(options.scale) || options.scale < -84 || options.scale > 127)) {
    throw new RangeError("Oracle NUMBER scale must be an integer from -84 through 127.");
  }
  return Object.freeze({ databaseType, ...options }) as ParameterTypeHint<Input>;
}

export const oracleParameter = Object.freeze({
  varchar2: (length?: number | "max"): ParameterTypeHint<OracleNullable<string>> => hint("VARCHAR2", length === undefined ? {} : { length }),
  nvarchar2: (length?: number | "max"): ParameterTypeHint<OracleNullable<string>> => hint("NVARCHAR2", length === undefined ? {} : { length }),
  number: (precision?: number, scale?: number): ParameterTypeHint<OracleNullable<OracleNumberInput>> => hint("NUMBER", { ...(precision === undefined ? {} : { precision }), ...(scale === undefined ? {} : { scale }) }),
  binaryFloat: (): ParameterTypeHint<OracleNullable<number>> => hint("BINARY_FLOAT"),
  binaryDouble: (): ParameterTypeHint<OracleNullable<number>> => hint("BINARY_DOUBLE"),
  date: (): ParameterTypeHint<OracleNullable<Date>> => hint("DATE"),
  timestamp: (): ParameterTypeHint<OracleNullable<Date>> => hint("TIMESTAMP"),
  timestampTz: (): ParameterTypeHint<OracleNullable<Date>> => hint("TIMESTAMP WITH TIME ZONE"),
  timestampLtz: (): ParameterTypeHint<OracleNullable<Date>> => hint("TIMESTAMP WITH LOCAL TIME ZONE"),
  raw: (length?: number | "max"): ParameterTypeHint<OracleNullable<OracleBinaryInput>> => hint("RAW", length === undefined ? {} : { length }),
  blob: (): ParameterTypeHint<OracleNullable<unknown>> => hint("BLOB"),
  clob: (): ParameterTypeHint<OracleNullable<unknown>> => hint("CLOB"),
  nclob: (): ParameterTypeHint<OracleNullable<unknown>> => hint("NCLOB"),
  varchar: (length?: number | "max"): ParameterTypeHint<OracleNullable<string>> => hint("VARCHAR2", length === undefined ? {} : { length }),
  timestampWithTimeZone: (): ParameterTypeHint<OracleNullable<Date>> => hint("TIMESTAMP WITH TIME ZONE"),
  timestampWithLocalTimeZone: (): ParameterTypeHint<OracleNullable<Date>> => hint("TIMESTAMP WITH LOCAL TIME ZONE"),
});
