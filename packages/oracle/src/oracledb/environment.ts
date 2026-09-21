import { createRenderedStatement, type DriverEnvironment, type TypePolicy } from "@sqlbraid/core";
import { typePolicy as defaultTypePolicy } from "../type-policy.js";

export const oracleEnvironment = Object.freeze<DriverEnvironment>({
  database: { product: "oracle" },
  driver: { id: "node-oracledb", profile: "oracle-thin" },
  typePolicy: { id: defaultTypePolicy.id, hash: defaultTypePolicy.hash },
  capabilities: {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": { status: "unsupported", canonical: "string", rawRepresentations: ["string"] },
    "numeric.exact-decimal": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "numeric.approximate-special": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "numeric.bind-exact": { status: "unsupported", conditionCode: "oracle.bind-nls-sensitive" },
    "data.json-parsed": {
      status: "guaranteed",
      rawRepresentations: ["object", "array", "string", "number", "boolean", "null"],
    },
    "data.json-lossless-text": {
      status: "unsupported",
      canonical: "string",
      rawRepresentations: ["string"],
      conditionCode: "oracle.json-serialize-required",
    },
    "data.oracle-object": {
      status: "unsupported",
      rawRepresentations: ["object"],
      conditionCode: "oracle.object-nested-numeric-unclassified",
    },
    "data.oracle-collection": {
      status: "unsupported",
      rawRepresentations: ["object", "array"],
      conditionCode: "oracle.collection-nested-numeric-unclassified",
    },
    "data.vector": {
      status: "unsupported",
      rawRepresentations: ["object", "array"],
      conditionCode: "oracle.vector-unclassified",
    },
    "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["Buffer"] },
    "data.uuid": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
    "data.temporal-native": {
      status: "guarded",
      rawRepresentations: ["Date"],
      conditionCode: "oracle.date-millisecond-precision",
    },
    "data.temporal-lossless": {
      status: "unsupported",
      canonical: "string",
      rawRepresentations: ["string"],
      conditionCode: "oracle.temporal-text-cast-required",
    },
    "metadata.command-safe": {
      status: "guarded",
      rawRepresentations: ["number"],
      conditionCode: "oracle.count-safe-integer",
    },
    "session.pinned": { status: "guaranteed" },
    transaction: { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": { status: "guaranteed" },
    "transaction.isolation.read-uncommitted": { status: "unsupported" },
    "transaction.isolation.read-committed": { status: "guaranteed" },
    "transaction.isolation.repeatable-read": { status: "unsupported" },
    "transaction.isolation.serializable": { status: "guaranteed" },
    "statement.prepare": { status: "guaranteed" },
    "statement.cancel": { status: "guarded", conditionCode: "oracle.connection-break" },
    "statement.stream": { status: "guaranteed" },
    "statement.bulk": { status: "guaranteed" },
    "routine.call": { status: "guaranteed" },
    "routine.out": { status: "guaranteed" },
    "routine.inout": { status: "guaranteed" },
    "routine.return-value": { status: "unsupported" },
    "routine.result-sets": { status: "guaranteed" },
    "routine.out-cursor": { status: "guaranteed" },
  },
  probe: {
    statement: createRenderedStatement({
      segments: ["SELECT banner AS version FROM v$version WHERE ROWNUM = 1"],
      parameters: [],
      resultKind: "rows",
      dialectId: "oracle",
    }),
    read: (rows) => {
      const row = rows[0];
      if (!row || typeof row !== "object" || Array.isArray(row)) return {};
      const version = (row as Record<string, unknown>).VERSION ?? (row as Record<string, unknown>).version;
      return typeof version === "string" ? { version } : {};
    },
  },
});

export function customOracleEnvironment(policy: TypePolicy, cancellationSupported: boolean): DriverEnvironment {
  return {
    ...oracleEnvironment,
    driver: { id: "node-oracledb", profile: "custom" },
    typePolicy: { id: policy.id, hash: policy.hash },
    capabilities: cancellationSupported
      ? { "statement.cancel": oracleEnvironment.capabilities["statement.cancel"]! }
      : {},
  };
}
