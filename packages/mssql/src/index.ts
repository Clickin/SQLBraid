import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";

/** SQL Server identifier quoting and lexical profile used by Tedious and custom adapters. */
export const dialect: Dialect = {
  id: "mssql",
  quoteIdentifier: (identifier) => `[${identifier.replaceAll("]", "]]")}]`,
  lexicalProfile: {
    lineCommentPrefixes: ["--"],
    supportsNestedBlockComments: true,
    supportsDollarQuotes: false,
    supportsBracketIdentifiers: true,
    backslashEscapes: false,
  },
};

/** Default SQL Server SQL tag; writes use native `OUTPUT` when the query requests returned rows. */
export const sql: SqlTag = createSqlTag({ dialect });
export { typePolicy } from "./type-policy.js";
export { mssqlParameter } from "./type-policy.js";
export { createSqlTag } from "@sqlbraid/template";
