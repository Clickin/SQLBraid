import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";

export const dialect: Dialect = {
  id: "sqlite",
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  lexicalProfile: { lineCommentPrefixes: ["--", "#"], supportsNestedBlockComments: false, supportsBracketIdentifiers: true, backslashEscapes: false },
};

export const sql: SqlTag = createSqlTag({ dialect });
export { typePolicy } from "./type-policy.js";
export type { SqliteDatabaseOptions } from "./node-sqlite.js";
export type { SqliteWasmDatabaseLike, SqliteWasmDatabaseOptions, SqliteWasmExecutorOptions, SqliteWasmStatementLike } from "./wasm.js";
export type { D1DatabaseLike, D1DatabaseOptions, D1PreparedStatementLike, D1ResultLike } from "./d1.js";
export { createSqlTag } from "@sqlbraid/template";
