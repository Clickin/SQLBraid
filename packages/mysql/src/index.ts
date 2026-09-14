import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";

export const dialect: Dialect = {
  id: "mysql",
  quoteIdentifier: (identifier) => `\`${identifier.replaceAll("`", "``")}\``,
  lexicalProfile: { lineCommentPrefixes: ["--", "#"], supportsNestedBlockComments: false, supportsBacktickIdentifiers: true, backslashEscapes: true },
};

export const sql: SqlTag = createSqlTag({ dialect });
export {
  MYSQL2_DATE_TEXT,
  MYSQL2_JSON_TEXT,
  MYSQL2_LOSSLESS_TEXT,
  MYSQL2_NATIVE,
  representationProfiles,
  typePolicy,
  typePolicyForProfile,
} from "./type-policy.js";
export type {
  Mysql2ConnectionOptions,
  Mysql2JsonProfile,
  Mysql2ProfileOptions,
  Mysql2RepresentationProfile,
  Mysql2TemporalProfile,
} from "./type-policy.js";
export { createSqlTag } from "@sqlbraid/template";
