import { ResultExactnessError } from "@sqlbraid/core";
import { pgOidTypes } from "../pg/types.js";
import type { PgParserProfile, PgTypeOverrides } from "../pg/types.js";
import { arrayOids, exactNumericOids, jsonOids, temporalOids } from "./oids.js";

function textValue(value: unknown): unknown {
  if (typeof value === "string") return value;
  throw new ResultExactnessError("PostgreSQL lossless text profile requires text-format results.");
}

function binary64Value(value: unknown): number {
  return Number(textValue(value));
}

function binary32Value(value: unknown): number {
  return Math.fround(binary64Value(value));
}

/**
 * Build the type parser overrides that keep exact values as text.
 * `fallback` gives the driver parser for every type that the profile does not change.
 */
export function queryTypeOverrides(
  fallback: (oid: number, format?: string) => ((value: string) => unknown) | undefined,
  profile: Required<PgParserProfile>,
): PgTypeOverrides {
  const lossless = profile.json === "text" && profile.temporal === "text";
  return {
    getTypeParser(oid, format) {
      if (oid === 700) return binary32Value;
      if (oid === 701) return binary64Value;
      if (
        exactNumericOids.has(oid) ||
        (profile.json === "text" && jsonOids.has(oid)) ||
        (profile.temporal === "text" && temporalOids.has(oid)) ||
        (lossless && (arrayOids.has(oid) || pgOidTypes[oid] === undefined))
      ) {
        return textValue;
      }
      return fallback(oid, format) ?? ((value: unknown) => value);
    },
  };
}
