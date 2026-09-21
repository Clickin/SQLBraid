import { createRenderedStatement, type DriverEnvironment } from "@sqlbraid/core";
import { typePolicy as defaultTypePolicy } from "../type-policy.js";

export const tediousEnvironment = Object.freeze<DriverEnvironment>({
  database: { product: "mssql" },
  driver: { id: "tedious", profile: "mssql-tedious" },
  typePolicy: { id: defaultTypePolicy.id, hash: defaultTypePolicy.hash },
  capabilities: {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["number", "string"] },
    "numeric.exact-decimal": { status: "unsupported", canonical: "string", rawRepresentations: ["number"] },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "numeric.bind-exact": {
      status: "guarded",
      canonical: "string",
      rawRepresentations: ["string"],
      conditionCode: "mssql.character-cast-required",
    },
    "numeric.aggregate": {
      status: "unsupported",
      canonical: "string",
      rawRepresentations: ["number"],
      conditionCode: "mssql.exact-decimal-text-cast-required",
    },
    "metadata.command-safe": {
      status: "guarded",
      rawRepresentations: ["number"],
      conditionCode: "mssql.safe-count",
    },
    "data.json-lossless-text": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
    "data.json-parsed": { status: "unsupported" },
    "data.sql-variant": {
      status: "unsupported",
      rawRepresentations: ["driver-native"],
      conditionCode: "mssql.sql-variant-unclassified",
    },
    "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["Buffer"] },
    "data.uuid": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
    "data.temporal-lossless": { status: "unsupported", conditionCode: "mssql.temporal-text-cast-required" },
    "data.temporal-native": {
      status: "guarded",
      rawRepresentations: ["Date", "string"],
      conditionCode: "mssql.temporal-text-cast-required",
    },
    "session.pinned": { status: "guaranteed" },
    transaction: { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": { status: "unsupported" },
    "transaction.isolation.read-uncommitted": { status: "guaranteed" },
    "transaction.isolation.read-committed": { status: "guaranteed" },
    "transaction.isolation.repeatable-read": { status: "guaranteed" },
    "transaction.isolation.serializable": { status: "guaranteed" },
    "statement.prepare": { status: "guaranteed" },
    "statement.cancel": { status: "guaranteed" },
    "statement.stream": { status: "guaranteed" },
    "statement.bulk": { status: "guaranteed" },
    "routine.call": { status: "guaranteed" },
    "routine.out": { status: "guaranteed" },
    "routine.inout": { status: "guaranteed" },
    "routine.return-value": { status: "guaranteed" },
    "routine.result-sets": { status: "guaranteed" },
    "routine.out-cursor": { status: "unsupported" },
  },
  probe: {
    statement: createRenderedStatement({
      segments: [
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition",
      ],
      parameters: [],
      resultKind: "rows",
      dialectId: "mssql",
    }),
    read: (rows) => {
      const row = rows[0];
      if (!row || typeof row !== "object" || Array.isArray(row)) return {};
      const record = row as Record<string, unknown>;
      return {
        ...(typeof record.version === "string" ? { version: record.version } : {}),
        ...(typeof record.edition === "string" ? { edition: record.edition } : {}),
      };
    },
  },
});
