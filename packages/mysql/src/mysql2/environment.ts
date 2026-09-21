import { createRenderedStatement, type DriverEnvironment, type TypePolicy } from "@sqlbraid/core";
import { typePolicyForProfile } from "../type-policy.js";
import type {
  Mysql2ConnectionLike,
  Mysql2JsonProfile,
  Mysql2ProfileOptions,
  Mysql2RepresentationProfile,
  Mysql2TemporalProfile,
} from "./types.js";

export function isRepresentationProfile(
  value: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined,
): value is Mysql2RepresentationProfile {
  return Boolean(value && "json" in value && "temporal" in value && "typePolicy" in value);
}

function suppliedProfileOptions(
  supplied: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined,
): Mysql2ProfileOptions | undefined {
  return isRepresentationProfile(supplied) ? supplied.connectionOptions : supplied;
}

function mysql2Profile(
  connection: Mysql2ConnectionLike,
  supplied: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined,
): Mysql2ProfileOptions {
  const candidate = connection as unknown as {
    readonly config?: unknown;
    readonly connection?: { readonly config?: unknown };
  };
  const suppliedOptions = suppliedProfileOptions(supplied);
  const sources = [candidate.config, candidate.connection?.config];
  const candidates = sources.filter((value): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value)),
  );
  const detected =
    candidates.find((value) =>
      [
        "supportBigNumbers",
        "bigNumberStrings",
        "decimalNumbers",
        "rowsAsArray",
        "jsonStrings",
        "dateStrings",
        "typeCast",
      ].some((key) => key in value),
    ) ?? candidates[0];
  if (!detected) return suppliedOptions ?? {};
  const value = (key: string): boolean | undefined =>
    typeof detected[key] === "boolean" ? (detected[key] as boolean) : undefined;
  return {
    ...suppliedOptions,
    supportBigNumbers: value("supportBigNumbers") ?? suppliedOptions?.supportBigNumbers,
    bigNumberStrings: value("bigNumberStrings") ?? suppliedOptions?.bigNumberStrings,
    decimalNumbers: value("decimalNumbers") ?? suppliedOptions?.decimalNumbers,
    rowsAsArray: value("rowsAsArray") ?? suppliedOptions?.rowsAsArray,
    jsonStrings: value("jsonStrings") ?? suppliedOptions?.jsonStrings,
    dateStrings: value("dateStrings") ?? suppliedOptions?.dateStrings,
    typeCast:
      typeof detected.typeCast === "function"
        ? "custom"
        : detected.typeCast === false
          ? "custom"
          : detected.typeCast === true
            ? "default"
            : suppliedOptions?.typeCast,
  };
}

export function mysql2RepresentationProfile(
  connection: Mysql2ConnectionLike,
  supplied: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined,
): Mysql2RepresentationProfile {
  const profile = mysql2Profile(connection, supplied);
  const json: Mysql2JsonProfile =
    profile.jsonStrings === undefined
      ? isRepresentationProfile(supplied)
        ? supplied.json
        : "text"
      : profile.jsonStrings
        ? "text"
        : "native";
  const temporal: Mysql2TemporalProfile =
    profile.dateStrings === undefined
      ? isRepresentationProfile(supplied)
        ? supplied.temporal
        : "text"
      : profile.dateStrings
        ? "text"
        : "native";
  return {
    id: `${json === "text" && temporal === "text" ? "mysql2-lossless-text" : json === "native" && temporal === "native" ? "mysql2-native" : json === "text" ? "mysql2-json-text" : "mysql2-date-text"}`,
    json,
    temporal,
    typePolicy: typePolicyForProfile({ json, temporal }),
  };
}

