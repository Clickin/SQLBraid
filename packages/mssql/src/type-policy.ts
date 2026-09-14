import {
  decodeExactInteger,
  type ParameterTypeHint,
  type TypePolicy,
} from "@sqlbraid/core";

const mappings = [
  { databaseType: "int", inputType: "number", outputType: "number", nullable: true },
  { databaseType: "bigint", inputType: "bigint | string", outputType: "bigint", nullable: true, numericFidelity: "exact-integer" as const },
  { databaseType: "decimal", inputType: "string | number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "numeric", inputType: "string | number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "float", inputType: "number", outputType: "number", nullable: true, numericFidelity: "approximate-float" as const },
  { databaseType: "bit", inputType: "boolean", outputType: "boolean", nullable: true },
  { databaseType: "nvarchar", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "varchar", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "varbinary", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "uniqueidentifier", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "date", inputType: "Date", outputType: "Date", nullable: true },
  { databaseType: "datetime2", inputType: "Date", outputType: "Date", nullable: true },
  { databaseType: "datetimeoffset", inputType: "Date", outputType: "Date", nullable: true },
] as const;

function canonical(databaseType: string): string {
  return databaseType.trim().toLowerCase().replace(/\s+/gu, "");
}

function decode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = canonical(databaseType);
  if (type === "bigint") return decodeExactInteger(value);
  return value;
}

function encode(databaseType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = canonical(databaseType);
  if (type === "bigint" && typeof value === "bigint") return value.toString();
  return value;
}

export const typePolicy: TypePolicy = {
  id: "mssql-default",
  hash: "mssql-default-v2",
  mappings,
  decode,
  encode,
};

type Hint<Input = unknown> = Readonly<ParameterTypeHint<Input>>;

function hint<Input>(databaseType: string, extras: Omit<ParameterTypeHint<Input>, "databaseType" | "__input"> = {}): Hint<Input> {
  return Object.freeze({ databaseType, ...extras }) as Hint<Input>;
}

function lengthValue(length: number | "max", maximum: number): number | "max" {
  if (length === "max") return length;
  if (!Number.isSafeInteger(length) || length <= 0 || length > maximum) {
    throw new RangeError(`SQL Server parameter lengths must be positive integers up to ${maximum}, or "max".`);
  }
  return length;
}

function decimalValues(precision: number, scale: number): { precision: number; scale: number } {
  if (!Number.isSafeInteger(precision) || precision < 1 || precision > 38) {
    throw new RangeError("SQL Server decimal precision must be an integer from 1 through 38.");
  }
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > precision) {
    throw new RangeError("SQL Server decimal scale must be an integer from 0 through precision.");
  }
  return { precision, scale };
}

function temporalScale(scale: number | undefined): { scale?: number } {
  if (scale === undefined) return {};
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 7) {
    throw new RangeError("SQL Server DateTime2 and DateTimeOffset scale must be an integer from 0 through 7.");
  }
  return { scale };
}

export const mssqlParameter = Object.freeze({
  int: (): Hint<number | null> => hint<number | null>("int"),
  bigint: (): Hint<bigint | string | null> => hint<bigint | string | null>("bigint"),
  decimal: (precision: number, scale: number): Hint<string | number | null> => hint("decimal", decimalValues(precision, scale)),
  numeric: (precision: number, scale: number): Hint<string | number | null> => hint("numeric", decimalValues(precision, scale)),
  nvarchar: (length: number | "max"): Hint<string | null> => hint("nvarchar", { length: lengthValue(length, 4000) }),
  varchar: (length: number | "max"): Hint<string | null> => hint("varchar", { length: lengthValue(length, 8000) }),
  varbinary: (length: number | "max"): Hint<Uint8Array | null> => hint("varbinary", { length: lengthValue(length, 8000) }),
  bit: (): Hint<boolean | null> => hint<boolean | null>("bit"),
  uniqueidentifier: (): Hint<string | null> => hint<string | null>("uniqueidentifier"),
  date: (): Hint<Date | null> => hint<Date | null>("date"),
  datetime2: (scale?: number): Hint<Date | null> => hint<Date | null>("datetime2", temporalScale(scale)),
  datetimeoffset: (scale?: number): Hint<Date | null> => hint<Date | null>("datetimeoffset", temporalScale(scale)),
});
