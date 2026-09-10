import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";

export const dialect: Dialect = {
  id: "mysql",
  placeholder: () => "?",
  quoteIdentifier: (identifier) => `\`${identifier.replaceAll("`", "``")}\``,
  lexicalProfile: { lineCommentPrefixes: ["--", "#"], supportsNestedBlockComments: false, supportsBacktickIdentifiers: true, backslashEscapes: true },
};

export const sql: SqlTag = createSqlTag({ dialect });
export { typePolicy } from "./type-policy.js";
export { createSqlTag } from "@sqlbraid/template";
export { createMysqlInspector } from "./inspector.js";
