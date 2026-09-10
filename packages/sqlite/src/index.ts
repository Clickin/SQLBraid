import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";

export const dialect: Dialect = {
  id: "sqlite",
  placeholder: () => "?",
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  lexicalProfile: { lineCommentPrefixes: ["--", "#"], supportsNestedBlockComments: false, supportsBracketIdentifiers: true, backslashEscapes: false },
};

export const sql: SqlTag = createSqlTag({ dialect });
export { typePolicy } from "./type-policy.js";
export { createSqlTag } from "@sqlbraid/template";
export { createSqliteInspector } from "./inspector.js";
