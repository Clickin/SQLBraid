import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sourcePosition, type DiscoveredQuery } from "@sqlbraid/compiler";
import type { RelationSnapshot, RoutineSnapshot } from "@sqlbraid/metadata";
import { AUTHORING_MODULE_CATALOG, type DialectLexicalProfile } from "@sqlbraid/core";
import type { LanguageServiceOptions, Location } from "./types.js";
import type {
  FileAnalysis,
  LexToken,
  LexicalQuery,
  MetadataEvidence,
  RelationUse,
  RoutineUse,
  ColumnUse,
  Range,
} from "./analysis-types.js";

const MAX_EVIDENCE_TEXT = 4096;

const SQL_KEYWORDS = new Set([
  "all",
  "and",
  "as",
  "asc",
  "between",
  "by",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "create",
  "cross",
  "delete",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "exists",
  "false",
  "fetch",
  "filter",
  "for",
  "foreign",
  "from",
  "full",
  "grant",
  "group",
  "having",
  "if",
  "ilike",
  "in",
  "inner",
  "insert",
  "intersect",
  "into",
  "is",
  "join",
  "lateral",
  "left",
  "like",
  "limit",
  "natural",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "outer",
  "over",
  "partition",
  "primary",
  "procedure",
  "references",
  "returning",
  "right",
  "select",
  "set",
  "table",
  "then",
  "to",
  "true",
  "union",
  "unique",
  "update",
  "using",
  "values",
  "when",
  "where",
  "window",
  "with",
  "recursive",
  "return",
]);

