import {
  decodeExactDecimal,
  normalizeExactInteger,
  ResultExactnessError,
  type TypeMapping,
  type TypePolicy,
} from "@sqlbraid/core";

export type MariaDbJsonProfile = "text" | "native";
export type MariaDbTemporalProfile = "text" | "native";

/** Declarative result-shaping options supported by MariaDB Connector/Node.js 3.5.4. */
export interface MariaDbProfileOptions {
  readonly bigIntAsNumber?: boolean;
  readonly decimalAsNumber?: boolean;
  readonly insertIdAsNumber?: boolean;
  readonly autoJsonMap?: boolean;
  readonly dateStrings?: boolean;
  readonly timezone?: string;
}

export interface MariaDbConnectionOptions {
  readonly bigIntAsNumber: false;
  readonly decimalAsNumber: false;
  readonly insertIdAsNumber: false;
  readonly autoJsonMap: boolean;
  readonly dateStrings: boolean;
  readonly timezone: "Z";
}

export interface MariaDbRepresentationProfile {
  readonly id: string;
  readonly json: MariaDbJsonProfile;
  readonly temporal: MariaDbTemporalProfile;
  readonly typePolicy: TypePolicy;
  readonly connectionOptions?: Readonly<MariaDbConnectionOptions>;
}

const integerTypes = ["TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "LONGLONG"] as const;
const exactIntegerMapping = (databaseType: string): TypeMapping => ({
  databaseType,
  inputType: "string",
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
  { databaseType: "FLOAT", inputType: "number", outputType: "number", nullable: true, numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 32 } },
  { databaseType: "DOUBLE", inputType: "number", outputType: "number", nullable: true, numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 64 } },
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

const profileId = (json: MariaDbJsonProfile, temporal: MariaDbTemporalProfile): string => {
  if (json === "text" && temporal === "text") return "mariadb-lossless-text";
  if (json === "native" && temporal === "native") return "mariadb-native";
  if (json === "text") return "mariadb-json-text";
  return "mariadb-date-text";
};

function freezePolicy(policy: TypePolicy): TypePolicy {
  return Object.freeze({
    ...policy,
    mappings: Object.freeze(policy.mappings.map((mapping) => Object.freeze({
      ...mapping,
      ...(mapping.numeric === undefined ? {} : { numeric: Object.freeze({ ...mapping.numeric }) }),
    }))),
  });
}

function createTypePolicy(json: MariaDbJsonProfile, temporal: MariaDbTemporalProfile): TypePolicy {
  const mappings = [
    ...commonMappings,
    { databaseType: "JSON", inputType: json === "text" ? "string" : "unknown", outputType: json === "text" ? "string" : "unknown", nullable: true },
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
    hash: {
      text: {
        text: "81a8838812f56c3140244ec2572354b58ea9b9eaf1e475e3e1a2d41a77137934",
        native: "893bc575754a4a525c5acc0a37fc060729024472e07335267db7579437bcb069",
      },
      native: {
        text: "2c1dad0aff904f15e32e33183db5424253b52e6098a57d9106e77e84942aaec9",
        native: "216e1b7720285a8dbf1cc0cafd3a889f4e2312cafa31c3015871e2708e2d01d7",
      },
    }[json][temporal],
    mappings,
    decode(databaseType, value) {
      if (value === null || value === undefined) return value;
      const type = databaseType.trim().toUpperCase();
      if (integerTypes.includes(type as (typeof integerTypes)[number])) return normalizeExactInteger(value);
      if (type === "DECIMAL" || type === "NEWDECIMAL") return decodeExactDecimal(value);
      if (type === "JSON" && json === "text" && typeof value !== "string") {
        throw new ResultExactnessError("MariaDB JSON results must remain strings for the selected text profile.");
      }
      if (type === "TIME" && typeof value !== "string") {
        throw new ResultExactnessError("MariaDB TIME results must remain strings.");
      }
      if ((type === "DATE" || type === "DATETIME" || type === "TIMESTAMP") && temporal === "text" && typeof value !== "string") {
        throw new ResultExactnessError(`MariaDB ${type} results must remain strings for the selected text profile.`);
      }
      if ((type === "DATE" || type === "DATETIME" || type === "TIMESTAMP") && temporal === "native" && !(value instanceof Date)) {
        throw new ResultExactnessError(`MariaDB ${type} results must be Date values for the selected native profile.`);
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
  json: MariaDbJsonProfile,
  temporal: MariaDbTemporalProfile,
  connectionOptions?: Readonly<MariaDbConnectionOptions>,
): MariaDbRepresentationProfile => Object.freeze({
  id: profileId(json, temporal),
  json,
  temporal,
  typePolicy: policies[json === "text" ? temporal === "text" ? "textText" : "textNative" : temporal === "text" ? "nativeText" : "nativeNative"],
  ...(connectionOptions === undefined ? {} : { connectionOptions }),
});

const exactNumericOptions = {
  bigIntAsNumber: false,
  decimalAsNumber: false,
  insertIdAsNumber: false,
  timezone: "Z",
} as const;

export const MARIADB_LOSSLESS_TEXT = descriptor("text", "text", Object.freeze({ ...exactNumericOptions, autoJsonMap: false, dateStrings: true }));
export const MARIADB_NATIVE = descriptor("native", "native", Object.freeze({ ...exactNumericOptions, autoJsonMap: true, dateStrings: false }));
export const MARIADB_JSON_TEXT = descriptor("text", "native", Object.freeze({ ...exactNumericOptions, autoJsonMap: false, dateStrings: false }));
export const MARIADB_DATE_TEXT = descriptor("native", "text", Object.freeze({ ...exactNumericOptions, autoJsonMap: true, dateStrings: true }));

export const representationProfiles: readonly MariaDbRepresentationProfile[] = Object.freeze([
  MARIADB_LOSSLESS_TEXT,
  MARIADB_NATIVE,
  MARIADB_JSON_TEXT,
  MARIADB_DATE_TEXT,
]);

function descriptorFor(json: MariaDbJsonProfile, temporal: MariaDbTemporalProfile): MariaDbRepresentationProfile {
  return representationProfiles.find((profile) => profile.json === json && profile.temporal === temporal)!;
}

export function typePolicyForProfile(profile: { readonly json: MariaDbJsonProfile; readonly temporal: MariaDbTemporalProfile }): TypePolicy {
  if (profile.json !== "text" && profile.json !== "native") throw new TypeError("MariaDB profile json must be 'text' or 'native'.");
  if (profile.temporal !== "text" && profile.temporal !== "native") throw new TypeError("MariaDB profile temporal must be 'text' or 'native'.");
  return descriptorFor(profile.json, profile.temporal).typePolicy;
}

export const typePolicy = MARIADB_LOSSLESS_TEXT.typePolicy;
