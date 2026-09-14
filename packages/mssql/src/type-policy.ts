import {
  normalizeExactInteger,
  ResultExactnessError,
  type ParameterTypeHint,
  type TypePolicy,
} from "@sqlbraid/core";

const mappings = [
  {
    databaseType: "tinyint",
    inputType: "number",
    outputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "smallint",
    inputType: "number",
    outputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "int",
    inputType: "number",
    outputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "bigint",
    inputType: "bigint | string",
    outputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "decimal",
    inputType: "string",
    outputType: "unknown",
    nullable: true,
    numeric: { semantics: "exact-decimal", representation: "string", fidelity: "unsupported" },
  },
  {
    databaseType: "numeric",
    inputType: "string",
    outputType: "unknown",
    nullable: true,
    numeric: { semantics: "exact-decimal", representation: "string", fidelity: "unsupported" },
  },
  {
    databaseType: "money",
    inputType: "string",
    outputType: "unknown",
    nullable: true,
    numeric: { semantics: "exact-decimal", representation: "string", fidelity: "unsupported" },
  },
  {
    databaseType: "smallmoney",
    inputType: "string",
    outputType: "unknown",
    nullable: true,
    numeric: { semantics: "exact-decimal", representation: "string", fidelity: "unsupported" },
  },
  {
    databaseType: "real",
    inputType: "number",
    outputType: "number",
    nullable: true,
    numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 32 },
  },
  {
    databaseType: "float",
    inputType: "number",
    outputType: "number",
    nullable: true,
    numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 64 },
  },
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
  if (type === "tinyint" || type === "smallint" || type === "int" || type === "bigint") {
    return normalizeExactInteger(value);
  }
  if (type === "decimal" || type === "numeric" || type === "money" || type === "smallmoney") {
    throw new ResultExactnessError(
      `SQL Server ${databaseType} results are exposed by Tedious as JavaScript numbers; use an explicit CONVERT(varchar(...), ...) or CAST(... AS varchar(...)) for exact text.`,
    );
  }
  if (type === "real" || type === "float") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ResultExactnessError(`SQL Server ${databaseType} results must be finite JavaScript numbers.`);
    }
  }
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
  hash: "mssql-default-v3",
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
  tinyint: (): Hint<number | null> => hint<number | null>("tinyint"),
  smallint: (): Hint<number | null> => hint<number | null>("smallint"),
  int: (): Hint<number | null> => hint<number | null>("int"),
  bigint: (): Hint<bigint | string | null> => hint<bigint | string | null>("bigint"),
  decimal: (precision: number, scale: number): Hint<string | null> => hint("decimal", decimalValues(precision, scale)),
  numeric: (precision: number, scale: number): Hint<string | null> => hint("numeric", decimalValues(precision, scale)),
  money: (): Hint<string | null> => hint("money"),
  smallmoney: (): Hint<string | null> => hint("smallmoney"),
  real: (): Hint<number | null> => hint<number | null>("real"),
  float: (): Hint<number | null> => hint<number | null>("float"),
  nvarchar: (length: number | "max"): Hint<string | null> => hint("nvarchar", { length: lengthValue(length, 4000) }),
  varchar: (length: number | "max"): Hint<string | null> => hint("varchar", { length: lengthValue(length, 8000) }),
  varbinary: (length: number | "max"): Hint<Uint8Array | null> => hint("varbinary", { length: lengthValue(length, 8000) }),
  bit: (): Hint<boolean | null> => hint<boolean | null>("bit"),
  uniqueidentifier: (): Hint<string | null> => hint<string | null>("uniqueidentifier"),
  date: (): Hint<Date | null> => hint<Date | null>("date"),
  datetime2: (scale?: number): Hint<Date | null> => hint<Date | null>("datetime2", temporalScale(scale)),
  datetimeoffset: (scale?: number): Hint<Date | null> => hint<Date | null>("datetimeoffset", temporalScale(scale)),
});
