import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, ParameterTypeHint, SqlTag } from "@sqlbraid/core";

export const dialect: Dialect = {
  id: "postgres",
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  lexicalProfile: { lineCommentPrefixes: ["--"], supportsNestedBlockComments: true, supportsDollarQuotes: true, backslashEscapes: false },
};

export const sql: SqlTag = createSqlTag({ dialect });
export { typePolicy } from "./type-policy.js";
export const postgresParameter = Object.freeze({
  refcursor: (): ParameterTypeHint<null> => Object.freeze({ databaseType: "refcursor" }),
});
export { createSqlTag } from "@sqlbraid/template";
