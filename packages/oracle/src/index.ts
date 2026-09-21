import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";
import { oracleParameter, typePolicy } from "./type-policy.js";

/** Oracle identifier quoting and lexical profile, including q-quoted literals. */
export const dialect: Dialect = {
  id: "oracle",
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  lexicalProfile: {
    lineCommentPrefixes: ["--"],
    supportsNestedBlockComments: false,
    supportsDollarQuotes: false,
    supportsOracleQQuotes: true,
    supportsBacktickIdentifiers: false,
    supportsBracketIdentifiers: false,
    backslashEscapes: false,
  },
};

/** Default Oracle SQL tag; typed binds and routine OUT helpers are adapter-specific. */
export const sql: SqlTag = createSqlTag({ dialect });
export { oracleParameter, typePolicy };
export type { OracleBinaryInput, OracleNumberInput } from "./type-policy.js";
export { createSqlTag } from "@sqlbraid/template";
