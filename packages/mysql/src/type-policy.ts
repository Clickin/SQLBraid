import {
  decodeExactDecimal,
  normalizeExactInteger,
  ResultExactnessError,
  type TypePolicy,
  type TypeMapping,
} from "@sqlbraid/core";

export type Mysql2JsonProfile = "text" | "native";
export type Mysql2TemporalProfile = "text" | "native";

/** The result-shaping mysql2 options that SQLBraid needs to identify a profile. */
export interface Mysql2ProfileOptions {
  readonly supportBigNumbers?: boolean;
  readonly bigNumberStrings?: boolean;
  readonly decimalNumbers?: boolean;
  readonly rowsAsArray?: boolean;
  readonly jsonStrings?: boolean;
  readonly dateStrings?: boolean;
  readonly typeCast?: "default" | "custom";
}

export interface Mysql2ConnectionOptions {
  readonly supportBigNumbers: true;
  readonly bigNumberStrings: true;
  readonly decimalNumbers: false;
  readonly rowsAsArray: false;
  readonly jsonStrings: boolean;
  readonly dateStrings: boolean;
}

export interface Mysql2RepresentationProfile {
  readonly id: string;
  readonly json: Mysql2JsonProfile;
  readonly temporal: Mysql2TemporalProfile;
  readonly typePolicy: TypePolicy;
  readonly connectionOptions?: Readonly<Mysql2ConnectionOptions>;
}

const exactNumericOptions = {
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: false,
  rowsAsArray: false,
} as const;

const integerTypes = ["TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "LONGLONG"] as const;
const exactIntegerMapping = (databaseType: string): TypeMapping => ({
  databaseType,
  inputType: databaseType === "BIGINT" || databaseType === "LONGLONG" ? "bigint | string" : "number | string",
  outputType: "string",
  nullable: true,
  numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
});
const exactDecimalMapping = (databaseType: string): TypeMapping => ({
  databaseType,
  inputType: "string",
  outputType: "string",
  nullable: true,
  numeric: { semantics: "exact-decimal", representation: "string", fidelity: "lossless" },
});

const commonMappings: readonly TypeMapping[] = Object.freeze([
  ...integerTypes.map(exactIntegerMapping),
  exactDecimalMapping("DECIMAL"),
  exactDecimalMapping("NEWDECIMAL"),
  {
    databaseType: "FLOAT",
    inputType: "number",
    outputType: "number",
    nullable: true,
    numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 32 },
  },
  {
    databaseType: "DOUBLE",
    inputType: "number",
    outputType: "number",
    nullable: true,
    numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 64 },
  },
  { databaseType: "VARCHAR", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "CHAR", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "TEXT", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "TINYTEXT", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "MEDIUMTEXT", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "LONGTEXT", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "BINARY", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "VARBINARY", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "BLOB", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "TINYBLOB", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "MEDIUMBLOB", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "LONGBLOB", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "TIME", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "YEAR", inputType: "number | string", outputType: "number", nullable: true },
  { databaseType: "BIT", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
  { databaseType: "ENUM", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "SET", inputType: "string", outputType: "string", nullable: true },
  { databaseType: "GEOMETRY", inputType: "Uint8Array", outputType: "Uint8Array", nullable: true },
]);

const profileId = (json: Mysql2JsonProfile, temporal: Mysql2TemporalProfile): string => {
  if (json === "text" && temporal === "text") return "mysql2-lossless-text";
  if (json === "native" && temporal === "native") return "mysql2-native";
  if (json === "text") return "mysql2-json-text";
  return "mysql2-date-text";
};

const profileHashes = {
  text: {
    text: "01b2f34104422f0d5e3715d4cb85905f28a52740abb9dcf547e002dc9cf4169b",
    native: "d48f7d69b942368c7bd14c7eed82a7e8ecf0840bacff644bf52b5fc190f0d8fc",
  },
  native: {
    text: "84c902429eefd3d596a6167449b4960bb8bcceca48a57ae9ac870c3dce00f2d8",
    native: "a0e47c8a69732bcd1779dfa76872182e8dd921d5f5dbd5f6c679e88cc1bd0c3c",
  },
} as const;

function freezePolicy(policy: TypePolicy): TypePolicy {
  return Object.freeze({
    ...policy,
    mappings: Object.freeze(
      policy.mappings.map((mapping) =>
        Object.freeze({
          ...mapping,
          ...(mapping.numeric === undefined ? {} : { numeric: Object.freeze({ ...mapping.numeric }) }),
        }),
      ),
    ),
  });
}

