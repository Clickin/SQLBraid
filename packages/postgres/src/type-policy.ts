import { normalizeExactInteger, ResultExactnessError, type TypeMapping, type TypePolicy } from "@sqlbraid/core";

export type PgJsonProfile = "text" | "native";
export type PgTemporalProfile = "text" | "native";

export interface PgRepresentationProfileOptions {
  readonly json?: PgJsonProfile;
  readonly temporal?: PgTemporalProfile;
}

export interface PgRepresentationProfile {
  readonly id: string;
  readonly json: PgJsonProfile;
  readonly temporal: PgTemporalProfile;
  readonly typePolicy: TypePolicy;
}

type MappingSpec = Omit<TypeMapping, "outputType" | "inputType"> & {
  readonly textInputType: string;
  readonly textOutputType: string;
  readonly nativeInputType?: string;
  readonly nativeOutputType?: string;
};

const exactNumericMappings: readonly MappingSpec[] = [
  {
    databaseType: "int2",
    textInputType: "number | string",
    textOutputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "smallint",
    textInputType: "number | string",
    textOutputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "int4",
    textInputType: "number | string",
    textOutputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "integer",
    textInputType: "number | string",
    textOutputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "int8",
    textInputType: "bigint | string",
    textOutputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "bigint",
    textInputType: "bigint | string",
    textOutputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "oid",
    textInputType: "number | string",
    textOutputType: "string",
    nullable: true,
    numeric: { semantics: "exact-integer", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "numeric",
    textInputType: "string",
    textOutputType: "string",
    nullable: true,
    numeric: { semantics: "exact-decimal", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "decimal",
    textInputType: "string",
    textOutputType: "string",
    nullable: true,
    numeric: { semantics: "exact-decimal", representation: "string", fidelity: "lossless" },
  },
  {
    databaseType: "float4",
    textInputType: "number",
    textOutputType: "number",
    nullable: true,
    numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 32 },
  },
  {
    databaseType: "real",
    textInputType: "number",
    textOutputType: "number",
    nullable: true,
    numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 32 },
  },
  {
    databaseType: "float8",
    textInputType: "number",
    textOutputType: "number",
    nullable: true,
    numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 64 },
  },
  {
    databaseType: "double precision",
    textInputType: "number",
    textOutputType: "number",
    nullable: true,
    numeric: { semantics: "approximate-binary", representation: "number", fidelity: "lossless", binaryPrecision: 64 },
  },
  {
    databaseType: "money",
    textInputType: "string",
    textOutputType: "unknown",
    nullable: true,
    numeric: { semantics: "exact-decimal", representation: "string", fidelity: "unsupported" },
  },
];

const commonMappings: readonly MappingSpec[] = [
  { databaseType: "text", textInputType: "string", textOutputType: "string", nullable: true },
  { databaseType: "varchar", textInputType: "string", textOutputType: "string", nullable: true },
  { databaseType: "character varying", textInputType: "string", textOutputType: "string", nullable: true },
  { databaseType: "bpchar", textInputType: "string", textOutputType: "string", nullable: true },
  { databaseType: "char", textInputType: "string", textOutputType: "string", nullable: true },
  { databaseType: "character", textInputType: "string", textOutputType: "string", nullable: true },
  { databaseType: "name", textInputType: "string", textOutputType: "string", nullable: true },
  { databaseType: "xml", textInputType: "string", textOutputType: "string", nullable: true },
  { databaseType: "bool", textInputType: "boolean", textOutputType: "boolean", nullable: true },
  { databaseType: "boolean", textInputType: "boolean", textOutputType: "boolean", nullable: true },
  { databaseType: "bytea", textInputType: "Uint8Array", textOutputType: "Uint8Array", nullable: true },
  { databaseType: "uuid", textInputType: "string", textOutputType: "string", nullable: true },
];

const jsonMappings: readonly MappingSpec[] = [
  {
    databaseType: "json",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "unknown",
    nativeOutputType: "unknown",
    nullable: true,
  },
  {
    databaseType: "jsonb",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "unknown",
    nativeOutputType: "unknown",
    nullable: true,
  },
];

