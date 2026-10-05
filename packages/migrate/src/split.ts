import type { Dialect, DialectLexicalProfile } from "@sqlbraid/core";
import { MigrationError } from "./errors.js";

export interface SplitMigration {
  readonly statements: readonly string[];
  readonly transaction: boolean;
}

function invalid(message: string): never {
  throw new MigrationError("BRAID_MIGRATE_SOURCE", message);
}

const DIRECTIVE_TOKEN = "@braid-migrate";

function directives(
  source: string,
  profile: DialectLexicalProfile,
  mysql: boolean,
): { split: boolean; transaction: boolean; sql: boolean } {
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let split = true;
  let transaction = true;
  const unsupported = (text: string): never =>
    invalid(`Unsupported migration directive form: ${text.trim()}. Use "-- @braid-migrate <option>" on its own line.`);
  while (offset < source.length) {
    if (/\s/u.test(source[offset])) {
      offset += 1;
      continue;
    }
    const prefix = profile.lineCommentPrefixes.find(
      (candidate) =>
        source.startsWith(candidate, offset) &&
        !(
          candidate === "--" &&
          profile.doubleDashRequiresWhitespace &&
          offset + 2 < source.length &&
          source.charCodeAt(offset + 2) > 32
        ),
    );
    if (prefix !== undefined) {
      let end = offset + prefix.length;
      while (end < source.length && !(profile.lineCommentTerminators ?? "\r\n").includes(source[end])) end += 1;
      const raw = source.slice(offset + prefix.length, end);
      if (raw.includes(DIRECTIVE_TOKEN)) {
        if (prefix !== "--" || !/^[ \t]+@braid-migrate\b/u.test(raw)) unsupported(prefix + raw);
        const comment = raw.trim();
        if (comment === "@braid-migrate split=none") split = false;
        else if (comment === "@braid-migrate transaction=off") transaction = false;
        else invalid(`Unsupported migration directive: ${comment}`);
      }
      offset = end;
      continue;
    }
    if (source.startsWith("/*", offset) && !(mysql && /^\/\*M?!/u.test(source.slice(offset, offset + 4)))) {
      const begin = offset;
      let depth = 1;
      offset += 2;
      while (offset < source.length && depth > 0) {
        if (source.startsWith("*/", offset)) {
          depth -= 1;
          offset += 2;
        } else if (profile.supportsNestedBlockComments && source.startsWith("/*", offset)) {
          depth += 1;
          offset += 2;
        } else offset += 1;
      }
      if (depth > 0) invalid("Unterminated SQL block comment.");
      if (source.slice(begin, offset).includes(DIRECTIVE_TOKEN)) unsupported(source.slice(begin, offset));
      continue;
    }
    // MySQL reads "--@braid-migrate" as SQL, not as a comment.
    const line = /^[^\r\n]*/u.exec(source.slice(offset))![0];
    if (/^(?:--|#)\s*@braid-migrate\b/u.test(line)) unsupported(line);
    return { split, transaction, sql: true };
  }
  return { split, transaction, sql: false };
}

/** Split trusted SQL lexically, never rewrite the SQL inside a statement or batch. */
export function splitMigrationSql(source: string, dialect: Dialect): SplitMigration {
  const profile: DialectLexicalProfile = dialect.lexicalProfile ?? { lineCommentPrefixes: ["--"] };
  const options = directives(source, profile, dialect.id === "mysql" || dialect.id === "mariadb");
  if (!options.split) {
    if (!options.sql) return { statements: [], transaction: options.transaction };
    // node:sqlite and libSQL run only the first statement of a multi-statement string; pg cannot read its results.
    if ((dialect.id === "sqlite" || dialect.id === "postgres") && scan(source, dialect, profile).length > 1)
      invalid("split=none sends exactly one statement, but the file contains more than one.");
    return { statements: [source.trim()], transaction: options.transaction };
  }
  return { statements: scan(source, dialect, profile), transaction: options.transaction };
}

function scan(source: string, dialect: Dialect, profile: DialectLexicalProfile): readonly string[] {
  const mysql = dialect.id === "mysql" || dialect.id === "mariadb";
  const sqlite = dialect.id === "sqlite";
  const oracle = dialect.id === "oracle";
  const mssql = dialect.id === "mssql";
  const postgres = dialect.id === "postgres";
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let delimiter = ";";
  let significant = false;
  let anySql = false;
  let words: string[] = [];
  let trigger = false;
  let triggerBody = false;
  const triggerBlocks: string[] = [];
  let plsql = false;
  let routine = false;
  let atomicBegin = false;
  let atomicDepth = 0;
  let rule = false;
  let ruleDepth = 0;
  const emit = (end: number, next: number): void => {
    if (significant) statements.push(source.slice(start, end).trim());
    start = next;
    significant = false;
    words = [];
    trigger = false;
    triggerBody = false;
    triggerBlocks.length = 0;
    plsql = false;
    routine = false;
    atomicBegin = false;
    atomicDepth = 0;
    rule = false;
    ruleDepth = 0;
  };
  while (index < source.length) {
    // Client separator commands are meaningful only outside every quoted/comment token.
    if (index === 0 || source[index - 1] === "\n" || source[index - 1] === "\r") {
      let end = index;
      while (end < source.length && source[end] !== "\r" && source[end] !== "\n") end += 1;
      const line = source.slice(index, end).trim();
      let next = end;
      if (source[next] === "\r") next += 1;
      if (source[next] === "\n") next += 1;
      if (mysql && /^DELIMITER\b/iu.test(line)) {
        const match = /^DELIMITER\s+([!$%&*+./:;<=>?@^|~-]+)$/iu.exec(line);
        if (!match || /--|\/\*|\*\//u.test(match[1])) invalid("Unsupported MySQL DELIMITER variant.");
        if (significant) invalid("DELIMITER must follow a completed SQL statement.");
        delimiter = match[1];
        start = next;
        index = next;
        continue;
      }
      if (mssql && /^GO\b/iu.test(line)) {
        if (!/^GO(?:\s+--[^\r\n]*)?$/iu.test(line))
          invalid("Only standalone GO is supported; GO counts and other variants are not.");
        emit(index, next);
        index = next;
        continue;
      }
      if (oracle && line === "/") {
        if (!plsql) invalid("Oracle slash separators require a PL/SQL statement; SQL replay is not supported.");
        emit(index, next);
        index = next;
        continue;
      }
      if (oracle && plsql && /^\/\s/u.test(line)) invalid("Oracle PL/SQL requires / alone on its line.");
    }
    const character = source[index];
    if (/\s/u.test(character) || character === "\ufeff") {
      index += 1;
      continue;
    }
    const commentPrefix = profile.lineCommentPrefixes.find(
      (prefix) =>
        source.startsWith(prefix, index) &&
        !(
          prefix === "--" &&
          profile.doubleDashRequiresWhitespace &&
          index + 2 < source.length &&
          source.charCodeAt(index + 2) > 32
        ),
    );
    if (commentPrefix !== undefined) {
      const begin = index;
      index += commentPrefix.length;
      const terminators = profile.lineCommentTerminators ?? "\r\n";
      while (index < source.length && !terminators.includes(source[index])) index += 1;
      if (anySql && /^--\s*@braid-migrate\b/u.test(source.slice(begin, index))) {
        invalid("Migration directives must precede SQL statements.");
      }
      continue;
    }
    if (source.startsWith("/*", index)) {
      if (mysql && (source.startsWith("/*!", index) || source.startsWith("/*M!", index))) significant = true;
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else if (profile.supportsNestedBlockComments && source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else index += 1;
      }
      if (depth > 0) invalid("Unterminated SQL block comment.");
      continue;
    }
    if (
      !mssql &&
      source.startsWith(delimiter, index) &&
      !plsql &&
      triggerBlocks.length === 0 &&
      atomicDepth === 0 &&
      ruleDepth === 0
    ) {
      if (
        mysql &&
        delimiter === ";" &&
        /^CREATE (?:OR REPLACE )?(?:DEFINER\b.*?)?(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/u.test(words.join(" "))
      ) {
        invalid("MySQL routine bodies require DELIMITER or split=none.");
      }
      emit(index, index + delimiter.length);
      index += delimiter.length;
      continue;
    }
    significant = true;
    anySql = true;
    const afterBegin = atomicBegin;
    atomicBegin = false;
    const qOffset = profile.supportsOracleQQuotes
      ? /^[qQ]'/u.test(source.slice(index, index + 2))
        ? 1
        : /^[nN][qQ]'/u.test(source.slice(index, index + 3))
          ? 2
          : 0
      : 0;
    if (qOffset > 0) {
      const opener = source[index + qOffset + 1];
      if (!opener || /\s/u.test(opener)) invalid("Invalid Oracle q-quote delimiter.");
      const closer = ({ "[": "]", "(": ")", "{": "}", "<": ">" } as Record<string, string>)[opener] ?? opener;
      const end = source.indexOf(`${closer}'`, index + qOffset + 2);
      if (end < 0) invalid("Unterminated Oracle q-quoted string.");
      index = end + 2;
      continue;
    }
    if (
      profile.supportsDollarQuotes &&
      character === "$" &&
      (index === 0 || !/[\p{L}\p{N}_$]/u.test(source[index - 1]))
    ) {
      const match = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(source.slice(index));
      if (match) {
        const end = source.indexOf(match[0], index + match[0].length);
        if (end < 0) invalid("Unterminated PostgreSQL dollar-quoted string.");
        index = end + match[0].length;
        continue;
      }
    }
    if (
      character === "'" ||
      character === '"' ||
      (character === "`" && profile.supportsBacktickIdentifiers) ||
      (character === "[" && profile.supportsBracketIdentifiers)
    ) {
      const close = character === "[" ? "]" : character;
      const escaped =
        profile.backslashEscapes ||
        (dialect.id === "postgres" &&
          character === "'" &&
          /[eE]/u.test(source[index - 1] ?? "") &&
          (index < 2 || !/[\w$]/u.test(source[index - 2])));
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (escaped && source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === close) {
          index += 1;
          if (source[index] === close) {
            index += 1;
            continue;
          }
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) invalid("Unterminated SQL quoted token.");
      continue;
    }
    if (/[\p{L}_]/u.test(character)) {
      const begin = index++;
      while (index < source.length && /[\p{L}\p{N}_$]/u.test(source[index])) {
        if (mysql && delimiter !== ";" && source.startsWith(delimiter, index)) break;
        index += 1;
      }
      const word = source.slice(begin, index).toUpperCase();
      let prefix = "";
      if (words.length < 24) {
        words.push(word);
        if (sqlite || oracle || (postgres && !routine)) prefix = words.join(" ");
      }
      if (sqlite && !trigger && /^CREATE (?:TEMP(?:ORARY)? )?TRIGGER\b/u.test(prefix)) trigger = true;
      if (postgres && !routine && /^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE)\b/u.test(prefix)) routine = true;
      if (postgres && !rule && /^CREATE (?:OR REPLACE )?RULE\b/u.test(prefix)) rule = true;
      if (routine) {
        atomicBegin = word === "BEGIN";
        if (afterBegin && word === "ATOMIC") atomicDepth += 1;
        else if (atomicDepth > 0 && word === "CASE") atomicDepth += 1;
        else if (atomicDepth > 0 && word === "END") atomicDepth -= 1;
      }
      if (trigger) {
        if (!triggerBody && word === "BEGIN") {
          triggerBody = true;
          triggerBlocks.push(word);
        } else if (triggerBody && word === "CASE") triggerBlocks.push(word);
        else if (triggerBody && word === "END") triggerBlocks.pop();
      }
      if (
        oracle &&
        !plsql &&
        (/^(?:BEGIN|DECLARE)\b/u.test(prefix) ||
          /^CREATE (?:OR REPLACE )?(?:(?:NON)?EDITIONABLE )?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b/u.test(
            prefix,
          ))
      )
        plsql = true;
      continue;
    }
    // A multi-action PostgreSQL rule keeps its parenthesized action list as one statement.
    if (rule && character === "(") ruleDepth += 1;
    else if (rule && character === ")" && ruleDepth > 0) ruleDepth -= 1;
    index += 1;
  }
  if (triggerBlocks.length > 0) invalid("Unterminated SQLite trigger body.");
  if (atomicDepth > 0) invalid("Unterminated PostgreSQL BEGIN ATOMIC body.");
  if (plsql && significant) invalid("Oracle PL/SQL requires a trailing / on its own line (or split=none).");
  if (mysql && delimiter !== ";" && significant) invalid("Unterminated MySQL statement using DELIMITER.");
  if (ruleDepth > 0) invalid("Unterminated PostgreSQL rule action list.");
  emit(source.length, source.length);
  return statements;
}
