import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";

export const dialect: Dialect = {
  id: "mssql",
  placeholder: (index) => `@p${index}`,
  quoteIdentifier: (identifier) => `[${identifier.replaceAll("]", "]]")}]`,
  lexicalProfile: {
    lineCommentPrefixes: ["--"],
    supportsNestedBlockComments: true,
    supportsBracketIdentifiers: true,
    backslashEscapes: false,
  },
};

export const sql: SqlTag = createSqlTag({ dialect });
export { typePolicy } from "./type-policy.js";
export { mssqlParameter } from "./type-policy.js";
export { createSqlTag } from "@sqlbraid/template";