const temporalMappings: readonly MappingSpec[] = [
  {
    databaseType: "date",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "Date",
    nativeOutputType: "Date",
    nullable: true,
  },
  {
    databaseType: "time",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "string",
    nativeOutputType: "string",
    nullable: true,
  },
  {
    databaseType: "time with time zone",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "string",
    nativeOutputType: "string",
    nullable: true,
  },
  {
    databaseType: "timetz",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "string",
    nativeOutputType: "string",
    nullable: true,
  },
  {
    databaseType: "timestamp",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "Date",
    nativeOutputType: "Date",
    nullable: true,
  },
  {
    databaseType: "timestamp without time zone",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "Date",
    nativeOutputType: "Date",
    nullable: true,
  },
  {
    databaseType: "timestamp with time zone",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "Date",
    nativeOutputType: "Date",
    nullable: true,
  },
  {
    databaseType: "timestamptz",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "Date",
    nativeOutputType: "Date",
    nullable: true,
  },
  {
    databaseType: "interval",
    textInputType: "string",
    textOutputType: "string",
    nativeInputType: "unknown",
    nativeOutputType: "unknown",
    nullable: true,
  },
];

// pg's built-in array parser recursively applies scalar parsers. The text
// profile deliberately treats these as one opaque, lossless carrier.
const arrayNames = [
  "_bool",
  "_bytea",
  "_char",
  "_name",
  "_int2",
  "_int4",
  "_int8",
  "_oid",
  "_text",
  "_varchar",
  "_bpchar",
  "_float4",
  "_float8",
  "_numeric",
  "_money",
  "_time",
  "_timetz",
  "_timestamp",
  "_timestamptz",
  "_interval",
  "_date",
  "_uuid",
  "_json",
  "_jsonb",
  "_xml",
] as const;
const arrayMappings: readonly MappingSpec[] = arrayNames.map((databaseType) => ({
  databaseType,
  textInputType: "string",
  textOutputType: "string",
  nativeInputType: "unknown",
  nativeOutputType: "unknown",
  nullable: true,
}));
const arrayAliases: readonly MappingSpec[] = arrayNames.map((databaseType) => ({
  databaseType: `${databaseType.slice(1)}[]`,
  textInputType: "string",
  textOutputType: "string",
  nativeInputType: "unknown",
  nativeOutputType: "unknown",
  nullable: true,
}));

const jsonTypeNames: Readonly<Record<string, true>> = Object.freeze({ json: true, jsonb: true });
const temporalTypeNames: Readonly<Record<string, true>> = Object.freeze({
  date: true,
  time: true,
  "time with time zone": true,
  timetz: true,
  timestamp: true,
  "timestamp without time zone": true,
  "timestamp with time zone": true,
  timestamptz: true,
  interval: true,
});

// Only known mapping names enter this lookup; arbitrary type names never grow a cache.
const canonicalTypeNames: Readonly<Record<string, true>> = Object.fromEntries(
  [
    ...exactNumericMappings,
    ...commonMappings,
    ...jsonMappings,
    ...temporalMappings,
    ...arrayMappings,
    ...arrayAliases,
  ].map((mapping) => [mapping.databaseType, true] as const),
);

function canonical(databaseType: string): string {
  if (Object.hasOwn(canonicalTypeNames, databaseType)) return databaseType;
  return databaseType
    .trim()
    .toLowerCase()
    .replace(/^pg_catalog\./u, "");
}

function makeMappings(profile: PgRepresentationProfileOptions): readonly TypeMapping[] {
  const json = profile.json === "native" ? "native" : "text";
  const temporal = profile.temporal === "native" ? "native" : "text";
  return Object.freeze(
    [
      ...exactNumericMappings,
      ...commonMappings,
      ...jsonMappings,
      ...temporalMappings,
      ...arrayMappings,
      ...arrayAliases,
    ].map((mapping) =>
      Object.freeze({
        databaseType: mapping.databaseType,
        inputType:
          mapping.nativeInputType &&
          ((json === "native" && Object.hasOwn(jsonTypeNames, mapping.databaseType)) ||
            (temporal === "native" && Object.hasOwn(temporalTypeNames, mapping.databaseType)) ||
            ((json === "native" || temporal === "native") &&
              (mapping.databaseType.startsWith("_") || mapping.databaseType.endsWith("[]"))))
            ? mapping.nativeInputType
            : mapping.textInputType,
        outputType:
          mapping.nativeOutputType &&
          ((json === "native" && Object.hasOwn(jsonTypeNames, mapping.databaseType)) ||
            (temporal === "native" && Object.hasOwn(temporalTypeNames, mapping.databaseType)) ||
            ((json === "native" || temporal === "native") &&
              (mapping.databaseType.startsWith("_") || mapping.databaseType.endsWith("[]"))))
            ? mapping.nativeOutputType
            : mapping.textOutputType,
        nullable: mapping.nullable,
        ...(mapping.numeric === undefined ? {} : { numeric: Object.freeze({ ...mapping.numeric }) }),
      }),
    ),
  );
}

