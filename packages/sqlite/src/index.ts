import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";

export const dialect: Dialect = {
  id: "sqlite",
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  lexicalProfile: { lineCommentPrefixes: ["--", "#"], supportsNestedBlockComments: false, supportsBracketIdentifiers: true, backslashEscapes: false },
};

export const sql: SqlTag = createSqlTag({ dialect });
export { typePolicy, typePolicyForIntegerMode } from "./type-policy.js";
export type { SqliteDatabaseOptions, SqliteExecutorOptions, SqliteIntegerMode } from "./node-sqlite.js";
export { createSqlTag } from "@sqlbraid/template";
