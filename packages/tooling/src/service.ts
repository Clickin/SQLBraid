import ts from "typescript";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  checkSourceDetailed,
  createVirtualOverlay,
  discoverQueries,
  sourcePosition,
  type CompileDiagnostic,
  type DiscoveredQuery,
  type VirtualTypeScriptOverlay,
} from "@sqlbraid/compiler";
import type { ColumnSnapshot, MetadataSnapshot, RelationSnapshot, RoutineSnapshot } from "@sqlbraid/metadata";
import type { CodegenResult } from "@sqlbraid/codegen";
import { AUTHORING_MODULE_CATALOG, type DialectLexicalProfile } from "@sqlbraid/core";
import { SOURCE_FILE_LOADER, type InternalLanguageServiceOptions } from "./internal.js";
import type {
  Cancellation,
  CompletionItem,
  LanguageServiceOptions,
  Location,
  QuerySymbol,
  SignatureResult,
  SqlBraidLanguageService,
  ToolingDiagnostic,
  ToolingTarget,
  WorkspaceSymbol,
  HoverResult,
  SourceDocument,
} from "./types.js";

type Range = { readonly start: number; readonly end: number };
type MetadataEvidence = { readonly snapshot: MetadataSnapshot; readonly target?: ToolingTarget };

type LexToken = {
  readonly kind: "identifier" | "punctuation";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
};
type RelationUse = {
  readonly tokens: readonly LexToken[];
  readonly text: string;
  readonly relation?: RelationSnapshot;
  readonly cte: boolean;
  readonly alias?: string;
};
type RoutineUse = { readonly token: LexToken; readonly routine?: RoutineSnapshot; readonly next: LexToken };
type ColumnUse = {
  readonly owner: RelationSnapshot;
  readonly column: ColumnSnapshot;
  readonly token: LexToken;
  readonly qualified: boolean;
  readonly relationToken: LexToken;
};

interface LexicalQuery {
  readonly query: DiscoveredQuery;
  readonly text: string;
  readonly map: readonly number[];
  readonly code: readonly boolean[];
  readonly quoted: readonly boolean[];
  readonly mappingReliable: boolean;
  readonly foldIdentifiers: boolean;
  readonly tokens: readonly LexToken[];
  readonly relationUses: readonly RelationUse[];
  readonly routineUses: readonly RoutineUse[];
  readonly columnUses: readonly ColumnUse[];
  readonly staticRanges: readonly Range[];
}
interface FileAnalysis {
  readonly sourceText: string;
  readonly fileName: string;
  readonly queries: readonly LexicalQuery[];
  readonly diagnostics: readonly CompileDiagnostic[];
}
interface GeneratedIndex {
  readonly target: ToolingTarget;
  readonly declarations: ReadonlyMap<string, Range>;
  readonly properties: ReadonlyMap<string, Range>;
}
interface MetadataIndex {
  readonly target: ToolingTarget;
  readonly relations: ReadonlyMap<string, { readonly range: Range; readonly columns: ReadonlyMap<string, Range> }>;
  readonly routines: ReadonlyMap<string, Range>;
}

const DEFAULT_MAX_ENTRIES = 100;
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