function createTypePolicy(json: Mysql2JsonProfile, temporal: Mysql2TemporalProfile): TypePolicy {
  const mappings = [
    ...commonMappings,
    {
      databaseType: "JSON",
      inputType: json === "text" ? "string" : "unknown",
      outputType: json === "text" ? "string" : "unknown",
      nullable: true,
    },
    ...(temporal === "native"
      ? [
          { databaseType: "DATE", inputType: "Date", outputType: "Date", nullable: true },
          { databaseType: "DATETIME", inputType: "Date", outputType: "Date", nullable: true },
          { databaseType: "TIMESTAMP", inputType: "Date", outputType: "Date", nullable: true },
        ]
      : [
          { databaseType: "DATE", inputType: "Date | string", outputType: "string", nullable: true },
          { databaseType: "DATETIME", inputType: "Date | string", outputType: "string", nullable: true },
          { databaseType: "TIMESTAMP", inputType: "Date | string", outputType: "string", nullable: true },
        ]),
  ];
  return freezePolicy({
    id: profileId(json, temporal),
    hash: profileHashes[json][temporal],
    mappings,
    decode(databaseType, value) {
      if (value === null || value === undefined) return value;
      const type = databaseType.trim().toUpperCase();
      if (integerTypes.includes(type as (typeof integerTypes)[number])) return normalizeExactInteger(value);
      if (type === "DECIMAL" || type === "NEWDECIMAL") return decodeExactDecimal(value);
      if (type === "JSON" && json === "text" && typeof value !== "string") {
        throw new ResultExactnessError("mysql2 JSON results must remain strings for the selected text profile.");
      }
      if (type === "TIME" && typeof value !== "string") {
        throw new ResultExactnessError("mysql2 TIME results must remain strings.");
      }
      if (
        (type === "DATE" || type === "DATETIME" || type === "TIMESTAMP") &&
        temporal === "text" &&
        typeof value !== "string"
      ) {
        throw new ResultExactnessError(`mysql2 ${type} results must remain strings for the selected text profile.`);
      }
      if (
        (type === "DATE" || type === "DATETIME" || type === "TIMESTAMP") &&
        temporal === "native" &&
        !(value instanceof Date)
      ) {
        throw new ResultExactnessError(`mysql2 ${type} results must be Date values for the selected native profile.`);
      }
      return value;
    },
    encode: (_databaseType, value) => value,
  });
}

const policies = Object.freeze({
  textText: createTypePolicy("text", "text"),
  nativeNative: createTypePolicy("native", "native"),
  textNative: createTypePolicy("text", "native"),
  nativeText: createTypePolicy("native", "text"),
});

const descriptor = (
  json: Mysql2JsonProfile,
  temporal: Mysql2TemporalProfile,
  connectionOptions?: Readonly<Mysql2ConnectionOptions>,
): Mysql2RepresentationProfile =>
  Object.freeze({
    id: profileId(json, temporal),
    json,
    temporal,
    typePolicy:
      policies[
        json === "text"
          ? temporal === "text"
            ? "textText"
            : "textNative"
          : temporal === "text"
            ? "nativeText"
            : "nativeNative"
      ],
    ...(connectionOptions === undefined ? {} : { connectionOptions }),
  });

export const MYSQL2_LOSSLESS_TEXT = descriptor(
  "text",
  "text",
  Object.freeze({ ...exactNumericOptions, jsonStrings: true, dateStrings: true }),
);
export const MYSQL2_NATIVE = descriptor(
  "native",
  "native",
  Object.freeze({ ...exactNumericOptions, jsonStrings: false, dateStrings: false }),
);
export const MYSQL2_JSON_TEXT = descriptor(
  "text",
  "native",
  Object.freeze({ ...exactNumericOptions, jsonStrings: true, dateStrings: false }),
);
export const MYSQL2_DATE_TEXT = descriptor(
  "native",
  "text",
  Object.freeze({ ...exactNumericOptions, jsonStrings: false, dateStrings: true }),
);

export const representationProfiles: readonly Mysql2RepresentationProfile[] = Object.freeze([
  MYSQL2_LOSSLESS_TEXT,
  MYSQL2_NATIVE,
  MYSQL2_JSON_TEXT,
  MYSQL2_DATE_TEXT,
]);

function descriptorFor(json: Mysql2JsonProfile, temporal: Mysql2TemporalProfile): Mysql2RepresentationProfile {
  return representationProfiles.find((profile) => profile.json === json && profile.temporal === temporal)!;
}

export function typePolicyForProfile(profile: {
  readonly json: Mysql2JsonProfile;
  readonly temporal: Mysql2TemporalProfile;
}): TypePolicy {
  if (profile.json !== "text" && profile.json !== "native")
    throw new TypeError("mysql2 profile json must be 'text' or 'native'.");
  if (profile.temporal !== "text" && profile.temporal !== "native")
    throw new TypeError("mysql2 profile temporal must be 'text' or 'native'.");
  return descriptorFor(profile.json, profile.temporal).typePolicy;
}

export const typePolicy = MYSQL2_LOSSLESS_TEXT.typePolicy;
