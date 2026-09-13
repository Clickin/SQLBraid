import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";
import { oracleParameter, typePolicy } from "./type-policy.js";

export const dialect: Dialect = {
  id: "oracle",
  placeholder: (index) => `:${index}`,
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

export const sql: SqlTag = createSqlTag({ dialect });
export { oracleParameter, typePolicy };
export type { OracleBinaryInput, OracleNumberInput } from "./type-policy.js";
export { createSqlTag } from "@sqlbraid/template";