export function normalizeIdentifier(value: string): string {
  return value.toLowerCase();
}
function lower(value: string): string {
  return normalizeIdentifier(value);
}
function identifierSegments(value: string, fold = true): string[] {
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
    const quote = part[0];
    const end = quote === "[" ? "]" : quote;
    if ((quote === '"' || quote === "`" || quote === "[") && part.endsWith(end!))
      return part.slice(1, -1).replaceAll(`${end}${end}`, end!);
    return fold ? lower(part) : part;
  });
}
function identifierKey(value: string, fold = true): string {
  return identifierSegments(value, fold).join(".");
}
function metadataIdentifier(value: string, fold: boolean): string {
  return fold ? lower(value) : value;
}
function sourceRange(start: number, end: number): Range {
  return { start, end };
}
function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
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
function bounded<T>(values: readonly T[], maxEntries: number): readonly T[] {
  return values.slice(0, Math.max(0, maxEntries));
}
function boundedText(lines: readonly string[]): string {
  const text = lines.join("\n");
  return text.length <= MAX_EVIDENCE_TEXT ? text : `${text.slice(0, MAX_EVIDENCE_TEXT - 1)}…`;
}
function contentKey(fileName: string, sourceText: string): string {
  return `${fileName}\0${createHash("sha256").update(sourceText).digest("hex")}`;
}
function cacheSet<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > Math.max(1, maxEntries)) cache.delete(cache.keys().next().value as string);
}
function location(uriPath: string, sourceText: string, range: Range): Location {
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
function queryDialect(moduleSpecifier: string, options: LanguageServiceOptions): string {
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
function metadataEvidence(options: LanguageServiceOptions): readonly MetadataEvidence[] {
  return [
    ...(options.metadata ? [{ snapshot: options.metadata }] : []),
    ...(options.targets ?? [])
      .filter((target) => target.metadata)
      .map((target) => ({ snapshot: target.metadata, target })),
  ];
}
function evidenceKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(evidenceKey).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${evidenceKey(entry)}`)
    .join(",")}}`;
}
function allRelations(options: LanguageServiceOptions): readonly RelationSnapshot[] {
  const groups = new Map<string, RelationSnapshot[]>();
  for (const relation of metadataEvidence(options).flatMap((item) => Object.values(item.snapshot.relations)))
    groups.set(relation.identity, [...(groups.get(relation.identity) ?? []), relation]);
  return [...groups.values()]
    .filter((group) => new Set(group.map(evidenceKey)).size === 1)
    .map((group) => group[0])
    .filter((relation): relation is RelationSnapshot => relation !== undefined);
}
function allRoutines(options: LanguageServiceOptions): readonly RoutineSnapshot[] {
  const groups = new Map<string, RoutineSnapshot[]>();
  for (const routine of metadataEvidence(options).flatMap((item) => Object.values(item.snapshot.routines).flat()))
    groups.set(routine.identity, [...(groups.get(routine.identity) ?? []), routine]);
  return [...groups.values()]
    .filter((group) => new Set(group.map(evidenceKey)).size === 1)
    .map((group) => group[0])
    .filter((routine): routine is RoutineSnapshot => routine !== undefined);
}
function findRelation(name: string, options: LanguageServiceOptions, fold: boolean): RelationSnapshot | undefined {
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
function findRoutine(name: string, options: LanguageServiceOptions, fold: boolean): RoutineSnapshot | undefined {
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
function relationForQualifier(
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
function lexicalQuery(query: DiscoveredQuery, sourceText: string, options: LanguageServiceOptions): LexicalQuery {
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
function offsetInStatic(lexical: LexicalQuery, offset: number): boolean {
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
function tokenAt(lexical: LexicalQuery, offset: number): LexToken | undefined {
  return (
    lexical.tokens.find((token) => offset >= token.sourceStart && offset < token.sourceEnd) ??
    [...lexical.tokens].reverse().find((token) => token.sourceEnd === offset)
  );
}
function queryAt(analysis: FileAnalysis, offset: number, staticOnly = false): LexicalQuery | undefined {
  return analysis.queries.find(
    (query) =>
      offset >= query.query.range.start &&
      offset <= query.query.range.end &&
      (!staticOnly || offsetInStatic(query, offset)),
  );
}
function completionPrefix(
  sourceText: string,
  offset: number,
): { readonly prefix: string; readonly qualified: boolean } {
  let cursor = Math.max(0, Math.min(offset, sourceText.length));
  while (cursor > 0 && /[A-Za-z0-9_$\p{L}\p{N}]/u.test(sourceText[cursor - 1] ?? "")) cursor -= 1;
  const prefix = sourceText.slice(cursor, offset);
  return { prefix, qualified: sourceText[cursor - 1] === "." };
}
function targetForRelation(
  relation: RelationSnapshot,
  options: LanguageServiceOptions,
): { readonly target: ToolingTarget; readonly model: NonNullable<CodegenResult["models"]>[number] } | undefined {
  const matches = (options.targets ?? []).flatMap((target) => {
    const model = target.generation?.models.find((candidate) => candidate.relationIdentity === relation.identity);
    return model ? [{ target, model }] : [];
  });
  if (!matches.length) return undefined;
  const keys = new Set(matches.map(({ model }) => evidenceKey(model)));
  return keys.size === 1 ? matches[0] : undefined;
}
function generatedIndexes(options: LanguageServiceOptions): readonly GeneratedIndex[] {
  const indexes: GeneratedIndex[] = [];
  for (const target of options.targets ?? []) {
    if (
      !target.outFile ||
      !target.generatedSource ||
      !target.generation ||
      target.generatedSource !== target.generation.source
    )
      continue;
    const file = ts.createSourceFile(
      target.outFile,
      target.generatedSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declarations = new Map<string, Range>();
    const properties = new Map<string, Range>();
    function visit(node: ts.Node): void {
      if (ts.isInterfaceDeclaration(node) && node.name) {
        declarations.set(node.name.text, sourceRange(node.name.getStart(file), node.name.getEnd()));
        for (const member of node.members)
          if (ts.isPropertySignature(member) && member.name) {
            const name = ts.isStringLiteral(member.name) || ts.isIdentifier(member.name) ? member.name.text : undefined;
            if (name)
              properties.set(
                `${node.name.text}\0${name}`,
                sourceRange(member.name.getStart(file), member.name.getEnd()),
              );
          }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    indexes.push({ target, declarations, properties });
  }
  return indexes;
}
function metadataObjectProperty(
  object: ts.ObjectLiteralExpression,
  key: string,
  file: ts.SourceFile,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(file)) === key,
  );
}
function jsonObjectIdentity(object: ts.ObjectLiteralExpression, file: ts.SourceFile): string | undefined {
  const identity = metadataObjectProperty(object, "identity", file)?.initializer;
  return identity && ts.isStringLiteral(identity) ? identity.text : undefined;
}
function metadataIndex(target: ToolingTarget): MetadataIndex | undefined {
  if (!target.metadataPath || !target.metadataSource) return undefined;
  const file = ts.parseJsonText(target.metadataPath, target.metadataSource);
  const root =
    file.statements[0] &&
    ts.isExpressionStatement(file.statements[0]) &&
    ts.isObjectLiteralExpression(file.statements[0].expression)
      ? file.statements[0].expression
      : undefined;
  if (!root) return undefined;
  const relations = new Map<string, { readonly range: Range; readonly columns: ReadonlyMap<string, Range> }>();
  const relationContainer = metadataObjectProperty(root, "relations", file)?.initializer;
  if (relationContainer && ts.isObjectLiteralExpression(relationContainer))
    for (const property of relationContainer.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue;
      const identity = jsonObjectIdentity(property.initializer, file);
      if (!identity) continue;
      const columns = new Map<string, Range>();
      const columnContainer = metadataObjectProperty(property.initializer, "columns", file)?.initializer;
      if (columnContainer && ts.isArrayLiteralExpression(columnContainer))
        for (const item of columnContainer.elements)
          if (ts.isObjectLiteralExpression(item)) {
            const nameNode = metadataObjectProperty(item, "name", file)?.initializer;
            const name = nameNode && ts.isStringLiteral(nameNode) ? nameNode.text : undefined;
            if (name) columns.set(name, sourceRange(item.getStart(file), item.getEnd()));
          }
      relations.set(identity, {
        range: sourceRange(property.initializer.getStart(file), property.initializer.getEnd()),
        columns,
      });
    }
  const routines = new Map<string, Range>();
  const routineContainer = metadataObjectProperty(root, "routines", file)?.initializer;
  if (routineContainer && ts.isObjectLiteralExpression(routineContainer))
    for (const property of routineContainer.properties)
      if (ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer))
        for (const item of property.initializer.elements)
          if (ts.isObjectLiteralExpression(item)) {
            const identity = jsonObjectIdentity(item, file);
            if (identity) routines.set(identity, sourceRange(item.getStart(file), item.getEnd()));
          }
  return { target, relations, routines };
}
function metadataRange(
  indexes: readonly MetadataIndex[],
  target: ToolingTarget,
  identity: string,
  column?: string,
  routine = false,
): Location | undefined {
  const index = indexes.find((candidate) => candidate.target === target);
  if (!index || !target.metadataPath || !target.metadataSource) return undefined;
  const entry = routine ? undefined : index.relations.get(identity);
  const range = routine ? index.routines.get(identity) : column ? entry?.columns.get(column) : entry?.range;
  return range ? location(target.metadataPath, target.metadataSource, range) : undefined;
}
function generatedLocation(
  relation: RelationSnapshot,
  column: string | undefined,
  options: LanguageServiceOptions,
  indexes: readonly GeneratedIndex[],
): Location | undefined {
  const linked = targetForRelation(relation, options);
  if (!linked) return undefined;
  const candidates = (options.targets ?? []).flatMap((target) => {
    const model = target.generation?.models.find((candidate) => candidate.relationIdentity === relation.identity);
    const index = indexes.find((candidate) => candidate.target === target);
    return model && index ? [{ target, model, index }] : [];
  });
  if (candidates.length !== 1) return undefined;
  const current = candidates[0];
  if (!current) return undefined;
  const index = current.index;
  const name = column ? linked.model.rowName : linked.model.rowName;
  const range = column ? index.properties.get(`${name}\0${column}`) : index.declarations.get(name);
  return range && current.target.outFile
    ? location(current.target.outFile, current.target.generatedSource ?? "", range)
    : undefined;
}
function targetMetadataLocation(
  relation: RelationSnapshot,
  column: string | undefined,
  options: LanguageServiceOptions,
  indexes: readonly MetadataIndex[],
): Location | undefined {
  for (const evidence of metadataEvidence(options))
    if (evidence.target) {
      const found = metadataRange(indexes, evidence.target, relation.identity, column);
      if (found) return found;
    }
  return undefined;
}
function relationHover(relation: RelationSnapshot, range: Range, options: LanguageServiceOptions): HoverResult {
  const linked = targetForRelation(relation, options);
  const model = linked?.model;
  const evidence = metadataEvidence(options).find((item) =>
    Object.values(item.snapshot.relations).some((candidate) => candidate.identity === relation.identity),
  );
  const scope = evidence?.snapshot.metadata.completeness ?? "unknown";
  const lines = [`Relation ${relation.identity}`, `kind: ${relation.kind}`, `scope: ${scope}`];
  if (relation.namespace) lines.push(`namespace: ${relation.namespace}`);
  if (model)
    lines.push(
      `models: ${model.rowName}${model.insertName ? `, ${model.insertName}` : ""}${model.updateName ? `, ${model.updateName}` : ""}`,
    );
  if (linked?.target.generation)
    lines.push(
      `metadataHash: ${linked.target.generation.metadataHash}`,
      `optionsHash: ${linked.target.generation.optionsHash}`,
    );
  return { contents: boundedText(lines), range };
}
function columnHover(
  owner: RelationSnapshot,
  column: ColumnSnapshot,
  range: Range,
  options: LanguageServiceOptions,
  indexes: readonly GeneratedIndex[],
): HoverResult {
  const lines = [`Column ${owner.identity}.${column.name}`, `type: ${column.type}`, `nullable: ${column.nullable}`];
  if (column.defaultExpression !== undefined) lines.push(`default: ${column.defaultExpression}`);
  if (column.generated !== undefined) lines.push(`generated: ${column.generated}`);
  if (column.identity !== undefined) lines.push(`identity: ${column.identity}`);
  if (column.insertable !== undefined) lines.push(`insertable: ${column.insertable}`);
  if (column.updatable !== undefined) lines.push(`updatable: ${column.updatable}`);
  const evidence = metadataEvidence(options).find((item) =>
    Object.values(item.snapshot.relations).some((candidate) => candidate.identity === owner.identity),
  );
  if (evidence?.snapshot.metadata.introspectionScope)
    lines.push(`introspectionScope: ${evidence.snapshot.metadata.introspectionScope}`);
  const linked = targetForRelation(owner, options);
  if (linked?.target.generation)
    lines.push(
      `metadataHash: ${linked.target.generation.metadataHash}`,
      `optionsHash: ${linked.target.generation.optionsHash}`,
    );
  if (linked) lines.push(`generated property: ${linked.model.rowName}.${column.name}`);
  const model = generatedLocation(owner, column.name, options, indexes);
  if (model) lines.push(`generated: ${model.uri}`);
  return { contents: boundedText(lines), range };
}
function routineHover(routine: RoutineSnapshot, range: Range, options: LanguageServiceOptions): HoverResult {
  const complete = (routine as RoutineSnapshot & { readonly argumentsComplete?: boolean }).argumentsComplete === true;
  const args = routine.arguments.map((argument) => `${argument.name ?? "arg"}: ${argument.type}`).join(", ");
  const result = routine.result.kind === "scalar" ? routine.result.type : routine.result.kind;
  const knownArguments = complete ? args || "none" : args ? `${args} (incomplete)` : "unknown/incomplete";
  const lines = [
    `Routine ${routine.identity}`,
    `kind: ${routine.kind}`,
    `result: ${result}`,
    `known arguments: ${knownArguments}`,
    `argumentsComplete: ${complete}`,
  ];
  const evidence = metadataEvidence(options).find((item) =>
    Object.values(item.snapshot.routines)
      .flat()
      .some((candidate) => candidate.identity === routine.identity),
  );
  if (evidence?.target?.generation)
    lines.push(
      `metadataHash: ${evidence.target.generation.metadataHash}`,
      `optionsHash: ${evidence.target.generation.optionsHash}`,
    );
  return { contents: boundedText(lines), range };
}
function queryHover(lexical: LexicalQuery, options: LanguageServiceOptions): HoverResult {
  const kind = lexical.query.declaredResultKind;
  const contract = lexical.query.declaredRowType ?? (kind === "command" ? "CommandResult" : "unknown");
  const type =
    kind === "rows"
      ? `RowQuery<${contract}>`
      : kind === "command"
        ? "CommandQuery"
        : kind === "call"
          ? `CallQuery<${contract}>`
          : `Query<${contract}>`;
  const dialect = queryDialect(lexical.query.moduleSpecifier, options);
  const lines = [type, `dialect: ${dialect}`, `binds: ${lexical.query.bindings.length}`];
  if (lexical.query.bindings.length)
    lines.push(`bindings: ${lexical.query.bindings.map((binding) => binding.expression).join(", ")}`);
  const target = options.targets?.length === 1 ? options.targets[0] : undefined;
  if (target?.name) lines.push(`target: ${target.name}`);
  if (target?.generation)
    lines.push(`metadataHash: ${target.generation.metadataHash}`, `optionsHash: ${target.generation.optionsHash}`);
  return { contents: boundedText(lines), range: lexical.query.range };
}
function relationCandidates(options: LanguageServiceOptions): CompletionItem[] {
  return allRelations(options).map((relation) => ({ label: relation.name, kind: "relation", detail: relation.kind }));
}
function columnCandidates(owner: RelationSnapshot): CompletionItem[] {
  return owner.columns.map((column) => ({ label: column.name, kind: "column", detail: column.type }));
}
function routineCandidates(options: LanguageServiceOptions): CompletionItem[] {
  return allRoutines(options).map((routine) => ({ label: routine.name, kind: "routine", detail: routine.kind }));
}
function routineSignature(routine: RoutineSnapshot, activeParameter: number): SignatureResult {
  const parameters = routine.arguments.map((argument) => `${argument.name ?? "arg"}: ${argument.type}`);
  return {
    label: `${routine.identity}(${parameters.join(", ")})`,
    parameters,
    activeParameter: Math.max(0, Math.min(activeParameter, Math.max(0, parameters.length - 1))),
  };
}
function querySymbols(analysis: FileAnalysis): readonly QuerySymbol[] {
  return analysis.queries.map((lexical) => {
    const kind = lexical.query.declaredResultKind;
    const contract = lexical.query.declaredRowType;
    return {
      name: lexical.query.tagName,
      detail: `${kind}${contract ? `<${contract}>` : ""}`,
      range: lexical.query.range,
      selectionRange: lexical.query.templateRange,
    };
  });
}

export function createLanguageService(options: LanguageServiceOptions): SqlBraidLanguageService {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const internalOptions = options as InternalLanguageServiceOptions;
  const files = new Map<string, FileAnalysis>();
  const overlays = new Map<string, VirtualTypeScriptOverlay>();
  const diagnosticsCache = new Map<string, readonly ToolingDiagnostic[]>();
  const indexCache = new Map<string, readonly GeneratedIndex[]>();
  const metadataIndexCache = new Map<string, readonly MetadataIndex[]>();
  const modules = unique(
    [
      ...AUTHORING_MODULE_CATALOG.map(({ moduleSpecifier }) => moduleSpecifier),
      ...(options.moduleSpecifiers ?? []),
      ...(options.moduleSpecifier ? [options.moduleSpecifier] : []),
    ],
    (value) => value,
  );
  const semanticOptions: InternalLanguageServiceOptions = { ...options, moduleSpecifiers: modules };
  function analysis(sourceText: string, fileName: string): FileAnalysis {
    const key = contentKey(fileName, sourceText);
    const cached = files.get(key);
    if (cached) return cached;
    const sourceFile = semanticOptions.program?.getSourceFile(fileName);
    const discovered = discoverQueries(sourceText, fileName, {
      ...semanticOptions,
      ...(sourceFile ? { sourceFile } : {}),
    });
    const value: FileAnalysis = {
      sourceText,
      fileName,
      queries: discovered.queries.map((query) => lexicalQuery(query, sourceText, semanticOptions)),
      diagnostics: discovered.diagnostics,
    };
    cacheSet(files, key, value, maxEntries);
    return value;
  }
  function overlay(sourceText: string, fileName: string): VirtualTypeScriptOverlay {
    const key = contentKey(fileName, sourceText);
    const cached = overlays.get(key);
    if (cached) return cached;
    const sourceFile = semanticOptions.program?.getSourceFile(fileName);
    const value = createVirtualOverlay(sourceText, fileName, {
      ...semanticOptions,
      ...(sourceFile ? { sourceFile } : {}),
    });
    cacheSet(overlays, key, value, maxEntries);
    return value;
  }
  function generated(): readonly GeneratedIndex[] {
    const key = (options.targets ?? [])
      .map((target) => `${target.outFile ?? ""}\0${target.generatedSource ?? ""}`)
      .join("\u0001");
    const cached = indexCache.get(key);
    if (cached) return cached;
    const value = generatedIndexes(options);
    cacheSet(indexCache, key, value, maxEntries);
    return value;
  }
  function metadata(): readonly MetadataIndex[] {
    const key = (options.targets ?? [])
      .map((target) => `${target.metadataPath ?? ""}\0${target.metadataSource ?? ""}`)
      .join("\u0001");
    const cached = metadataIndexCache.get(key);
    if (cached) return cached;
    const value = (options.targets ?? [])
      .map(metadataIndex)
      .filter((index): index is MetadataIndex => index !== undefined);
    cacheSet(metadataIndexCache, key, value, maxEntries);
    return value;
  }
  function diagnostics(sourceText: string, fileName: string): readonly ToolingDiagnostic[] {
    const key = contentKey(fileName, sourceText);
    const cached = diagnosticsCache.get(key);
    if (cached) return cached;
    const detailed = checkSourceDetailed(sourceText, fileName, semanticOptions);
    const value: ToolingDiagnostic[] = [
      ...detailed.braidDiagnostics.map((diagnostic) => ({ ...diagnostic, provenance: "braid" as const })),
      ...detailed.overlayOnlyDiagnostics.map((diagnostic) => ({ ...diagnostic, provenance: "overlay" as const })),
    ];
    cacheSet(diagnosticsCache, key, value, maxEntries);
    return value;
  }
  function hover(sourceText: string, fileName: string, offset: number): HoverResult | undefined {
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset);
    if (!lexical) return undefined;
    if (!lexical.mappingReliable) return undefined;
    const generatedEvidence = generated();
    const token = tokenAt(lexical, offset);
    const relationUse = lexical.relationUses.find((use) =>
      use.tokens.some((part) => token && part.start === token.start),
    );
    if (relationUse?.relation && !relationUse.cte)
      return relationHover(
        relationUse.relation,
        sourceRange(token?.sourceStart ?? offset, token?.sourceEnd ?? offset),
        semanticOptions,
      );
    const column = lexical.columnUses.find((use) => token && use.token.start === token.start);
    if (column)
      return columnHover(
        column.owner,
        column.column,
        sourceRange(column.token.sourceStart, column.token.sourceEnd),
        semanticOptions,
        generatedEvidence,
      );
    const routine = lexical.routineUses.find((use) => token && use.token.start === token.start)?.routine;
    if (routine)
      return routineHover(
        routine,
        sourceRange(token?.sourceStart ?? offset, token?.sourceEnd ?? offset),
        semanticOptions,
      );
    const inTag = offset >= lexical.query.range.start && offset < lexical.query.templateRange.start;
    if (inTag || offsetInStatic(lexical, offset)) {
      const contract = overlay(sourceText, fileName).queryTypes.find(
        (candidate) => candidate.range.start === lexical.query.range.start,
      );
      const result = queryHover(lexical, semanticOptions);
      if (contract && contract.rowType !== "unknown" && !lexical.query.declaredRowType)
        return { ...result, contents: result.contents.replace("unknown", contract.rowType) };
      return result;
    }
    return undefined;
  }
  function complete(sourceText: string, fileName: string, offset: number): readonly CompletionItem[] {
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset, true);
    if (!lexical) return [];
    const logical = lexical.map.findIndex((value) => value >= offset);
    if (logical >= 0 && lexical.code[logical] === false) return [];
    const { prefix, qualified } = completionPrefix(sourceText, offset);
    const cursorToken = lexical.tokens.find(
      (token) => token.kind === "identifier" && token.sourceStart < offset && token.sourceEnd >= offset,
    );
    const before = lexical.tokens.filter((token) => token.sourceEnd <= (cursorToken?.sourceStart ?? offset));
    const previous = before.at(-1);
    const relationContext =
      previous?.kind === "identifier" && ["from", "join", "update", "into"].includes(previous.text.toLowerCase());
    let candidates: CompletionItem[];
    if (relationContext) candidates = relationCandidates(semanticOptions);
    else if (qualified) {
      const qualifier = sourceText.slice(0, offset - prefix.length - 1).match(/[A-Za-z0-9_$\p{L}\p{N}]+$/u)?.[0];
      const owner = qualifier ? relationForQualifier(qualifier, lexical.relationUses, semanticOptions) : undefined;
      if (owner) candidates = columnCandidates(owner);
      else {
        const nextTokenIndex = lexical.tokens.findIndex((candidate) => candidate.sourceStart >= offset);
        const cursorIndex = cursorToken
          ? lexical.tokens.indexOf(cursorToken)
          : nextTokenIndex >= 0
            ? nextTokenIndex
            : lexical.tokens.length;
        const qualifierIndex = cursorIndex - 2;
        const qualifiedRelationContext =
          qualifierIndex > 0 &&
          ["from", "join", "update", "into"].includes(lexical.tokens[qualifierIndex - 1]?.text.toLowerCase() ?? "");
        const relations = qualifier
          ? allRelations(semanticOptions).filter(
              (relation) => relation.namespace === identifierKey(qualifier, lexical.foldIdentifiers),
            )
          : [];
        const routines = qualifier
          ? allRoutines(semanticOptions).filter(
              (routine) => routine.schema === identifierKey(qualifier, lexical.foldIdentifiers),
            )
          : [];
        candidates = qualifiedRelationContext
          ? relations.map((relation) => ({ label: relation.name, kind: "relation" as const, detail: relation.kind }))
          : routines.map((routine) => ({ label: routine.name, kind: "routine" as const, detail: routine.kind }));
      }
    } else
      candidates = [
        ...relationCandidates(semanticOptions),
        ...routineCandidates(semanticOptions),
        ...unique(
          lexical.relationUses
            .map((use) => use.relation)
            .filter((relation): relation is RelationSnapshot => relation !== undefined),
          (relation) => relation.identity,
        ).flatMap(columnCandidates),
      ];
    const wanted = lower(prefix);
    return bounded(
      unique(
        candidates.filter((item) => lower(item.label).startsWith(wanted)),
        (item) => `${item.kind}\0${item.label}`,
      ),
      maxEntries,
    );
  }
  function definition(sourceText: string, fileName: string, offset: number): Location | undefined {
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset, true);
    if (!lexical) return undefined;
    const token = tokenAt(lexical, offset);
    if (!token) return undefined;
    const generatedEvidence = generated();
    const relationUse = lexical.relationUses.find((use) => use.tokens.some((part) => part.start === token.start));
    if (relationUse?.relation && !relationUse.cte)
      return (
        generatedLocation(relationUse.relation, undefined, semanticOptions, generatedEvidence) ??
        targetMetadataLocation(relationUse.relation, undefined, semanticOptions, metadata())
      );
    const column = lexical.columnUses.find((use) => use.token.start === token.start);
    if (column)
      return (
        generatedLocation(column.owner, column.column.name, semanticOptions, generatedEvidence) ??
        targetMetadataLocation(column.owner, column.column.name, semanticOptions, metadata())
      );
    const routine = lexical.routineUses.find((use) => use.token.start === token.start)?.routine;
    if (routine)
      for (const evidence of metadataEvidence(semanticOptions)) {
        const target = evidence.target;
        if (target) {
          const found = metadataRange(metadata(), target, routine.identity, undefined, true);
          if (found) return found;
        }
      }
    return undefined;
  }
  async function references(
    sourceText: string,
    fileName: string,
    offset: number,
    cancellation?: Cancellation,
  ): Promise<readonly Location[]> {
    if (cancellation?.isCancellationRequested) return [];
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset, true);
    if (!lexical) return [];
    const token = tokenAt(lexical, offset);
    if (!token) return [];
    const relation = lexical.relationUses.find((use) =>
      use.tokens.some((part) => part.start === token.start),
    )?.relation;
    const column = lexical.columnUses.find((use) => use.token.start === token.start);
    const routine = lexical.routineUses.find((use) => use.token.start === token.start)?.routine;
    if (!relation && !column && !routine) return [];
    const results: Location[] = [];
    const seenFiles = new Set<string>();
    const visit = async (document: SourceDocument): Promise<boolean> => {
      if (cancellation?.isCancellationRequested) return false;
      if (seenFiles.has(document.fileName)) return true;
      seenFiles.add(document.fileName);
      const indexed = analysis(document.sourceText, document.fileName);
      if (cancellation?.isCancellationRequested) return false;
      for (const item of indexed.queries) {
        if (relation)
          for (const use of item.relationUses)
            if (use.relation?.identity === relation.identity && !use.cte) {
              const first = use.tokens[0];
              const last = use.tokens.at(-1) ?? first;
              if (first && last)
                results.push(
                  location(document.fileName, document.sourceText, sourceRange(first.sourceStart, last.sourceEnd)),
                );
            }
        if (routine)
          for (const use of item.routineUses)
            if (use.routine?.identity === routine.identity)
              results.push(
                location(
                  document.fileName,
                  document.sourceText,
                  sourceRange(use.token.sourceStart, use.token.sourceEnd),
                ),
              );
        if (column)
          for (const use of item.columnUses)
            if (use.owner.identity === column.owner.identity && use.column.name === column.column.name)
              results.push(
                location(
                  document.fileName,
                  document.sourceText,
                  sourceRange(use.token.sourceStart, use.token.sourceEnd),
                ),
              );
      }
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      return !cancellation?.isCancellationRequested;
    };
    for (const document of [{ fileName, sourceText }, ...(options.sources ?? [])]) {
      if (!(await visit(document))) return [];
    }
    const sourceLoader = internalOptions[SOURCE_FILE_LOADER];
    for (const sourcePath of internalOptions.sourceFiles ?? []) {
      if (seenFiles.has(sourcePath)) continue;
      if (cancellation?.isCancellationRequested) return [];
      const document = sourceLoader ? await sourceLoader(sourcePath, cancellation) : undefined;
      if (document && !(await visit(document))) return [];
    }
    return unique(
      results,
      (item) =>
        `${item.uri}\0${item.range.start.line}\0${item.range.start.character}\0${item.range.end.line}\0${item.range.end.character}`,
    );
  }
  function documentSymbols(sourceText: string, fileName: string): readonly QuerySymbol[] {
    return bounded(querySymbols(analysis(sourceText, fileName)), maxEntries);
  }
  function workspaceSymbols(query: string): readonly WorkspaceSymbol[] {
    const wanted = lower(query);
    const result: WorkspaceSymbol[] = [];
    const generatedEvidence = generated();
    for (const relation of allRelations(semanticOptions)) {
      if (!lower(relation.name).includes(wanted) && !lower(relation.identity).includes(wanted)) continue;
      const definitionLocation =
        generatedLocation(relation, undefined, semanticOptions, generatedEvidence) ??
        targetMetadataLocation(relation, undefined, semanticOptions, metadata());
      if (!definitionLocation) continue;
      result.push({ name: relation.name, kind: "relation", location: definitionLocation, detail: relation.identity });
    }
    for (const routine of allRoutines(semanticOptions)) {
      if (!lower(routine.name).includes(wanted) && !lower(routine.identity).includes(wanted)) continue;
      let definitionLocation: Location | undefined;
      for (const evidence of metadataEvidence(semanticOptions))
        if (evidence.target) {
          definitionLocation = metadataRange(metadata(), evidence.target, routine.identity, undefined, true);
          if (definitionLocation) break;
        }
      if (definitionLocation)
        result.push({ name: routine.name, kind: "routine", location: definitionLocation, detail: routine.identity });
    }
    for (const index of generated())
      for (const [name, range] of index.declarations)
        if (lower(name).includes(wanted) && index.target.outFile && index.target.generatedSource)
          result.push({
            name,
            kind: "model",
            location: location(index.target.outFile, index.target.generatedSource, range),
          });
    return bounded(
      unique(result, (item) => `${item.kind}\0${item.name}\0${item.location.uri}`),
      maxEntries,
    );
  }
  function signatureHelp(sourceText: string, fileName: string, offset: number): SignatureResult | undefined {
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset, true);
    if (!lexical) return undefined;
    for (let useIndex = lexical.routineUses.length - 1; useIndex >= 0; useIndex -= 1) {
      const use = lexical.routineUses[useIndex]!;
      if (offset < use.next.sourceEnd) continue;
      const open = lexical.tokens.findIndex((candidate) => candidate.start === use.next.start);
      if (open < 0) continue;
      let depth = 0;
      let active = 0;
      let closed = false;
      for (let index = open + 1; index < lexical.tokens.length; index += 1) {
        const candidate = lexical.tokens[index]!;
        if (candidate.sourceStart >= offset) break;
        if (candidate.text === "(") depth += 1;
        else if (candidate.text === ")") {
          if (depth === 0) {
            closed = true;
            break;
          }
          depth -= 1;
        } else if (candidate.text === "," && depth === 0) active += 1;
      }
      if (closed) continue;
      return use.routine?.argumentsComplete === true ? routineSignature(use.routine, active) : undefined;
    }
    return undefined;
  }
  function reload(metadata: MetadataSnapshot): SqlBraidLanguageService {
    return createLanguageService({ ...options, metadata });
  }
  return {
    diagnostics,
    hover,
    complete,
    definition,
    references,
    documentSymbols,
    workspaceSymbols,
    signatureHelp,
    reload,
  };
}
