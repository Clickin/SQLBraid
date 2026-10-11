import { ResultExactnessError } from "@sqlbraid/core";
import { arrayOids, exactNumericOids, jsonOids, temporalOids } from "../common/oids.js";
import type { PostgresJsLike } from "./types.js";

const textOids: readonly number[] = [...exactNumericOids, ...jsonOids, ...temporalOids, ...arrayOids];

function identity(value: string): string {
  return value;
}

function binary32(value: string): number {
  return Math.fround(Number(value));
}

interface PostgresJsTextType {
  to: number;
  from: number[];
  parse: (value: string) => unknown;
  serialize: (value: unknown) => string;
}

function textParameter(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function jsonParameter(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function temporalParameter(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Options for `postgres(url, options)` that give the lossless text representation.
 * Spread the result into the options of your postgres.js client.
 *
 * `fetch_types` is off, so array types stay text. A cold `sql.reserve()` can hang in postgres.js when
 * `fetch_types` is off, so the provider opens one connection with a plain query before it reserves.
 */
export function postgresJsOptions(): { fetch_types: false; types: Record<string, PostgresJsTextType> } {
  return {
    fetch_types: false,
    types: {
      sqlbraid_exact: {
        to: 1700,
        from: [...exactNumericOids, ...arrayOids],
        parse: identity,
        serialize: textParameter,
      },
      sqlbraid_json: { to: 114, from: [...jsonOids], parse: identity, serialize: jsonParameter },
      sqlbraid_temporal: { to: 1184, from: [...temporalOids], parse: identity, serialize: temporalParameter },
      sqlbraid_float4: { to: 700, from: [700], parse: binary32, serialize: textParameter },
    },
  };
}

/** Reject a postgres.js client whose parsers or type fetching differ from `postgresJsOptions()`. */
export function assertPostgresJsLossless(sql: PostgresJsLike): void {
  const options = sql?.options;
  if (!options || typeof sql.reserve !== "function" || typeof sql.unsafe !== "function") {
    throw new TypeError("SQLBraid postgres.js adapter requires a postgres.js sql instance.");
  }
  if (options.fetch_types !== false) {
    throw new ResultExactnessError(
      "postgres.js must set fetch_types to false for the lossless text profile. Spread postgresJsOptions() into the client options.",
    );
  }
  for (const oid of textOids) {
    const parse = options.parsers[oid];
    if (typeof parse !== "function" || parse("\u0000sample") !== "\u0000sample") {
      throw new ResultExactnessError(
        `postgres.js parser for type OID ${oid} is not the lossless text parser. Spread postgresJsOptions() into the client options.`,
      );
    }
  }
}
