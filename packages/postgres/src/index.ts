import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";

export const dialect: Dialect = {
  id: "postgres",
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  lexicalProfile: { lineCommentPrefixes: ["--"], supportsNestedBlockComments: true, supportsDollarQuotes: true, backslashEscapes: false },
};

export const sql: SqlTag = createSqlTag({ dialect });
export { typePolicy } from "./type-policy.js";
export { createSqlTag } from "@sqlbraid/template";
