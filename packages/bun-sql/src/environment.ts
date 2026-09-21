import type { EnvironmentCapability } from "@sqlbraid/core";
import type { BunSqlDialect } from "./types.js";

export const PRODUCT: Record<BunSqlDialect, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlite: "sqlite",
};

function capability(
  status: EnvironmentCapability["status"],
  canonical?: EnvironmentCapability["canonical"],
  rawRepresentations?: readonly string[],
  conditionCode?: string,
): EnvironmentCapability {
  return Object.freeze({
    status,
    ...(canonical === undefined ? {} : { canonical }),
    ...(rawRepresentations === undefined ? {} : { rawRepresentations }),
    ...(conditionCode === undefined ? {} : { conditionCode }),
  });
}

export function capabilitiesFor(dialect: BunSqlDialect): Readonly<Record<string, EnvironmentCapability>> {
  const mysqlTransport = dialect === "mysql" || dialect === "mariadb";
  const jsonText = dialect === "sqlite" || dialect === "mariadb";
  const json = jsonText
    ? capability("unsupported", undefined, ["string"])
    : capability("guarded", undefined, ["object", "array"], "bun-sql.json-parser-profile");
  const result: Record<string, EnvironmentCapability> = {
    "sql.native-transparency": capability("guaranteed"),
    "sql.generated-structure": capability("guaranteed"),
    "result.rows":
      dialect === "mysql" || dialect === "mariadb"
        ? capability("guarded", undefined, undefined, "bun-sql.result-kind-metadata")
        : dialect === "sqlite"
          ? capability("guarded", undefined, undefined, "bun-sql.sqlite-result-parser")
          : capability("guaranteed"),
    "result.command":
      dialect === "mysql" || dialect === "mariadb"
        ? capability("guarded", undefined, undefined, "bun-sql.result-kind-metadata")
        : dialect === "sqlite"
          ? capability("guarded", undefined, undefined, "bun-sql.sqlite-result-parser")
          : capability("guaranteed"),
    "result.multiple-sets": capability("unsupported"),
    "result.standard-schema": capability("guaranteed"),
    "numeric.exact-integer": capability(
      "guarded",
      "string",
      ["number", "string", "bigint"],
      "bun-sql.integer-width-profile",
    ),
    "numeric.exact-decimal":
      dialect === "postgres"
        ? capability("guaranteed", "string", ["string"])
        : capability("unsupported", "string", mysqlTransport ? ["Uint8Array"] : ["number"]),
    "numeric.approximate-float": capability("guarded", "number", ["number"], "bun-sql.float-profile"),
    "numeric.approximate-special": mysqlTransport
      ? capability("unsupported", "number", ["null", "number"])
      : capability("guarded", "number", ["number"], "bun-sql.special-float-profile"),
    "numeric.bind-exact": capability(
      "guarded",
      "string",
      ["string", "number", "bigint"],
      "bun-sql.numeric-bind-profile",
    ),
    "numeric.command-metadata": capability("guarded", "number", ["number", "bigint"], "bun-sql.command-count-profile"),
    "data.json-parsed": json,
    "data.json-lossless-text": capability(
      jsonText ? "guaranteed" : "unsupported",
      jsonText ? "string" : undefined,
      jsonText ? ["string"] : undefined,
    ),
    "data.binary": capability(mysqlTransport ? "unsupported" : "guaranteed", "Uint8Array", ["Uint8Array"]),
    "data.temporal-native":
      dialect === "sqlite"
        ? capability("unsupported", undefined, ["string"])
        : capability("guarded", undefined, ["Date", "string"], "bun-sql.temporal-profile"),
    "data.temporal-lossless": capability(
      dialect === "sqlite" ? "guaranteed" : "unsupported",
      dialect === "sqlite" ? "string" : undefined,
      dialect === "sqlite" ? ["string"] : undefined,
    ),
    "data.timezone":
      dialect === "sqlite"
        ? capability("unsupported", undefined, ["string"])
        : capability("guarded", undefined, ["Date"], "bun-sql.timezone-profile"),
    "metadata.command-safe": capability("guarded", "number", ["number", "bigint"], "bun-sql.command-count-profile"),
    "dml.insert-returning": capability(
      dialect === "postgres" || dialect === "sqlite" || dialect === "mariadb" ? "guaranteed" : "unsupported",
    ),
    "dml.update-returning": capability(dialect === "postgres" || dialect === "sqlite" ? "guaranteed" : "unsupported"),
    "dml.delete-returning": capability(
      dialect === "postgres" || dialect === "sqlite" || dialect === "mariadb" ? "guaranteed" : "unsupported",
    ),
    "session.pinned": capability("guaranteed"),
    "statement.prepare": capability("guaranteed"),
    "statement.cancel": capability("unsupported", undefined, ["Query.cancel"]),
    "statement.stream": capability("unsupported"),
    "statement.bulk": capability("guaranteed", undefined, ["prepared-loop"]),
    "execution.bulk-fidelity": capability("guarded", undefined, ["prepared-loop"], "bun-sql.bulk-profile"),
    transaction: capability("guaranteed"),
    "transaction.savepoint": capability("guaranteed"),
    "transaction.read-only": capability(
      dialect === "postgres" ? "guarded" : "unsupported",
      undefined,
      undefined,
      mysqlTransport
        ? "bun-sql.mysql-read-only-cache"
        : dialect === "postgres"
          ? "bun-sql.transaction-options"
          : undefined,
    ),
    "transaction.isolation.read-uncommitted": capability(
      dialect === "sqlite" ? "unsupported" : "guarded",
      undefined,
      undefined,
      dialect === "sqlite" ? undefined : "bun-sql.transaction-options",
    ),
    "transaction.isolation.read-committed": capability(
      dialect === "sqlite" ? "unsupported" : "guarded",
      undefined,
      undefined,
      dialect === "sqlite" ? undefined : "bun-sql.transaction-options",
    ),
    "transaction.isolation.repeatable-read": capability(
      dialect === "sqlite" ? "unsupported" : "guarded",
      undefined,
      undefined,
      dialect === "sqlite" ? undefined : "bun-sql.transaction-options",
    ),
    "transaction.isolation.serializable":
      dialect === "sqlite"
        ? capability("guaranteed")
        : capability("guarded", undefined, undefined, "bun-sql.transaction-options"),
    "routine.call": capability("unsupported"),
    "routine.out": capability("unsupported"),
    "routine.inout": capability("unsupported"),
    "routine.result-sets": capability("unsupported"),
    "routine.out-cursor": capability("unsupported"),
    "routine.return-value": capability("unsupported"),
  };
  return Object.freeze(result);
}