const decodeKind = {
  none: 0,
  integer: 1,
  decimal: 2,
  money: 3,
  json: 4,
  container: 5,
  temporalText: 6,
  temporalDate: 7,
} as const;

const decodeKindByType: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, number>,
    Object.fromEntries([
      ...["int2", "smallint", "int4", "integer", "int8", "bigint", "oid"].map((name) => [name, decodeKind.integer]),
      ["numeric", decodeKind.decimal],
      ["decimal", decodeKind.decimal],
      ["money", decodeKind.money],
      ["json", decodeKind.json],
      ["jsonb", decodeKind.json],
      ...["time", "timetz", "time with time zone", "interval"].map((name) => [name, decodeKind.temporalText]),
      ...["date", "timestamp", "timestamp without time zone", "timestamp with time zone", "timestamptz"].map((name) => [
        name,
        decodeKind.temporalDate,
      ]),
    ]),
  ),
);

function decodeKindOf(type: string): number {
  const kind = decodeKindByType[type];
  if (kind !== undefined) return kind;
  return type.startsWith("_") || type.endsWith("[]") ? decodeKind.container : decodeKind.none;
}

type CellDecoder = (value: unknown) => unknown;

const identityDecoder: CellDecoder = (value) => value;
const integerDecoder: CellDecoder = (value) =>
  value === null || value === undefined ? value : normalizeExactInteger(value);
const decimalDecoder: CellDecoder = (value) => {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new ResultExactnessError("PostgreSQL exact decimal transport must remain text.");
  }
  return value;
};
const moneyDecoder: CellDecoder = (value) => {
  if (value === null || value === undefined) return value;
  throw new ResultExactnessError(
    "PostgreSQL money is locale-formatted; use an explicit user-authored numeric cast for exact text.",
  );
};
const policyResolvers = new WeakMap<TypePolicy, (databaseType: string) => CellDecoder>();

/** Returns the decoder for one database type. The type name is classified once, not for each value. */
function makeCellResolver(profile: PgRepresentationProfileOptions): (databaseType: string) => CellDecoder {
  const json = profile.json === "native" ? "native" : "text";
  const temporal = profile.temporal === "native" ? "native" : "text";
  const jsonDecoder: CellDecoder =
    json === "text"
      ? (value) => {
          if (value !== null && value !== undefined && typeof value !== "string") {
            throw new ResultExactnessError("PostgreSQL lossless JSON profile requires text-format results.");
          }
          return value;
        }
      : identityDecoder;
  const containerDecoder: CellDecoder =
    json === "text" && temporal === "text"
      ? (value) => {
          if (value !== null && value !== undefined && typeof value !== "string") {
            throw new ResultExactnessError("PostgreSQL lossless container profile requires text-format results.");
          }
          return value;
        }
      : identityDecoder;
  const temporalTextDecoder: CellDecoder =
    temporal === "text"
      ? (value) => {
          if (value !== null && value !== undefined && typeof value !== "string") {
            throw new ResultExactnessError("PostgreSQL lossless temporal profile requires text-format results.");
          }
          return value;
        }
      : identityDecoder;
  const temporalDateDecoder: CellDecoder =
    temporal === "text"
      ? (value) => {
          if (value !== null && value !== undefined && typeof value !== "string") {
            throw new ResultExactnessError("PostgreSQL lossless temporal profile requires text-format results.");
          }
          return value;
        }
      : (value) => {
          if (value !== null && value !== undefined && !(value instanceof Date)) {
            throw new ResultExactnessError("PostgreSQL native temporal profile expected a Date result.");
          }
          return value;
        };
  return (databaseType) => {
    switch (decodeKindOf(canonical(databaseType))) {
      case decodeKind.integer:
        return integerDecoder;
      case decodeKind.decimal:
        return decimalDecoder;
      case decodeKind.money:
        return moneyDecoder;
      case decodeKind.json:
        return jsonDecoder;
      case decodeKind.container:
        return containerDecoder;
      case decodeKind.temporalText:
        return temporalTextDecoder;
      case decodeKind.temporalDate:
        return temporalDateDecoder;
      default:
        return identityDecoder;
    }
  };
}

