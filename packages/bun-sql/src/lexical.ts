import type { DialectLexicalProfile } from "@sqlbraid/core";
import type { BunSqlDialect } from "./types.js";

const MYSQL_LEXICAL_PROFILE: DialectLexicalProfile = {
  lineCommentPrefixes: ["--", "#"],
  doubleDashRequiresWhitespace: true,
  supportsNestedBlockComments: false,
  supportsDollarQuotes: false,
  supportsBacktickIdentifiers: true,
  backslashEscapes: true,
};

export const LEXICAL_PROFILES: Record<BunSqlDialect, DialectLexicalProfile> = {
  postgres: {
    lineCommentPrefixes: ["--"],
    supportsNestedBlockComments: true,
    supportsDollarQuotes: true,
    backslashEscapes: false,
  },
  mysql: MYSQL_LEXICAL_PROFILE,
  mariadb: MYSQL_LEXICAL_PROFILE,
  sqlite: {
    lineCommentPrefixes: ["--"],
    lineCommentTerminators: "\n",
    supportsNestedBlockComments: false,
    supportsDollarQuotes: false,
    supportsBacktickIdentifiers: true,
    supportsBracketIdentifiers: true,
    backslashEscapes: false,
  },
};

export function hasSqlKeyword(text: string, target: string, profile: DialectLexicalProfile): boolean {
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    let lineComment: string | undefined;
    for (const prefix of profile.lineCommentPrefixes) {
      if (!text.startsWith(prefix, index)) continue;
      const next = text[index + prefix.length];
      if (
        prefix === "--" &&
        profile.doubleDashRequiresWhitespace &&
        next !== undefined &&
        next.charCodeAt(0) > 0x20 &&
        next.charCodeAt(0) !== 0x7f &&
        !/\s/u.test(next)
      )
        continue;
      lineComment = prefix;
      break;
    }
    if (lineComment !== undefined) {
      index += lineComment.length;
      while (index < text.length && !(profile.lineCommentTerminators ?? "\r\n").includes(text[index]!)) index += 1;
      continue;
    }
    if (text.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < text.length && depth > 0) {
        if (profile.supportsNestedBlockComments && text.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (text.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      continue;
    }
    if (character === "$" && profile.supportsDollarQuotes) {
      const match = text.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u)?.[0];
      if (match !== undefined) {
        const end = text.indexOf(match, index + match.length);
        index = end < 0 ? text.length : end + match.length;
        continue;
      }
    }
    if (
      character === "'" ||
      character === '"' ||
      (character === "`" && profile.supportsBacktickIdentifiers) ||
      (character === "[" && profile.supportsBracketIdentifiers)
    ) {
      const quote = character === "[" ? "]" : character;
      index += 1;
      while (index < text.length) {
        if (text[index] === quote) {
          if (text[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        if (text[index] === "\\" && profile.backslashEscapes && quote !== "]" && index + 1 < text.length) index += 2;
        else index += 1;
      }
      continue;
    }
    if (/[A-Za-z0-9_$\u0080-\uffff]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_$\u0080-\uffff]/u.test(text[index]!)) index += 1;
      if (text.slice(start, index).toUpperCase() === target) return true;
      continue;
    }
    index += 1;
  }
  return false;
}