export function mysql2Environment(
  connection: Mysql2ConnectionLike,
  supplied: Mysql2ProfileOptions | Mysql2RepresentationProfile | undefined,
  policy: TypePolicy,
): DriverEnvironment {
  const profile = mysql2Profile(connection, undefined);
  const representationProfile = mysql2RepresentationProfile(connection, supplied);
  const policyMatchesProfile = policy === representationProfile.typePolicy;
  const exactNumeric =
    profile.supportBigNumbers === true &&
    profile.bigNumberStrings === true &&
    profile.decimalNumbers === false &&
    (profile.rowsAsArray === false || profile.rowsAsArray === true) &&
    profile.typeCast === "default";
  const rowObjects = (profile.rowsAsArray === false || profile.rowsAsArray === true) && profile.typeCast === "default";
  const jsonText = profile.jsonStrings === true && rowObjects;
  const jsonNative = profile.jsonStrings === false && rowObjects;
  const temporalText = profile.dateStrings === true && rowObjects;
  const temporalNative = profile.dateStrings === false && rowObjects;
  const profileDimensionsKnown = profile.jsonStrings !== undefined && profile.dateStrings !== undefined;
  const profileName =
    exactNumeric && rowObjects && profileDimensionsKnown ? representationProfile.id : "mysql2-custom-profile";
  const capabilities: DriverEnvironment["capabilities"] = {
    "session.pinned": { status: "guaranteed" },
    transaction: { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": { status: "guaranteed" },
    "transaction.isolation.read-uncommitted": { status: "guaranteed" },
    "transaction.isolation.read-committed": { status: "guaranteed" },
    "transaction.isolation.repeatable-read": { status: "guaranteed" },
    "transaction.isolation.serializable": { status: "guaranteed" },
    "statement.prepare": { status: "guaranteed" },
    "statement.cancel": { status: "guarded", conditionCode: "mysql2.physical-connection-destroy" },
    "statement.stream": { status: "guaranteed" },
    "statement.bulk": { status: "guaranteed" },
    "routine.call": { status: "guaranteed" },
    "routine.out": { status: "unsupported" },
    "routine.inout": { status: "unsupported" },
    "routine.return-value": { status: "unsupported" },
    "routine.result-sets": { status: "guaranteed" },
    "routine.out-cursor": { status: "unsupported" },
    ...(policyMatchesProfile
      ? {
          "sql.native-transparency": { status: "guaranteed" as const },
          "numeric.exact-integer": {
            status: exactNumeric ? ("guaranteed" as const) : ("guarded" as const),
            canonical: "string" as const,
            rawRepresentations: ["number", "string"],
            ...(exactNumeric ? {} : { conditionCode: "mysql2.exact-numeric-profile" }),
          },
          "numeric.exact-decimal": {
            status: exactNumeric ? ("guaranteed" as const) : ("guarded" as const),
            canonical: "string" as const,
            rawRepresentations: ["string"],
            ...(exactNumeric ? {} : { conditionCode: "mysql2.exact-numeric-profile" }),
          },
          "numeric.approximate-float": {
            status: rowObjects ? ("guaranteed" as const) : ("guarded" as const),
            canonical: "number" as const,
            rawRepresentations: ["number"],
          },
          "data.json-parsed": {
            status: jsonNative
              ? ("guaranteed" as const)
              : profile.jsonStrings === true
                ? ("unsupported" as const)
                : ("guarded" as const),
            rawRepresentations: ["object", "array", "string", "number", "boolean", "null"],
            ...(jsonNative ? {} : { conditionCode: "mysql2.json-strings" }),
          },
          "data.json-lossless-text": {
            status: jsonText
              ? ("guaranteed" as const)
              : profile.jsonStrings === false
                ? ("unsupported" as const)
                : ("guarded" as const),
            canonical: "string" as const,
            rawRepresentations: ["string"],
            ...(jsonText ? {} : { conditionCode: "mysql2.json-strings" }),
          },
          "data.temporal-lossless": {
            status: temporalText ? ("guaranteed" as const) : ("guarded" as const),
            canonical: "string" as const,
            rawRepresentations: ["string"],
            ...(temporalText ? {} : { conditionCode: "mysql2.date-strings" }),
          },
          "data.temporal-native": {
            status: temporalNative
              ? ("guaranteed" as const)
              : temporalText
                ? ("unsupported" as const)
                : ("guarded" as const),
            rawRepresentations: ["Date", "string"],
            ...(temporalText || profile.dateStrings === undefined ? { conditionCode: "mysql2.date-strings" } : {}),
          },
        }
      : {}),
  };
  return Object.freeze<DriverEnvironment>({
    database: { product: "mysql" },
    driver: { id: "mysql2", profile: policyMatchesProfile ? profileName : "custom-type-policy" },
    typePolicy: { id: policy.id, hash: policy.hash },
    capabilities,
    probe: {
      statement: createRenderedStatement({
        segments: ["SELECT VERSION() AS version"],
        parameters: [],
        resultKind: "rows",
        dialectId: "mysql",
      }),
      read: (rows) => {
        const row = rows[0];
        if (!row || typeof row !== "object" || Array.isArray(row)) return {};
        const version = (row as Record<string, unknown>).version;
        return typeof version === "string" ? { version } : {};
      },
    },
  });
}
