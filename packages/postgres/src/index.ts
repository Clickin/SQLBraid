import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, ParameterTypeHint, SqlTag } from "@sqlbraid/core";

/** PostgreSQL identifier quoting and lexical profile used by the template parser. */
export const dialect: Dialect = {
  id: "postgres",
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  lexicalProfile: {
    lineCommentPrefixes: ["--"],
    supportsNestedBlockComments: true,
    supportsDollarQuotes: true,
    backslashEscapes: false,
  },
};

/** Default PostgreSQL SQL tag; interpolations are bound values unless structural helpers are used. */
export const sql: SqlTag = createSqlTag({ dialect });
export { representationProfiles, typePolicy, typePolicyForProfile } from "./type-policy.js";
export type {
  PgJsonProfile,
  PgRepresentationProfile,
  PgRepresentationProfileOptions,
  PgTemporalProfile,
} from "./type-policy.js";
function hint<Input>(databaseType: string): ParameterTypeHint<Input> {
  return Object.freeze({ databaseType });
}

/**
 * PostgreSQL parameter type hints for `sql.bind(value, hint)`.
 * A hint sets the type OID of one parameter. The postgres.js and PGlite adapters apply it; the `pg`, Neon and
 * neon-http adapters reject it. A hint carries no length, precision or scale, because the protocol sends only the OID.
 * Each factory accepts only a lossless input type. SQLBraid does not convert the value.
 * `json`, `jsonb`, enum, composite and extension types have no hint: use `CAST(${value} AS type)` in the SQL.
 */
export const postgresParameter = Object.freeze({
  /** A routine refcursor OUT channel. Routine calls only. */
  refcursor: (): ParameterTypeHint<null> => hint("refcursor"),
  boolean: (): ParameterTypeHint<boolean | null> => hint("boolean"),
  int2: (): ParameterTypeHint<number | null> => hint("int2"),
  int4: (): ParameterTypeHint<number | null> => hint("int4"),
  int8: (): ParameterTypeHint<bigint | string | null> => hint("int8"),
  float4: (): ParameterTypeHint<number | null> => hint("float4"),
  float8: (): ParameterTypeHint<number | null> => hint("float8"),
  /** Exact decimal text. A JavaScript number is not exact. */
  numeric: (): ParameterTypeHint<string | null> => hint("numeric"),
  text: (): ParameterTypeHint<string | null> => hint("text"),
  varchar: (): ParameterTypeHint<string | null> => hint("varchar"),
  uuid: (): ParameterTypeHint<string | null> => hint("uuid"),
  bytea: (): ParameterTypeHint<Uint8Array | null> => hint("bytea"),
  /** ISO date text, such as `2026-01-02`. */
  date: (): ParameterTypeHint<string | null> => hint("date"),
  /** Time text, such as `03:04:05`. */
  time: (): ParameterTypeHint<string | null> => hint("time"),
  timestamptz: (): ParameterTypeHint<Date | string | null> => hint("timestamptz"),
  /** PostgreSQL interval text, such as `1 day`. */
  interval: (): ParameterTypeHint<string | null> => hint("interval"),
});
export { createSqlTag } from "@sqlbraid/template";
