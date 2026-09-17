import { normalizeExactInteger, ResultExactnessError, type TypePolicy } from "@sqlbraid/core";
import type { BunSqlDialect } from "./index.js";

export interface BunSqlRepresentationProfile {
  readonly id: string;
  readonly dialect: BunSqlDialect;
  readonly json: "text" | "native";
  readonly temporal: "text" | "native";
  readonly connectionOptions: Readonly<Record<string, unknown>>;
  readonly typePolicy: TypePolicy;
}

const PROFILE_HASH: Record<BunSqlDialect, string> = {
  postgres: "e25904b7284db8a2277358bca08473eb97f128bd513b75702af9b183f890bc87",
  mysql: "edee9e61c170a31cfeb0c196065a176af3e218f7b36a93ee952359325f68de28",
  mariadb: "23a4d18d16ad0ccc16c28e2a61037ad4c07d213e7b57c05b41ce61fced69c5c1",
  sqlite: "ff6fa6dee6180525bdcac0c046ac2c58631d05ed5402e9175ea26e79134299f0",
};

const integerTypes = new Set(["INTEGER", "BIGINT"]);
const decimalTypes = new Set(["DECIMAL"]);

function makePolicy(dialect: BunSqlDialect, json: "text" | "native", temporal: "text" | "native"): TypePolicy {
  const mappings: TypePolicy["mappings"] = Object.freeze([
    Object.freeze({
      databaseType: "INTEGER",
      inputType: "string | number | bigint",
      outputType: "string",
      nullable: true,
      numeric: Object.freeze({ semantics: "exact-integer", representation: "string", fidelity: "guarded" }),
    }),
    Object.freeze({
      databaseType: "BIGINT",
      inputType: "string | number | bigint",
      outputType: "string",
      nullable: true,
      numeric: Object.freeze({ semantics: "exact-integer", representation: "string", fidelity: "guarded" }),
    }),
    Object.freeze({
      databaseType: "DECIMAL",
      inputType: "string | number",
      outputType: "string",
      nullable: true,
      numeric: Object.freeze({
        semantics: "exact-decimal",
        representation: "string",
        fidelity: dialect === "postgres" ? "lossless" : "unsupported",
      }),
    }),
    Object.freeze({
      databaseType: "DOUBLE",
      inputType: "number",
      outputType: "number",
      nullable: true,
      numeric: Object.freeze({
        semantics: "approximate-binary",
        representation: "number",
        fidelity: "guarded",
        binaryPrecision: 64,
      }),
    }),
    Object.freeze({
      databaseType: "JSON",
      inputType: "unknown",
      outputType: json === "native" ? "unknown" : "string",
      nullable: true,
    }),
    Object.freeze({
      databaseType: "TEMPORAL",
      inputType: "Date | string",
      outputType: temporal === "native" ? "Date | string" : "string",
      nullable: true,
    }),
    Object.freeze({
      databaseType: "BINARY",
      inputType: "Uint8Array",
      outputType: dialect === "mysql" || dialect === "mariadb" ? "unknown" : "Uint8Array",
      nullable: true,
    }),
  ]);
  return Object.freeze<TypePolicy>({
    id: `bun-sql-${dialect}-1.3.14`,
    hash: PROFILE_HASH[dialect],
    mappings,
    decode: (databaseType, value) => {
      if (value === null || value === undefined) return value;
      const type = databaseType.trim().toUpperCase();
      if (integerTypes.has(type)) return normalizeExactInteger(value);
      if (decimalTypes.has(type) && typeof value !== "string") {
        throw new ResultExactnessError("Bun.SQL exact decimal transport must remain text.");
      }
      return value;
    },
    encode: (_databaseType, value) => value,
  });
}

function profile(
  dialect: BunSqlDialect,
  json: "text" | "native",
  temporal: "text" | "native",
): BunSqlRepresentationProfile {
  const typePolicy = makePolicy(dialect, json, temporal);
  return Object.freeze({
    id: typePolicy.id,
    dialect,
    json,
    temporal,
    connectionOptions: Object.freeze(dialect === "sqlite" ? { safeIntegers: true } : { bigint: true }),
    typePolicy,
  });
}

export const BUN_SQL_POSTGRES = profile("postgres", "native", "native");
export const BUN_SQL_MYSQL = profile("mysql", "native", "native");
export const BUN_SQL_MARIADB = profile("mariadb", "text", "native");
export const BUN_SQLITE = profile("sqlite", "text", "text");

export const representationProfiles: readonly BunSqlRepresentationProfile[] = Object.freeze([
  BUN_SQL_POSTGRES,
  BUN_SQL_MYSQL,
  BUN_SQL_MARIADB,
  BUN_SQLITE,
]);

export function representationProfileFor(dialect: BunSqlDialect): BunSqlRepresentationProfile {
  const selected = representationProfiles.find((entry) => entry.dialect === dialect);
  if (selected === undefined) throw new TypeError(`Unsupported Bun.SQL dialect: ${dialect}`);
  return selected;
}
