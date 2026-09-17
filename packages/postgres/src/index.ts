import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, ParameterTypeHint, SqlTag } from "@sqlbraid/core";

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

export const sql: SqlTag = createSqlTag({ dialect });
export { representationProfiles, typePolicy, typePolicyForProfile } from "./type-policy.js";
export type {
  PgJsonProfile,
  PgRepresentationProfile,
  PgRepresentationProfileOptions,
  PgTemporalProfile,
} from "./type-policy.js";
export const postgresParameter = Object.freeze({
  refcursor: (): ParameterTypeHint<null> => Object.freeze({ databaseType: "refcursor" }),
});
export { createSqlTag } from "@sqlbraid/template";