/** Normalize unquoted metadata/source identifiers using the active dialect's folding convention. */
export function normalizeIdentifier(value: string): string {
  return value.toLowerCase();
}
export function lower(value: string): string {
  return normalizeIdentifier(value);
}
export function identifierSegments(value: string, fold = true): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) {
          index += 1;
          continue;
        }
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character === ".") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => {
    const openingQuote = part[0];
    const end = openingQuote === "[" ? "]" : openingQuote;
    if ((openingQuote === '"' || openingQuote === "`" || openingQuote === "[") && part.endsWith(end!))
      return part.slice(1, -1).replaceAll(`${end}${end}`, end!);
    return fold ? lower(part) : part;
  });
}
export function identifierKey(value: string, fold = true): string {
  return identifierSegments(value, fold).join(".");
}
export function metadataIdentifier(value: string, fold: boolean): string {
  return fold ? lower(value) : value;
}
export function sourceRange(start: number, end: number): Range {
  return { start, end };
}
export function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const identity = key(value);
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(value);
    }
  }
  return result;
}
export function bounded<T>(values: readonly T[], maxEntries: number): readonly T[] {
  return values.slice(0, Math.max(0, maxEntries));
}
export function boundedText(lines: readonly string[]): string {
  const text = lines.join("\n");
  return text.length <= MAX_EVIDENCE_TEXT ? text : `${text.slice(0, MAX_EVIDENCE_TEXT - 1)}…`;
}
export function contentKey(fileName: string, sourceText: string): string {
  return `${fileName}\0${createHash("sha256").update(sourceText).digest("hex")}`;
}
export function cacheSet<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > Math.max(1, maxEntries)) cache.delete(cache.keys().next().value as string);
}
export function location(uriPath: string, sourceText: string, range: Range): Location {
  return {
    uri: uriPath.startsWith("file:") ? uriPath : pathToFileURL(uriPath).href,
    range: { start: sourcePosition(sourceText, range.start), end: sourcePosition(sourceText, range.end) },
  };
}
function querySegments(query: DiscoveredQuery, sourceText: string): { readonly start: number; readonly end: number }[] {
  if (query.bindings.length === 0) return [{ start: query.templateRange.start + 1, end: query.templateRange.end - 1 }];
  const segments: { start: number; end: number }[] = [];
  let cursor = query.templateRange.start + 1;
  for (const binding of query.bindings) {
    const open = sourceText.lastIndexOf("${", binding.range.start);
    segments.push({ start: cursor, end: open >= cursor ? open : cursor });
    const close = sourceText.indexOf("}", binding.range.end);
    cursor = close >= 0 ? close + 1 : binding.range.end;
  }
  segments.push({ start: cursor, end: Math.max(cursor, query.templateRange.end - 1) });
  return segments;
}
function buildLexicalText(
  query: DiscoveredQuery,
  sourceText: string,
): {
  text: string;
  map: number[];
  code: boolean[];
  quoted: boolean[];
  staticRanges: Range[];
  mappingReliable: boolean;
} {
  const segments = querySegments(query, sourceText);
  const text: string[] = [];
  const map: number[] = [];
  const code: boolean[] = [];
  const quoted: boolean[] = [];
  for (let index = 0; index < query.strings.length; index += 1) {
    const cooked = query.strings[index] ?? "";
    const segment = segments[index] ?? { start: query.templateRange.start, end: query.templateRange.start };
    const raw = sourceText.slice(segment.start, segment.end);
    for (let offset = 0; offset < cooked.length; offset += 1) {
      text.push(cooked[offset]);
      map.push(segment.start + Math.min(offset, Math.max(0, raw.length - 1)));
      code.push(true);
      quoted.push(false);
    }
    if (index < query.strings.length - 1) {
      text.push(" ");
      map.push(-1);
      code.push(true);
      quoted.push(false);
    }
  }
  const mappingReliable =
    segments.length === query.strings.length &&
    segments.every((segment, index) => segment.end - segment.start === (query.strings[index]?.length ?? 0));
  return { text: text.join(""), map, code, quoted, staticRanges: segments, mappingReliable };
}
function oracleQQuoteEnd(text: string, start: number): number | undefined {
  if ((text[start] !== "q" && text[start] !== "Q") || text[start + 1] !== "'") return undefined;
  const opening = text[start + 2];
  if (!opening || /\s/u.test(opening)) return undefined;
  const closing =
    opening === "[" ? "]" : opening === "{" ? "}" : opening === "(" ? ")" : opening === "<" ? ">" : opening;
  for (let index = start + 3; index + 1 < text.length; index += 1) {
    if (text[index] === closing && text[index + 1] === "'") return index + 2;
  }
  return text.length;
}
function markLexicalProtection(
  text: string,
  code: boolean[],
  quoted: boolean[],
  profile: DialectLexicalProfile,
  mysql: boolean,
): void {
  let index = 0;
  let state: "code" | "line" | "block" | "single" | "dollar" = "code";
  let depth = 0;
  let dollar = "";
  const setProtected = (start: number, end: number): void => {
    for (let position = start; position < end; position += 1) code[position] = false;
  };
  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1];
    if (state === "line") {
      setProtected(index, index + 1);
      if ((profile.lineCommentTerminators ?? "\r\n").includes(current)) state = "code";
      index += 1;
      continue;
    }
    if (state === "block") {
      setProtected(index, index + 1);
      if (profile.supportsNestedBlockComments !== false && current === "/" && next === "*") {
        setProtected(index + 1, index + 2);
        depth += 1;
        index += 2;
        continue;
      }
      if (current === "*" && next === "/") {
        setProtected(index + 1, index + 2);
        depth -= 1;
        index += 2;
        if (depth <= 0) state = "code";
        continue;
      }
      index += 1;
      continue;
    }
    if (state === "single") {
      setProtected(index, index + 1);
      if (current === "\\" && profile.backslashEscapes !== false) {
        setProtected(index + 1, index + 2);
        index += 2;
        continue;
      }
      if (current === "'" && next === "'") {
        setProtected(index + 1, index + 2);
        index += 2;
        continue;
      }
      if (current === "'") state = "code";
      index += 1;
      continue;
    }
    if (state === "dollar") {
      setProtected(index, index + 1);
      if (text.startsWith(dollar, index)) {
        setProtected(index + 1, index + dollar.length);
        index += dollar.length;
        state = "code";
      } else index += 1;
      continue;
    }
    const line = profile.lineCommentPrefixes.find((prefix) => {
      const following = text[index + prefix.length];
      return (
        text.startsWith(prefix, index) &&
        (prefix !== "--" ||
          !profile.doubleDashRequiresWhitespace ||
          following === undefined ||
          following.charCodeAt(0) <= 0x20 ||
          following.charCodeAt(0) === 0x7f ||
          /\s/u.test(following))
      );
    });
    if (line) {
      setProtected(index, index + line.length);
      state = "line";
      index += line.length;
      continue;
    }
    if (profile.supportsOracleQQuotes) {
      const end = oracleQQuoteEnd(text, index);
      if (end !== undefined) {
        setProtected(index, end);
        index = end;
        continue;
      }
    }
    if (current === "/" && next === "*") {
      setProtected(index, index + 2);
      state = "block";
      depth = 1;
      index += 2;
      continue;
    }
    if (current === "'") {
      setProtected(index, index + 1);
      state = "single";
      index += 1;
      continue;
    }
    if (current === '"' || (current === "`" && profile.supportsBacktickIdentifiers)) {
      const quote = current;
      const start = index;
      setProtected(index, index + 1);
      index += 1;
      while (index < text.length) {
        setProtected(index, index + 1);
        if (text[index] === quote && text[index + 1] === quote) {
          setProtected(index + 1, index + 2);
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      // Without ANSI_QUOTES evidence, MySQL double quotes remain opaque literals.
      for (let position = start; position < index; position += 1) quoted[position] = !(mysql && quote === '"');
      continue;
    }
    if (current === "[" && profile.supportsBracketIdentifiers) {
      const start = index;
      setProtected(index, index + 1);
      index += 1;
      while (index < text.length) {
        setProtected(index, index + 1);
        if (text[index] === "]") {
          index += 1;
          break;
        }
        index += 1;
      }
      for (let position = start; position < index; position += 1) quoted[position] = true;
      continue;
    }
    if (profile.supportsDollarQuotes !== false && current === "$") {
      const marker = /^\$[A-Za-z0-9_]*\$/u.exec(text.slice(index))?.[0];
      if (marker) {
        setProtected(index, index + marker.length);
        state = "dollar";
        dollar = marker;
        index += marker.length;
        continue;
      }
    }
    index += 1;
  }
}
function mapSource(map: readonly number[], start: number, end: number, fallback: number): Range {
  const values = map.slice(start, end).filter((value) => value >= 0);
  if (!values.length) return { start: fallback, end: fallback };
  return { start: values[0] ?? fallback, end: (values.at(-1) ?? values[0] ?? fallback) + 1 };
}
function scanTokens(
  text: string,
  map: readonly number[],
  code: readonly boolean[],
  quoted: readonly boolean[],
): readonly LexToken[] {
  const tokens: LexToken[] = [];
  let index = 0;
  const identifier = /[A-Za-z_$\p{L}]/u;
  const continuation = /[A-Za-z0-9_$\p{L}\p{N}]/u;
  while (index < text.length) {
    const start = index;
    if (!code[index]) {
      if (!quoted[index]) {
        index += 1;
        continue;
      }
      const quote = text[index];
      if (quote !== '"' && quote !== "`" && quote !== "[") {
        index += 1;
        continue;
      }
      const endQuote = quote === "[" ? "]" : quote;
      index += 1;
      while (index < text.length) {
        if (text[index] === endQuote && text[index + 1] === endQuote) {
          index += 2;
          continue;
        }
        if (text[index] === endQuote) {
          index += 1;
          break;
        }
        index += 1;
      }
      const range = mapSource(map, start, index, 0);
      tokens.push({
        kind: "identifier",
        text: text.slice(start, index),
        start,
        end: index,
        sourceStart: range.start,
        sourceEnd: range.end,
      });
      continue;
    }
    if (identifier.test(text[index] ?? "")) {
      index += 1;
      while (index < text.length && code[index] && continuation.test(text[index] ?? "")) index += 1;
      const range = mapSource(map, start, index, 0);
      tokens.push({
        kind: "identifier",
        text: text.slice(start, index),
        start,
        end: index,
        sourceStart: range.start,
        sourceEnd: range.end,
      });
      continue;
    }
    if (!/\s/u.test(text[index] ?? "")) {
      index += 1;
      const range = mapSource(map, start, index, 0);
      tokens.push({
        kind: "punctuation",
        text: text.slice(start, index),
        start,
        end: index,
        sourceStart: range.start,
        sourceEnd: range.end,
      });
      continue;
    }
    index += 1;
  }
  return tokens;
}
export function queryDialect(moduleSpecifier: string, options: LanguageServiceOptions): string {
  return (
    options.dialect?.id ??
    AUTHORING_MODULE_CATALOG.find((entry) => entry.moduleSpecifier === moduleSpecifier)?.dialectId ??
    (moduleSpecifier === "@sqlbraid/template"
      ? (options.metadata?.dialect ?? options.targets?.[0]?.metadata.dialect ?? "postgres")
      : "postgres")
  );
}
function profileFor(moduleSpecifier: string, options: LanguageServiceOptions): DialectLexicalProfile {
  const configured = options.dialect?.lexicalProfile;
  if (configured)
    return {
      lineCommentPrefixes: configured.lineCommentPrefixes,
      doubleDashRequiresWhitespace: configured.doubleDashRequiresWhitespace,
      lineCommentTerminators: configured.lineCommentTerminators,
      supportsNestedBlockComments: configured.supportsNestedBlockComments ?? false,
      supportsDollarQuotes: configured.supportsDollarQuotes ?? false,
      supportsBacktickIdentifiers: configured.supportsBacktickIdentifiers ?? false,
      supportsBracketIdentifiers: configured.supportsBracketIdentifiers ?? false,
      supportsOracleQQuotes: configured.supportsOracleQQuotes ?? false,
      backslashEscapes: configured.backslashEscapes ?? false,
    };
  const dialect = queryDialect(moduleSpecifier, options);
  if (dialect === "mysql" || dialect === "mariadb")
    return {
      lineCommentPrefixes: ["--", "#"],
      supportsNestedBlockComments: false,
      supportsDollarQuotes: false,
      supportsBacktickIdentifiers: true,
      supportsBracketIdentifiers: false,
      supportsOracleQQuotes: false,
      backslashEscapes: true,
      doubleDashRequiresWhitespace: true,
    };
  if (dialect === "sqlite")
    return {
      lineCommentPrefixes: ["--"],
      lineCommentTerminators: "\n",
      supportsNestedBlockComments: false,
      supportsDollarQuotes: false,
      supportsBacktickIdentifiers: true,
      supportsBracketIdentifiers: true,
      supportsOracleQQuotes: false,
      backslashEscapes: false,
    };
  if (dialect === "oracle")
    return {
      lineCommentPrefixes: ["--"],
      supportsNestedBlockComments: false,
      supportsDollarQuotes: false,
      supportsBacktickIdentifiers: false,
      supportsBracketIdentifiers: false,
      supportsOracleQQuotes: true,
      backslashEscapes: false,
    };
  if (dialect === "mssql")
    return {
      lineCommentPrefixes: ["--"],
      supportsNestedBlockComments: true,
      supportsDollarQuotes: false,
      supportsBacktickIdentifiers: false,
      supportsBracketIdentifiers: true,
      supportsOracleQQuotes: false,
      backslashEscapes: false,
    };
  return {
    lineCommentPrefixes: ["--"],
    supportsNestedBlockComments: true,
    supportsDollarQuotes: true,
    supportsBacktickIdentifiers: false,
    supportsBracketIdentifiers: false,
    supportsOracleQQuotes: false,
    backslashEscapes: false,
  };
}
export function metadataEvidence(options: LanguageServiceOptions): readonly MetadataEvidence[] {
  return [
    ...(options.metadata ? [{ snapshot: options.metadata }] : []),
    ...(options.targets ?? [])
      .filter((target) => target.metadata)
      .map((target) => ({ snapshot: target.metadata, target })),
  ];
}
export function evidenceKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(evidenceKey).join(",")}]`;
  return `{${Object.entries(value)
    // eslint-disable-next-line unicorn/no-array-sort -- Object.entries creates an owned array; keep canonicalization in place.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${evidenceKey(entry)}`)
    .join(",")}}`;
}
export function allRelations(options: LanguageServiceOptions): readonly RelationSnapshot[] {
  const groups = new Map<string, RelationSnapshot[]>();
  for (const relation of metadataEvidence(options).flatMap((item) => Object.values(item.snapshot.relations)))
    groups.set(relation.identity, [...(groups.get(relation.identity) ?? []), relation]);
  return [...groups.values()]
    .filter((group) => new Set(group.map(evidenceKey)).size === 1)
    .map((group) => group[0])
    .filter((relation): relation is RelationSnapshot => relation !== undefined);
}
export function allRoutines(options: LanguageServiceOptions): readonly RoutineSnapshot[] {
  const groups = new Map<string, RoutineSnapshot[]>();
  for (const routine of metadataEvidence(options).flatMap((item) => Object.values(item.snapshot.routines).flat()))
    groups.set(routine.identity, [...(groups.get(routine.identity) ?? []), routine]);
  return [...groups.values()]
    .filter((group) => new Set(group.map(evidenceKey)).size === 1)
    .map((group) => group[0])
    .filter((routine): routine is RoutineSnapshot => routine !== undefined);
}
export function findRelation(
  name: string,
  options: LanguageServiceOptions,
  fold: boolean,
): RelationSnapshot | undefined {
  const key = identifierSegments(name, fold);
  const matches = allRelations(options).filter(
    (relation) =>
      (key.length === 1 && metadataIdentifier(relation.name, fold) === key[0]) ||
      (key.length === 2 &&
        relation.namespace !== undefined &&
        metadataIdentifier(relation.namespace, fold) === key[0] &&
        metadataIdentifier(relation.name, fold) === key[1]),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
export function findRoutine(name: string, options: LanguageServiceOptions, fold: boolean): RoutineSnapshot | undefined {
  const key = identifierSegments(name, fold);
  const matches = allRoutines(options).filter((routine) => {
    const routineParts =
      routine.packageName === undefined
        ? [routine.schema, routine.name]
        : [routine.schema, routine.packageName, routine.name];
    return (
      (key.length === 1 && metadataIdentifier(routine.name, fold) === key[0]) ||
      (key.length === routineParts.length &&
        routineParts.every((part, index) => part !== undefined && metadataIdentifier(part, fold) === key[index]))
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}
function cteNames(tokens: readonly LexToken[]): ReadonlySet<string> {
  const names = new Set<string>();
  let withSeen = false;
  let parentheses = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.text === "(") {
      parentheses += 1;
      continue;
    }
    if (token.text === ")") {
      parentheses = Math.max(0, parentheses - 1);
      continue;
    }
    if (token.kind !== "identifier") continue;
    if (token.text.toLowerCase() === "with") {
      withSeen = true;
      continue;
    }
    if (!withSeen) continue;
    if (parentheses > 0) continue;
    if (
      token.text.toLowerCase() === "select" ||
      token.text.toLowerCase() === "insert" ||
      token.text.toLowerCase() === "update" ||
      token.text.toLowerCase() === "delete"
    )
      break;
    const next = tokens[index + 1];
    const previous = tokens[index - 1];
    if (
      (next?.text.toLowerCase() === "as" || next?.text === "(") &&
      (!previous ||
        previous.text === "," ||
        previous.text.toLowerCase() === "with" ||
        previous.text.toLowerCase() === "recursive")
    )
      names.add(identifierKey(token.text));
  }
  return names;
}
function queryRelations(
  tokens: readonly LexToken[],
  options: LanguageServiceOptions,
  fold: boolean,
): readonly RelationUse[] {
  const ctes = cteNames(tokens);
  const uses: RelationUse[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "identifier" || !["from", "join", "update", "into"].includes(token.text.toLowerCase())) continue;
    const parts: LexToken[] = [];
    let cursor = index + 1;
    if (tokens[cursor]?.kind !== "identifier") continue;
    parts.push(tokens[cursor++]);
    while (tokens[cursor]?.text === "." && tokens[cursor + 1]?.kind === "identifier") {
      parts.push(tokens[cursor + 1]);
      cursor += 2;
    }
    const name = parts.map((part) => part.text).join(".");
    const cte = parts.length === 1 && ctes.has(identifierKey(name));
    const relation = cte || (ctes.size > 0 && parts.length === 1) ? undefined : findRelation(name, options, fold);
    let alias: string | undefined;
    if (tokens[cursor]?.text.toLowerCase() === "as" && tokens[cursor + 1]?.kind === "identifier")
      alias = tokens[cursor + 1]?.text;
    else if (tokens[cursor]?.kind === "identifier" && !SQL_KEYWORDS.has(tokens[cursor].text.toLowerCase()))
      alias = tokens[cursor]?.text;
    uses.push({ tokens: parts, text: name, relation, cte, ...(alias ? { alias } : {}) });
  }
  return uses;
}
export function relationForQualifier(
  value: string,
  relations: readonly RelationUse[],
  _options: LanguageServiceOptions,
): RelationSnapshot | undefined {
  const direct = relations
    .filter((relation) => relation.relation !== undefined && identifierKey(relation.text) === identifierKey(value))
    .map((relation) => relation.relation as RelationSnapshot);
  if (unique(direct, (relation) => relation.identity).length === 1) return direct[0];
  const matches = relations
    .filter(
      (relation) =>
        relation.alias !== undefined &&
        identifierKey(relation.alias) === identifierKey(value) &&
        relation.relation !== undefined,
    )
    .map((relation) => relation.relation as RelationSnapshot);
  return unique(matches, (relation) => relation.identity).length === 1 ? matches[0] : undefined;
}
function queryRoutineUses(
  tokens: readonly LexToken[],
  options: LanguageServiceOptions,
  fold: boolean,
): readonly RoutineUse[] {
  const uses: RoutineUse[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token.kind !== "identifier" || next.text !== "(" || SQL_KEYWORDS.has(token.text.toLowerCase())) continue;
    const parts = [token.text];
    let cursor = index - 1;
    while (cursor >= 1 && tokens[cursor]?.text === "." && tokens[cursor - 1]?.kind === "identifier") {
      parts.unshift(tokens[cursor - 1]?.text ?? "");
      cursor -= 2;
    }
    uses.push({ token, next, routine: findRoutine(parts.join("."), options, fold) });
  }
  return uses;
}
function queryColumns(
  tokens: readonly LexToken[],
  relations: readonly RelationUse[],
  options: LanguageServiceOptions,
  fold: boolean,
): readonly ColumnUse[] {
  const result: ColumnUse[] = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    const qualifier = tokens[index];
    const dot = tokens[index + 1];
    const columnToken = tokens[index + 2];
    if (qualifier.kind !== "identifier" || dot.text !== "." || columnToken.kind !== "identifier") continue;
    const owner = relationForQualifier(qualifier.text, relations, options);
    if (!owner) continue;
    const column = owner.columns.find((candidate) => candidate.name === identifierKey(columnToken.text, fold));
    if (column) result.push({ owner, column, token: columnToken, qualified: true, relationToken: qualifier });
  }
  const known = unique(
    relations.map((use) => use.relation).filter((relation): relation is RelationSnapshot => relation !== undefined),
    (relation) => relation.identity,
  );
  const hasUnknownRelation = relations.some((use) => use.relation === undefined);
  const hasCte = cteNames(tokens).size > 0;
  // ponytail: only direct SELECT column FROM proves an unqualified projection;
  // aliases, comma sources and expressions need stronger evidence, not a SQL parser.
  if (known.length === 1 && !hasUnknownRelation && !hasCte && !tokens.some((token) => token.text === ",")) {
    for (let index = 1; index + 1 < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (tokens[index - 1]?.text.toLowerCase() !== "select" || tokens[index + 1]?.text.toLowerCase() !== "from")
        continue;
      if (token.kind !== "identifier" || SQL_KEYWORDS.has(token.text.toLowerCase())) continue;
      if (
        result.some((item) => item.token.start === token.start) ||
        relations.some((use) => use.tokens.some((part) => part.start === token.start))
      )
        continue;
      const matches = known[0].columns.filter((column) => column.name === identifierKey(token.text, fold));
      if (matches.length === 1)
        result.push({ owner: known[0], column: matches[0], token, qualified: false, relationToken: token });
    }
  }
  return result;
}
export function lexicalQuery(
  query: DiscoveredQuery,
  sourceText: string,
  options: LanguageServiceOptions,
): LexicalQuery {
  const dialect = queryDialect(query.moduleSpecifier, options);
  const foldIdentifiers = dialect === "postgres";
  const built = buildLexicalText(query, sourceText);
  markLexicalProtection(
    built.text,
    built.code,
    built.quoted,
    profileFor(query.moduleSpecifier, options),
    dialect === "mysql" || dialect === "mariadb",
  );
  const tokens = scanTokens(built.text, built.map, built.code, built.quoted);
  const relations = queryRelations(tokens, options, foldIdentifiers);
  return {
    query,
    text: built.text,
    map: built.map,
    code: built.code,
    quoted: built.quoted,
    mappingReliable: built.mappingReliable,
    foldIdentifiers,
    tokens,
    relationUses: relations,
    routineUses: queryRoutineUses(tokens, options, foldIdentifiers),
    columnUses: queryColumns(tokens, relations, options, foldIdentifiers),
    staticRanges: built.staticRanges,
  };
}
export function offsetInStatic(lexical: LexicalQuery, offset: number): boolean {
  if (!lexical.mappingReliable) return false;
  return (
    lexical.staticRanges.some(
      (range, index) =>
        offset >= range.start &&
        (offset < range.end || (offset === range.end && index === lexical.staticRanges.length - 1)),
    ) &&
    (() => {
      const logical = lexical.map.findIndex((value) => value >= offset);
      if (logical < 0) return lexical.map.length === 0 || lexical.code.at(-1) !== false;
      return lexical.code[logical] !== false || lexical.quoted[logical] === true;
    })()
  );
}
export function tokenAt(lexical: LexicalQuery, offset: number): LexToken | undefined {
  return (
    lexical.tokens.find((token) => offset >= token.sourceStart && offset < token.sourceEnd) ??
    lexical.tokens.toReversed().find((token) => token.sourceEnd === offset)
  );
}
export function queryAt(analysis: FileAnalysis, offset: number, staticOnly = false): LexicalQuery | undefined {
  return analysis.queries.find(
    (query) =>
      offset >= query.query.range.start &&
      offset <= query.query.range.end &&
      (!staticOnly || offsetInStatic(query, offset)),
  );
}
export function completionPrefix(
  sourceText: string,
  offset: number,
): { readonly prefix: string; readonly qualified: boolean } {
  let cursor = Math.max(0, Math.min(offset, sourceText.length));
  while (cursor > 0 && /[A-Za-z0-9_$\p{L}\p{N}]/u.test(sourceText[cursor - 1] ?? "")) cursor -= 1;
  const prefix = sourceText.slice(cursor, offset);
  return { prefix, qualified: sourceText[cursor - 1] === "." };
}