/**
 * The decoder for one result column of a first-party policy, resolved once per column.
 * A policy that this module did not create returns undefined, and its caller keeps using `policy.decode`.
 */
export function resolveCellDecoder(policy: TypePolicy, databaseType: string): CellDecoder | undefined {
  return policyResolvers.get(policy)?.(databaseType);
}

function makeEncoder(): TypePolicy["encode"] {
  return (databaseType, value) => {
    if (value === null || value === undefined) return value;
    const type = canonical(databaseType);
    if (
      ["int2", "smallint", "int4", "integer", "int8", "bigint", "oid"].includes(type) &&
      (typeof value === "bigint" || typeof value === "string")
    ) {
      return normalizeExactInteger(value);
    }
    return value;
  };
}

const cache = new Map<string, TypePolicy>();

function profileKey(profile: PgRepresentationProfileOptions): string {
  return `${profile.json === "native" ? "native" : "text"}/${profile.temporal === "native" ? "native" : "text"}`;
}

export function typePolicyForProfile(profile: PgRepresentationProfileOptions = {}): TypePolicy {
  if (profile.json !== undefined && profile.json !== "text" && profile.json !== "native") {
    throw new RangeError(`Unsupported PostgreSQL JSON representation profile: ${String(profile.json)}`);
  }
  if (profile.temporal !== undefined && profile.temporal !== "text" && profile.temporal !== "native") {
    throw new RangeError(`Unsupported PostgreSQL temporal representation profile: ${String(profile.temporal)}`);
  }
  const key = profileKey(profile);
  const existing = cache.get(key);
  if (existing) return existing;
  const isDefault = key === "text/text";
  const isNative = key === "native/native";
  const resolve = makeCellResolver(profile);
  const policy = Object.freeze<TypePolicy>({
    id: isDefault
      ? "postgres-lossless-text"
      : isNative
        ? "postgres-native"
        : `postgres-json-${profile.json === "native" ? "native" : "text"}-temporal-${profile.temporal === "native" ? "native" : "text"}`,
    hash: (
      {
        "text/text": "ed7a23c7308cd1a479df9e40a86503b304a003391def7ff10a82eaa2d3444560",
        "native/native": "5fa897b30c2b3d6a91127df6bbfdeb090356595542616e828ae3bbe302cfdb8e",
        "native/text": "5019c418c92a7b8062b2910c945f87f0340cf2bcead966df7602605d0a2a66f1",
        "text/native": "d0b807fc59ee744ceae6f491876cd264da188f79180ed66b8f3f31feff5ce61f",
      } as Record<string, string>
    )[key]!,
    mappings: makeMappings(profile),
    decode: (databaseType, value) => resolve(databaseType)(value),
    encode: makeEncoder(),
  });
  policyResolvers.set(policy, resolve);
  cache.set(key, policy);
  return policy;
}

export const typePolicy: TypePolicy = typePolicyForProfile({ json: "text", temporal: "text" });

export const representationProfiles: readonly PgRepresentationProfile[] = Object.freeze([
  Object.freeze({ id: "pg-lossless-text", json: "text" as const, temporal: "text" as const, typePolicy }),
  Object.freeze({
    id: "pg-native",
    json: "native" as const,
    temporal: "native" as const,
    typePolicy: typePolicyForProfile({ json: "native", temporal: "native" }),
  }),
  Object.freeze({
    id: "pg-json-native-temporal-text",
    json: "native" as const,
    temporal: "text" as const,
    typePolicy: typePolicyForProfile({ json: "native", temporal: "text" }),
  }),
  Object.freeze({
    id: "pg-json-text-temporal-native",
    json: "text" as const,
    temporal: "native" as const,
    typePolicy: typePolicyForProfile({ json: "text", temporal: "native" }),
  }),
]);
