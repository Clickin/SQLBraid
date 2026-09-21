import { createRenderedStatement, type DriverEnvironment, type TypePolicy } from "@sqlbraid/core";
import { typePolicyForProfile } from "../type-policy.js";
import type { MariaDbProfileOptions, MariaDbRepresentationProfile } from "./types.js";

function isRepresentationProfile(
  value: MariaDbProfileOptions | MariaDbRepresentationProfile | undefined,
): value is MariaDbRepresentationProfile {
  return Boolean(value && "json" in value && "temporal" in value && "typePolicy" in value);
}

export function mariaDbProfile(
  value: MariaDbProfileOptions | MariaDbRepresentationProfile | undefined,
): MariaDbRepresentationProfile {
  const options = isRepresentationProfile(value) ? value.connectionOptions : value;
  const json = options?.autoJsonMap === true ? "native" : "text";
  const temporal = options?.dateStrings === false ? "native" : "text";
  return isRepresentationProfile(value)
    ? value
    : {
        id: `mariadb-${json === "text" && temporal === "text" ? "lossless-text" : json === "native" && temporal === "native" ? "native" : json === "text" ? "json-text" : "date-text"}`,
        json,
        temporal,
        typePolicy: typePolicyForProfile({ json, temporal }),
      };
}

export function mariaDbEnvironment(
  supplied: MariaDbProfileOptions | MariaDbRepresentationProfile | undefined,
  policy: TypePolicy,
): DriverEnvironment {
  const profile = mariaDbProfile(supplied);
  const policyMatchesProfile = policy === profile.typePolicy;
  return Object.freeze<DriverEnvironment>({
    database: { product: "mariadb" },
    driver: {
      id: "mariadb",
      profile: !policyMatchesProfile
        ? "custom-type-policy"
        : isRepresentationProfile(supplied)
          ? profile.id
          : "mariadb-custom-profile",
    },
    typePolicy: { id: policy.id, hash: policy.hash },
    capabilities: policyMatchesProfile
      ? {
          "sql.native-transparency": { status: "guaranteed" },
          "numeric.exact-integer": {
            status: "guarded",
            canonical: "string",
            rawRepresentations: ["number", "string", "bigint"],
            conditionCode: "mariadb.exact-numeric-profile",
          },
          "numeric.exact-decimal": {
            status: "guarded",
            canonical: "string",
            rawRepresentations: ["string"],
            conditionCode: "mariadb.exact-numeric-profile",
          },
          "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
          "data.json-lossless-text": {
            status: "guarded",
            canonical: "string",
            rawRepresentations: ["string"],
            conditionCode: "mariadb.auto-json-map-false",
          },
          "data.json-parsed": {
            status: "guarded",
            rawRepresentations: ["object", "array", "string", "number", "boolean", "null"],
            conditionCode: "mariadb.auto-json-map-true",
          },
          "data.temporal-lossless": {
            status: "guarded",
            canonical: "string",
            rawRepresentations: ["string"],
            conditionCode: "mariadb.date-strings-true",
          },
          "data.temporal-native": {
            status: "guarded",
            rawRepresentations: ["Date"],
            conditionCode: "mariadb.date-strings-false",
          },
          "metadata.command-safe": {
            status: "guarded",
            canonical: "number",
            rawRepresentations: ["number", "bigint", "string"],
            conditionCode: "mariadb.safe-command-count",
          },
          "session.pinned": { status: "guaranteed" },
          transaction: { status: "guaranteed" },
          "transaction.savepoint": { status: "guaranteed" },
          "transaction.read-only": { status: "guaranteed" },
          "transaction.isolation.read-uncommitted": { status: "guaranteed" },
          "transaction.isolation.read-committed": { status: "guaranteed" },
          "transaction.isolation.repeatable-read": { status: "guaranteed" },
          "transaction.isolation.serializable": { status: "guaranteed" },
          "statement.prepare": { status: "guaranteed" },
          "statement.cancel": { status: "guarded", conditionCode: "mariadb.connection-destroy" },
          "statement.stream": { status: "guaranteed" },
          "statement.bulk": { status: "guaranteed" },
          "routine.call": { status: "guaranteed" },
          "routine.out": { status: "unsupported" },
          "routine.inout": { status: "unsupported" },
          "routine.return-value": { status: "unsupported" },
          "routine.result-sets": { status: "guaranteed" },
          "routine.out-cursor": { status: "unsupported" },
        }
      : {},
    probe: {
      statement: createRenderedStatement({
        segments: ["SELECT VERSION() AS version"],
        parameters: [],
        resultKind: "rows",
        dialectId: "mariadb",
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
