import { createSqlTag } from "../../template/src/index.js";
import type { Dialect, SqlTag } from "../../core/src/index.js";

export const dialect: Dialect = {
  id: "postgres",
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
};

export const sql: SqlTag = createSqlTag({ dialect });
export { typePolicy } from "./type-policy.js";
export { createSqlTag } from "../../template/src/index.js";
