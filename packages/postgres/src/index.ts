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
/** PostgreSQL-only parameter hints for routine refcursor OUT channels. */
export const postgresParameter = Object.freeze({
  refcursor: (): ParameterTypeHint<null> => Object.freeze({ databaseType: "refcursor" }),
});
export { createSqlTag } from "@sqlbraid/template";
