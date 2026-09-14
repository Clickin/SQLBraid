import { createSqlTag } from "@sqlbraid/template";
import type { Dialect, SqlTag } from "@sqlbraid/core";

export const dialect: Dialect = {
  id: "mariadb",
  quoteIdentifier: (identifier) => `\`${identifier.replaceAll("`", "``")}\``,
  lexicalProfile: {
    lineCommentPrefixes: ["--", "#"],
    supportsNestedBlockComments: false,
    supportsBacktickIdentifiers: true,
    backslashEscapes: true,
  },
};

export const sql: SqlTag = createSqlTag({ dialect });
export {
  MARIADB_DATE_TEXT,
  MARIADB_JSON_TEXT,
  MARIADB_LOSSLESS_TEXT,
  MARIADB_NATIVE,
  representationProfiles,
  typePolicy,
  typePolicyForProfile,
} from "./type-policy.js";
export type {
  MariaDbConnectionOptions,
  MariaDbJsonProfile,
  MariaDbProfileOptions,
  MariaDbRepresentationProfile,
  MariaDbTemporalProfile,
} from "./type-policy.js";
export { createSqlTag } from "@sqlbraid/template";
