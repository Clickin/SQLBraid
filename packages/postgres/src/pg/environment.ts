import { createRenderedStatement, type DriverEnvironment, type TypePolicy } from "@sqlbraid/core";
import { typePolicyForProfile, type PgJsonProfile, type PgTemporalProfile } from "../type-policy.js";

export const pgExecutionCapabilities: DriverEnvironment["capabilities"] = Object.freeze({
  "session.pinned": { status: "guaranteed" },
  transaction: { status: "guaranteed" },
  "transaction.savepoint": { status: "guaranteed" },
  "transaction.read-only": { status: "guaranteed" },
  "transaction.isolation.read-uncommitted": {
    status: "guarded",
    conditionCode: "pg.read-uncommitted-maps-to-read-committed",
  },
  "transaction.isolation.read-committed": { status: "guaranteed" },
  "transaction.isolation.repeatable-read": { status: "guaranteed" },
  "transaction.isolation.serializable": { status: "guaranteed" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": {
    status: "guarded",
    conditionCode: "pg.physical-connection-destroy",
  },
  "statement.stream": { status: "guaranteed" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "guaranteed" },
  "routine.out": { status: "guaranteed" },
  "routine.inout": { status: "unsupported" },
  "routine.return-value": { status: "unsupported" },
  "routine.result-sets": { status: "guaranteed" },
  "routine.out-cursor": { status: "guaranteed" },
});

export function pgEnvironmentFor(
  profile: { readonly json: PgJsonProfile; readonly temporal: PgTemporalProfile },
  policy: TypePolicy = typePolicyForProfile(profile),
): DriverEnvironment {
  const profileId =
    profile.json === "text" && profile.temporal === "text"
      ? "pg-lossless-text"
      : profile.json === "native" && profile.temporal === "native"
        ? "pg-native"
        : profile.json === "native"
          ? "pg-json-native-temporal-text"
          : "pg-json-text-temporal-native";
  return Object.freeze<DriverEnvironment>({
    database: { product: "postgres" },
    driver: { id: "pg", profile: profileId },
    typePolicy: { id: policy.id, hash: policy.hash },
    capabilities: {
      ...pgExecutionCapabilities,
      "sql.native-transparency": { status: "guaranteed" },
      "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
      "numeric.exact-decimal": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
      "numeric.approximate-float": {
        status: "guarded",
        canonical: "number",
        rawRepresentations: ["number"],
        conditionCode: "pg.extra-float-digits",
      },
      "data.json-lossless-text": {
        status: profile.json === "text" ? "guaranteed" : "unsupported",
        canonical: "string",
        rawRepresentations: ["string"],
        ...(profile.json === "text" ? {} : { conditionCode: "pg.json-parser-profile" }),
      },
      "data.json-parsed": {
        status: profile.json === "native" ? "guarded" : "unsupported",
        rawRepresentations: ["unknown"],
        conditionCode: "pg.json-parser-profile",
      },
      "data.temporal-lossless": {
        status: profile.temporal === "text" ? "guaranteed" : "unsupported",
        canonical: "string",
        rawRepresentations: ["string"],
        ...(profile.temporal === "text" ? {} : { conditionCode: "pg.temporal-parser-profile" }),
      },
      "data.temporal-native": {
        status: profile.temporal === "native" ? "guarded" : "unsupported",
        rawRepresentations: ["Date", "string", "unknown"],
        conditionCode: "pg.temporal-parser-profile",
      },
    },
    probe: {
      statement: createRenderedStatement({
        segments: [
          "SELECT current_setting('server_version') AS server_version, current_setting('extra_float_digits') AS extra_float_digits, current_setting('TimeZone') AS timezone",
        ],
        parameters: [],
        resultKind: "rows",
        dialectId: "postgres",
      }),
      read: (rows) => {
        const row = rows[0];
        if (!row || typeof row !== "object" || Array.isArray(row)) return {};
        const record = row as Record<string, unknown>;
        const version = typeof record.server_version === "string" ? record.server_version : undefined;
        const extraFloatDigits =
          typeof record.extra_float_digits === "string" ? Number(record.extra_float_digits) : undefined;
        const approximateFloat =
          extraFloatDigits !== undefined && extraFloatDigits > 0
            ? { status: "guaranteed" as const, canonical: "number" as const, rawRepresentations: ["number"] as const }
            : {
                status: "guarded" as const,
                canonical: "number" as const,
                rawRepresentations: ["number"] as const,
                conditionCode: "pg.extra-float-digits",
              };
        return {
          ...(version === undefined ? {} : { version }),
          capabilities: { "numeric.approximate-float": approximateFloat },
        };
      },
    },
  });
}
