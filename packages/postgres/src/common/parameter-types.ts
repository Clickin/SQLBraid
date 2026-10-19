import type { RenderedStatement } from "@sqlbraid/core";
import { UnsupportedFeatureError } from "@sqlbraid/core";

/**
 * The parameter types that an explicit hint can select. A hint sets one type OID in the Parse message.
 * The table is fixed on purpose: the adapter never reads the catalog, so enum, composite, extension, `json`
 * and `jsonb` parameters stay on `CAST(${value} AS type)` in the SQL.
 */
const parameterTypeOids: Readonly<Record<string, number>> = Object.freeze({
  bool: 16,
  boolean: 16,
  int2: 21,
  smallint: 21,
  int4: 23,
  int: 23,
  integer: 23,
  int8: 20,
  bigint: 20,
  float4: 700,
  real: 700,
  float8: 701,
  "double precision": 701,
  numeric: 1700,
  decimal: 1700,
  text: 25,
  varchar: 1043,
  "character varying": 1043,
  uuid: 2950,
  bytea: 17,
  date: 1082,
  time: 1083,
  "time without time zone": 1083,
  timestamptz: 1184,
  "timestamp with time zone": 1184,
  interval: 1186,
});

function unsupportedHint(message: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError("statement.bind-hint", "BRAID_BIND_HINT_UNSUPPORTED", message);
}

/**
 * Return the type OID of each parameter, with 0 for a parameter without a hint, or `undefined` if no parameter has a
 * hint. This function is pure: it validates every hint and never reads the database.
 */
export function postgresParameterTypeOids(rendered: RenderedStatement): readonly number[] | undefined {
  if (rendered.parameters.every((parameter) => parameter.hint === undefined)) return undefined;
  return rendered.parameters.map((parameter, index) => {
    const hint = parameter.hint;
    if (hint === undefined) return 0;
    const name = hint.databaseType.trim().toLowerCase().replaceAll(/\s+/gu, " ");
    if (name === "refcursor") {
      // A routine OUT refcursor is not a parameter type. The routine call itself fails later, as unsupported.
      if (rendered.resultKind === "call" && parameter.direction !== undefined && parameter.direction !== "in") return 0;
      throw unsupportedHint(`PostgreSQL parameter ${index + 1}: refcursor is only valid for a routine OUT parameter.`);
    }
    const oid = parameterTypeOids[name];
    if (oid === undefined) {
      throw unsupportedHint(
        `PostgreSQL parameter ${index + 1}: no parameter type hint for ${hint.databaseType}. Write CAST(value AS type) in the SQL instead.`,
      );
    }
    if (hint.length !== undefined || hint.precision !== undefined || hint.scale !== undefined) {
      throw unsupportedHint(
        `PostgreSQL parameter ${index + 1}: ${hint.databaseType} cannot carry length, precision or scale, because the protocol sends only the type OID.`,
      );
    }
    return oid;
  });
}
