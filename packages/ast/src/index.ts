import type { DialectLexicalProfile } from "@sqlbraid/core";
import type { RelationSnapshot, RoutineSnapshot, SchemaSnapshot } from "@sqlbraid/schema";

export type TokenKind = "keyword" | "identifier" | "quoted-identifier" | "number" | "string" | "placeholder" | "operator" | "punctuation" | "comment" | "eof";

export interface SqlToken {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface ParserLimits {
  readonly maxSourceBytes?: number;
  readonly maxTokens?: number;
  readonly maxNestingDepth?: number;
  readonly lexicalProfile?: DialectLexicalProfile;
}

export interface SelectItem {
  readonly expression: string;
  readonly alias?: string;
  readonly sourceRange: { readonly start: number; readonly end: number };
}

export interface SqlExpressionRange {
  readonly start: number;
  readonly end: number;
}

export interface ColumnRefExpression {
  readonly kind: "column-ref";
  readonly name: string;
  readonly sourceRange?: SqlExpressionRange;
}

export interface LiteralExpression {
  readonly kind: "literal";
  readonly value: string | number | boolean | null;
  readonly sourceRange?: SqlExpressionRange;
}

export interface BindRefExpression {
  readonly kind: "bind-ref";
  readonly placeholder: number;
  readonly sourceRange?: SqlExpressionRange;
}

export interface BinaryExpression {
  readonly kind: "binary";
  readonly operator: string;
  readonly left: SqlExpression;
  readonly right: SqlExpression;
  readonly sourceRange?: SqlExpressionRange;
}

export interface UnaryExpression {
  readonly kind: "unary";
  readonly operator: string;
  readonly operand: SqlExpression;
  readonly sourceRange?: SqlExpressionRange;
}

export interface FunctionCallExpression {
  readonly kind: "function-call";
  readonly name: string;
  readonly arguments: readonly SqlExpression[];
  readonly sourceRange?: SqlExpressionRange;
}

export interface CastExpression {
  readonly kind: "cast";
  readonly expression: SqlExpression;
  readonly typeName: string;
  readonly sourceRange?: SqlExpressionRange;
}

export interface TupleExpression {
  readonly kind: "tuple";
  readonly items: readonly SqlExpression[];
  readonly sourceRange?: SqlExpressionRange;
}

export interface ListExpression {
  readonly kind: "list";
  readonly items: readonly SqlExpression[];
  readonly sourceRange?: SqlExpressionRange;
}

export interface CaseExpression {
  readonly kind: "case";
  readonly branches: readonly { readonly when: SqlExpression; readonly then: SqlExpression }[];
  readonly otherwise?: SqlExpression;
  readonly sourceRange?: SqlExpressionRange;
}

export interface UnknownExpression {
  readonly kind: "unknown";
  readonly text?: string;
  readonly sourceRange?: SqlExpressionRange;
}

export type SqlExpression =
  | ColumnRefExpression
  | LiteralExpression
  | BindRefExpression
  | BinaryExpression
  | UnaryExpression
  | FunctionCallExpression
  | CastExpression
  | TupleExpression
  | ListExpression
  | CaseExpression
  | UnknownExpression;

export interface RelationRef {
  readonly name: string;
  readonly alias?: string;
  readonly sourceRange: { readonly start: number; readonly end: number };
}

export interface JoinRef {
  readonly type: "inner" | "left" | "right" | "full" | "cross";
  readonly relation: RelationRef;
  readonly on?: string;
}

export interface SelectStatement {
  readonly kind: "select";
  readonly items: readonly SelectItem[];
  readonly from?: RelationRef;
  readonly joins?: readonly JoinRef[];
  readonly where?: string;
  readonly returning?: readonly SelectItem[];
}

export interface DmlStatement {
  readonly kind: "insert" | "update" | "delete";
  readonly table?: RelationRef;
  readonly assignments?: readonly { readonly column: string; readonly expression: string }[];
  readonly returning?: readonly SelectItem[];
}

export interface CallStatement {
  readonly kind: "call";
  readonly routine: string;
  readonly arguments: readonly string[];
}

export type Statement = SelectStatement | DmlStatement | CallStatement;

export interface ParseDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly start: number;
  readonly end: number;
}

export interface ParseResult {
  readonly tokens: readonly SqlToken[];
  readonly statement?: Statement;
  readonly diagnostics: readonly ParseDiagnostic[];
}

export interface ResultColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly source?: string;
}

export interface BindExpectation {
  readonly placeholder: number;
  readonly type: string | "unknown";
  readonly nullable?: boolean;
  readonly evidence?: string;
}

export interface SemanticResult {
  readonly statementKind: Statement["kind"] | "unknown";
  readonly columns: readonly ResultColumn[] | "unknown";
  readonly binds: readonly BindExpectation[];
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly resultKind?: "rows" | "command" | "call" | "unknown";
  readonly dependencies?: readonly string[];
}

const DEFAULT_LIMITS: Required<ParserLimits> = { maxSourceBytes: 1_000_000, maxTokens: 100_000, maxNestingDepth: 128, lexicalProfile: { lineCommentPrefixes: ["--"], supportsNestedBlockComments: true, supportsDollarQuotes: true, backslashEscapes: true } };
const KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "AS", "INSERT", "UPDATE", "DELETE", "INTO", "RETURNING", "JOIN", "ON", "AND", "OR", "GROUP", "BY", "ORDER", "LIMIT", "OFFSET", "VALUES", "SET", "DISTINCT", "ALL", "LEFT", "RIGHT", "FULL", "OUTER", "INNER", "CROSS", "USING", "UNION", "INTERSECT", "EXCEPT", "WITH", "RECURSIVE", "HAVING", "WINDOW", "FILTER", "OVER", "CASE", "WHEN", "THEN", "ELSE", "END", "TRUE", "FALSE", "NULL", "CALL", "FOR", "NO", "KEY", "SHARE", "OF", "EXPLAIN", "ANALYZE", "PRAGMA", "SHOW", "DESCRIBE", "TABLE", "FETCH", "QUALIFY", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "SET", "RESET", "USE",
]);
const MULTI_OPERATORS = ["->>", ":::", "!=", "<>", ">=", "<=", "||", "&&", "::", "->", ":=", "=>", "#>", "#>>"];

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_$\p{L}]/u.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$\p{L}\p{N}]/u.test(character);
}

function isFiniteLimit(value: number | undefined): boolean {
  return value === undefined || Number.isFinite(value) && value >= 0;
}

function readDollarQuote(source: string, start: number): string | undefined {
  if (source[start] !== "$") return undefined;
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(source.slice(start));
  return match?.[0];
}

function readQuoted(source: string, start: number, quote: string): number {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") { cursor += 2; continue; }
    if (source[cursor] === quote && source[cursor + 1] === quote) { cursor += 2; continue; }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  throw new Error(`Unterminated SQL quoted literal at ${start}.`);
}

function readBlockComment(source: string, start: number): number {
  let cursor = start + 2;
  let depth = 1;
  while (cursor < source.length && depth > 0) {
    if (source.startsWith("/*", cursor)) { depth += 1; cursor += 2; continue; }
    if (source.startsWith("*/", cursor)) { depth -= 1; cursor += 2; continue; }
    cursor += 1;
  }
  if (depth !== 0) throw new Error(`Unterminated SQL block comment at ${start}.`);
  return cursor;
}

function operatorAt(source: string, start: number): string {
  for (const operator of MULTI_OPERATORS) if (source.startsWith(operator, start)) return operator;
  return source[start];
}

export function lexSql(source: string, limits: ParserLimits = {}): readonly SqlToken[] {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  const profile = limits.lexicalProfile ?? DEFAULT_LIMITS.lexicalProfile;
  if (!isFiniteLimit(merged.maxSourceBytes) || !isFiniteLimit(merged.maxTokens) || !isFiniteLimit(merged.maxNestingDepth)) throw new Error("Parser limits must be finite and non-negative.");
  if (Buffer.byteLength(source, "utf8") > merged.maxSourceBytes) throw new Error("SQL source exceeds maxSourceBytes.");
  const tokens: SqlToken[] = [];
  let cursor = 0;
  let depth = 0;
  while (cursor < source.length) {
    if (isWhitespace(source[cursor])) { cursor += 1; continue; }
    const start = cursor;
    const current = source[cursor];
    const next = source[cursor + 1];
    const lineComment = profile.lineCommentPrefixes.find((prefix) => source.startsWith(prefix, cursor) && (prefix !== "--" || source[cursor + prefix.length] === undefined || /\s/u.test(source[cursor + prefix.length])));
    if (lineComment) {
      cursor += lineComment.length;
      while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") cursor += 1;
      tokens.push({ kind: "comment", text: source.slice(start, cursor), start, end: cursor });
    } else if (current === "/" && next === "*") {
      cursor = profile.supportsNestedBlockComments === false ? (() => { const end = source.indexOf("*/", start + 2); if (end < 0) throw new Error(`Unterminated SQL block comment at ${start}.`); return end + 2; })() : readBlockComment(source, start);
      tokens.push({ kind: "comment", text: source.slice(start, cursor), start, end: cursor });
    } else if (current === "'") {
      cursor = readQuoted(source, start, "'");
      tokens.push({ kind: "string", text: source.slice(start, cursor), start, end: cursor });
    } else if (current === '"' || current === "`" || current === "[") {
      const quote = current === "[" ? "]" : current;
      cursor = readQuoted(source, start, quote);
      tokens.push({ kind: "quoted-identifier", text: source.slice(start, cursor), start, end: cursor });
    } else if (current === "$" && /\d/u.test(next ?? "")) {
      cursor += 1;
      while (cursor < source.length && /\d/u.test(source[cursor])) cursor += 1;
      tokens.push({ kind: "placeholder", text: source.slice(start, cursor), start, end: cursor });
    } else if (profile.supportsDollarQuotes !== false && current === "$" && readDollarQuote(source, start)) {
      const delimiter = readDollarQuote(source, start);
      if (!delimiter) throw new Error(`Invalid dollar-quoted literal at ${start}.`);
      const close = source.indexOf(delimiter, start + delimiter.length);
      if (close < 0) throw new Error(`Unterminated dollar-quoted literal at ${start}.`);
      cursor = close + delimiter.length;
      tokens.push({ kind: "string", text: source.slice(start, cursor), start, end: cursor });
    } else if (current === "?" || current === ":" && isIdentifierStart(next)) {
      cursor += 1;
      if (current === ":") while (cursor < source.length && isIdentifierPart(source[cursor])) cursor += 1;
      tokens.push({ kind: "placeholder", text: source.slice(start, cursor), start, end: cursor });
    } else if (/[0-9]/u.test(current)) {
      cursor += 1;
      while (cursor < source.length && /[0-9A-Fa-f_xX.]/u.test(source[cursor])) cursor += 1;
      tokens.push({ kind: "number", text: source.slice(start, cursor), start, end: cursor });
    } else if (isIdentifierStart(current)) {
      cursor += 1;
      while (cursor < source.length && isIdentifierPart(source[cursor])) cursor += 1;
      const text = source.slice(start, cursor);
      tokens.push({ kind: KEYWORDS.has(text.toUpperCase()) ? "keyword" : "identifier", text, start, end: cursor });
    } else if (",().;".includes(current)) {
      cursor += 1;
      if (current === "(") {
        depth += 1;
        if (depth > merged.maxNestingDepth) throw new Error("SQL source exceeds maxNestingDepth.");
      }
      if (current === ")") {
        depth -= 1;
        if (depth < 0) throw new Error(`Unexpected closing parenthesis at ${start}.`);
      }
      tokens.push({ kind: "punctuation", text: current, start, end: cursor });
    } else {
      const text = operatorAt(source, start);
      cursor += text.length;
      tokens.push({ kind: "operator", text, start, end: cursor });
    }
    if (tokens.length > merged.maxTokens) throw new Error("SQL source exceeds maxTokens.");
  }
  if (depth !== 0) throw new Error("Unbalanced SQL parentheses.");
  return Object.freeze([...tokens, { kind: "eof", text: "", start: source.length, end: source.length }]);
}

function significant(tokens: readonly SqlToken[]): readonly SqlToken[] {
  return tokens.filter((token) => token.kind !== "comment" && token.kind !== "eof");
}

function depthAt(tokens: readonly SqlToken[], index: number): number {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (tokens[cursor].text === "(") depth += 1;
    if (tokens[cursor].text === ")") depth -= 1;
  }
  return depth;
}

function topLevelIndex(tokens: readonly SqlToken[], text: string, start = 0): number {
  for (let index = start; index < tokens.length; index += 1) if (depthAt(tokens, index) === 0 && tokens[index].text.toUpperCase() === text.toUpperCase()) return index;
  return -1;
}

function splitTopLevel(tokens: readonly SqlToken[], separator: string): readonly SqlToken[][] {
  const parts: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;
    if (depth === 0 && token.text === separator) { parts.push(current); current = []; }
    else current.push(token);
  }
  if (current.length) parts.push(current);
  return parts;
}

function tokenText(tokens: readonly SqlToken[]): string {
  if (!tokens.length) return "";
  let output = tokens[0].text;
  for (let index = 1; index < tokens.length; index += 1) {
    const previous = tokens[index - 1].text;
    const current = tokens[index].text;
    const separator = /[\p{L}\p{N}_$]$/u.test(previous) && /^[\p{L}\p{N}_$]/u.test(current) ? " " : "";
    output += separator + current;
  }
  return output;
}

function unquoteIdentifier(value: string): { readonly value: string; readonly quoted: boolean } {
  if (value.length < 2) return { value: value.toLowerCase(), quoted: false };
  const first = value[0];
  const last = value.at(-1);
  if ((first === '"' && last === '"') || (first === "`" && last === "`") || (first === "[" && last === "]")) return { value: value.slice(1, -1).replaceAll(first === "[" ? "]" : first, first === "[" ? "]" : first + first), quoted: true };
  return { value: value.toLowerCase(), quoted: false };
}

function identifierParts(value: string): readonly string[] {
  return value.split(".").map((part) => unquoteIdentifier(part).value);
}

function parseRelation(tokens: readonly SqlToken[]): RelationRef | undefined {
  const source = tokens.filter((token) => token.kind === "identifier" || token.kind === "quoted-identifier" || token.text === "." || token.text.toUpperCase() === "AS");
  if (!source.length) return undefined;
  const nameParts: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const token = source[cursor];
    if (token.kind === "identifier" || token.kind === "quoted-identifier") { nameParts.push(token.text); cursor += 1; if (source[cursor]?.text === ".") { cursor += 1; continue; } break; }
    cursor += 1;
  }
  if (!nameParts.length) return undefined;
  let alias: string | undefined;
  if (source[cursor]?.text.toUpperCase() === "AS") cursor += 1;
  if (source[cursor] && (source[cursor].kind === "identifier" || source[cursor].kind === "quoted-identifier")) alias = unquoteIdentifier(source[cursor].text).value;
  return { name: nameParts.map((part) => unquoteIdentifier(part).value).join("."), ...(alias ? { alias } : {}), sourceRange: { start: tokens[0].start, end: tokens.at(-1)?.end ?? tokens[0].end } };
}

function parseItems(tokens: readonly SqlToken[]): readonly SelectItem[] {
  return splitTopLevel(tokens, ",").filter((part) => part.length > 0).map((part) => {
    const aliasIndex = part.findIndex((token) => token.text.toUpperCase() === "AS" && depthAt(part, part.indexOf(token)) === 0);
    const expressionTokens = aliasIndex >= 0 ? part.slice(0, aliasIndex) : part;
    const aliasToken = aliasIndex >= 0 ? part[aliasIndex + 1] : undefined;
    const bareAlias = aliasIndex < 0 && part.length > 1 && (part.at(-1)?.kind === "identifier" || part.at(-1)?.kind === "quoted-identifier") && part.at(-2)?.text !== "." ? part.at(-1) : undefined;
    const finalExpression = bareAlias ? part.slice(0, -1) : expressionTokens;
    return { expression: tokenText(finalExpression), ...(aliasToken || bareAlias ? { alias: unquoteIdentifier((aliasToken ?? bareAlias as SqlToken).text).value } : {}), sourceRange: { start: part[0].start, end: part.at(-1)?.end ?? part[0].end } };
  });
}

function parseJoins(tokens: readonly SqlToken[]): { readonly from?: RelationRef; readonly joins: readonly JoinRef[]; readonly diagnostics: readonly ParseDiagnostic[] } {
  const diagnostics: ParseDiagnostic[] = [];
  if (!tokens.length) return { joins: [], diagnostics: [] };
  let cursor = 0;
  const firstEnd = tokens.findIndex((token) => ["JOIN", "LEFT", "RIGHT", "FULL", "INNER", "CROSS"].includes(token.text.toUpperCase()));
  const from = parseRelation(firstEnd < 0 ? tokens : tokens.slice(0, firstEnd));
  if (!from) return { joins: [], diagnostics: [{ code: "SQL_RELATION", message: "FROM clause requires a relation.", start: tokens[0].start, end: tokens.at(-1)?.end ?? tokens[0].end }] };
  cursor = firstEnd < 0 ? tokens.length : firstEnd;
  const joins: JoinRef[] = [];
  while (cursor < tokens.length) {
    let type: JoinRef["type"] = "inner";
    const start = cursor;
    const prefix = tokens[cursor]?.text.toUpperCase();
    if (prefix === "LEFT" || prefix === "RIGHT" || prefix === "FULL" || prefix === "INNER" || prefix === "CROSS") { type = prefix.toLowerCase() as JoinRef["type"]; cursor += 1; if (tokens[cursor]?.text.toUpperCase() === "OUTER") cursor += 1; }
    if (tokens[cursor]?.text.toUpperCase() !== "JOIN") {
      diagnostics.push({ code: "SQL_UNSUPPORTED", message: `Unsupported FROM clause near ${tokens[start].text}.`, start: tokens[start].start, end: tokens[start].end });
      break;
    }
    cursor += 1;
    let relationEnd = cursor;
    while (relationEnd < tokens.length && !["ON", "USING", "JOIN", "LEFT", "RIGHT", "FULL", "INNER", "CROSS"].includes(tokens[relationEnd].text.toUpperCase())) relationEnd += 1;
    const relation = parseRelation(tokens.slice(cursor, relationEnd));
    if (!relation) { diagnostics.push({ code: "SQL_RELATION", message: "JOIN requires a relation.", start: tokens[cursor]?.start ?? tokens[start].end, end: tokens[relationEnd - 1]?.end ?? tokens[start].end }); break; }
    cursor = relationEnd;
    let on: string | undefined;
    if (tokens[cursor]?.text.toUpperCase() === "ON" || tokens[cursor]?.text.toUpperCase() === "USING") {
      const onStart = ++cursor;
      while (cursor < tokens.length && !["JOIN", "LEFT", "RIGHT", "FULL", "INNER", "CROSS"].includes(tokens[cursor].text.toUpperCase())) cursor += 1;
      on = tokenText(tokens.slice(onStart, cursor));
    }
    joins.push({ type, relation, ...(on ? { on } : {}) });
  }
  return { from, joins, diagnostics };
}

function trailingStatementDiagnostic(items: readonly SqlToken[]): ParseDiagnostic | undefined {
  const semicolons = items.filter((token) => token.text === ";");
  if (semicolons.length > 1 || semicolons.length === 1 && items.at(-1)?.text !== ";") {
    const token = semicolons[1] ?? semicolons[0];
    return { code: "SQL_MULTIPLE_STATEMENTS", message: "Only one SQL statement is supported.", start: token.start, end: token.end };
  }
  return undefined;
}

export function parseSql(source: string, limits: ParserLimits = {}): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  let tokens: readonly SqlToken[];
  try { tokens = lexSql(source, limits); }
  catch (error) { return { tokens: [], diagnostics: [{ code: "SQL_LEX", message: error instanceof Error ? error.message : String(error), start: 0, end: source.length }] }; }
  const significantItems = significant(tokens);
  const trailing = trailingStatementDiagnostic(significantItems);
  const items = significantItems.at(-1)?.text === ";" ? significantItems.slice(0, -1) : significantItems;
  const first = items[0];
  if (!first) return { tokens, diagnostics: [{ code: "SQL_EMPTY", message: "SQL statement is empty.", start: 0, end: 0 }] };
  if (trailing) diagnostics.push(trailing);
  const keyword = first.text.toUpperCase();
  if (keyword === "SELECT") {
    const fromIndex = topLevelIndex(items, "FROM", 1);
    const whereIndex = topLevelIndex(items, "WHERE", fromIndex >= 0 ? fromIndex + 1 : 1);
    const returningIndex = topLevelIndex(items, "RETURNING", 1);
    const projectionEnd = fromIndex >= 0 ? fromIndex : returningIndex >= 0 ? returningIndex : items.length;
    const projection = items.slice(1, projectionEnd);
    const fromEnd = [whereIndex, returningIndex, topLevelIndex(items, "GROUP", fromIndex + 1), topLevelIndex(items, "ORDER", fromIndex + 1), topLevelIndex(items, "LIMIT", fromIndex + 1), topLevelIndex(items, "OFFSET", fromIndex + 1)].filter((value) => value >= 0).sort((left, right) => left - right)[0] ?? items.length;
    const parsedFrom = fromIndex >= 0 ? parseJoins(items.slice(fromIndex + 1, fromEnd)) : { joins: [], diagnostics: [] };
    diagnostics.push(...parsedFrom.diagnostics);
    const whereEnd = [returningIndex, topLevelIndex(items, "GROUP", whereIndex + 1), topLevelIndex(items, "ORDER", whereIndex + 1), topLevelIndex(items, "LIMIT", whereIndex + 1), topLevelIndex(items, "OFFSET", whereIndex + 1)].filter((value) => value >= 0).sort((left, right) => left - right)[0] ?? items.length;
    if (whereIndex >= 0 && whereEnd <= whereIndex + 1) diagnostics.push({ code: "SQL_WHERE", message: "WHERE clause is empty.", start: first.end, end: first.end });
    const knownClauseStarts = new Set([fromIndex, whereIndex, returningIndex, topLevelIndex(items, "GROUP", 1), topLevelIndex(items, "ORDER", 1), topLevelIndex(items, "LIMIT", 1), topLevelIndex(items, "OFFSET", 1)]);
    const unknown = items.find((token, index) => index > 0 && depthAt(items, index) === 0 && token.kind === "keyword" && !knownClauseStarts.has(index) && !["SELECT", "DISTINCT", "ALL", "AS", "BY", "AND", "OR", "HAVING", "WINDOW", "UNION", "INTERSECT", "EXCEPT", "ON", "JOIN", "LEFT", "RIGHT", "FULL", "OUTER", "INNER", "CROSS", "USING", "FOR", "NO", "KEY", "SHARE", "TRUE", "FALSE", "NULL", "CASE", "WHEN", "THEN", "ELSE", "END", "FILTER", "OVER"].includes(token.text.toUpperCase()));
    if (unknown) diagnostics.push({ code: "SQL_UNSUPPORTED", message: `Unsupported SQL clause: ${unknown.text}.`, start: unknown.start, end: unknown.end });
    return { tokens, statement: { kind: "select", items: parseItems(projection), ...(parsedFrom.from ? { from: parsedFrom.from } : {}), ...(parsedFrom.joins.length ? { joins: parsedFrom.joins } : {}), ...(whereIndex >= 0 ? { where: tokenText(items.slice(whereIndex + 1, whereEnd)) } : {}), ...(returningIndex >= 0 ? { returning: parseItems(items.slice(returningIndex + 1)) } : {}) }, diagnostics };
  }
  if (keyword === "INSERT" || keyword === "UPDATE" || keyword === "DELETE") {
    let tableTokens: readonly SqlToken[] = [];
    if (keyword === "UPDATE") tableTokens = items.slice(1, Math.max(2, topLevelIndex(items, "SET", 1)));
    else {
      const into = keyword === "INSERT" ? topLevelIndex(items, "INTO", 1) : topLevelIndex(items, "FROM", 1);
      if (into < 0) diagnostics.push({ code: "SQL_TARGET", message: `${keyword} requires a target relation.`, start: first.start, end: first.end });
      else {
        const targetEnd = items.findIndex((token, index) => index > into && token.text === "(");
        tableTokens = items.slice(into + 1, targetEnd > 0 ? targetEnd : into + 2);
      }
    }
    const table = parseRelation(tableTokens);
    if (!table) diagnostics.push({ code: "SQL_TARGET", message: `${keyword} target relation is missing.`, start: first.start, end: first.end });
    const returningIndex = topLevelIndex(items, "RETURNING", 1);
    const assignments: { column: string; expression: string }[] = [];
    if (keyword === "UPDATE") {
      const setIndex = topLevelIndex(items, "SET", 1);
      const setEnd = returningIndex >= 0 ? returningIndex : items.length;
      if (setIndex >= 0) for (const assignment of splitTopLevel(items.slice(setIndex + 1, setEnd), ",")) {
        const equals = assignment.findIndex((token) => token.text === "=");
        if (equals <= 0) diagnostics.push({ code: "SQL_ASSIGNMENT", message: "UPDATE assignment must contain an equals operator.", start: assignment[0]?.start ?? first.end, end: assignment.at(-1)?.end ?? first.end });
        else assignments.push({ column: tokenText(assignment.slice(0, equals)), expression: tokenText(assignment.slice(equals + 1)) });
      }
    }
    return { tokens, statement: { kind: keyword.toLowerCase() as DmlStatement["kind"], ...(table ? { table } : {}), ...(assignments.length ? { assignments } : {}), ...(returningIndex >= 0 ? { returning: parseItems(items.slice(returningIndex + 1)) } : {}) }, diagnostics };
  }
  if (keyword === "CALL") {
    const open = items.findIndex((token) => token.text === "(");
    const close = open >= 0 ? items.findIndex((token, index) => index > open && token.text === ")") : -1;
    if (open < 0 || close < 0) diagnostics.push({ code: "SQL_CALL", message: "CALL requires a parenthesized argument list.", start: first.start, end: first.end });
    const routine = tokenText(items.slice(1, open >= 0 ? open : items.length));
    if (close >= 0 && close < items.length - 1 && items[close + 1].text !== ";") diagnostics.push({ code: "SQL_TRAILING", message: "Unexpected tokens after CALL.", start: items[close + 1].start, end: items.at(-1)?.end ?? items[close + 1].end });
    return { tokens, statement: { kind: "call", routine, arguments: open >= 0 && close > open ? splitTopLevel(items.slice(open + 1, close), ",").map(tokenText) : [] }, diagnostics };
  }
  diagnostics.push({ code: "SQL_UNSUPPORTED", message: `Unsupported statement: ${keyword}.`, start: first.start, end: first.end });
  return { tokens, diagnostics };
}

function normalizedIdentifier(value: string): string {
  return identifierParts(value).join(".");
}

function relationFor(snapshot: SchemaSnapshot, name: string): RelationSnapshot | undefined {
  const requested = normalizedIdentifier(name);
  const matches = Object.values(snapshot.relations).filter((relation) => {
    const identity = normalizedIdentifier(relation.identity);
    const relationName = normalizedIdentifier(relation.name);
    return identity === requested || relationName === requested || identity.split(".").at(-1) === requested;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function relationMatches(snapshot: SchemaSnapshot, name: string): readonly RelationSnapshot[] {
  const requested = normalizedIdentifier(name);
  return Object.values(snapshot.relations).filter((relation) => {
    const identity = normalizedIdentifier(relation.identity);
    return identity === requested || normalizedIdentifier(relation.name) === requested || identity.split(".").at(-1) === requested;
  });
}

interface ScopeRelation {
  readonly reference: RelationRef;
  readonly relation: RelationSnapshot;
  readonly nullable: boolean;
}

function scopeRelations(statement: SelectStatement, snapshot: SchemaSnapshot, diagnostics: ParseDiagnostic[]): readonly ScopeRelation[] {
  const output: ScopeRelation[] = [];
  if (statement.from) {
    const matches = relationMatches(snapshot, statement.from.name);
    if (!matches.length) diagnostics.push({ code: "SQL_RELATION", message: `Relation not found: ${statement.from.name}.`, start: statement.from.sourceRange.start, end: statement.from.sourceRange.end });
    else if (matches.length > 1) diagnostics.push({ code: "SQL_RELATION_AMBIGUOUS", message: `Relation is ambiguous: ${statement.from.name}.`, start: statement.from.sourceRange.start, end: statement.from.sourceRange.end });
    else output.push({ reference: statement.from, relation: matches[0], nullable: false });
  }
  for (const join of statement.joins ?? []) {
    const matches = relationMatches(snapshot, join.relation.name);
    if (!matches.length) diagnostics.push({ code: "SQL_RELATION", message: `Relation not found: ${join.relation.name}.`, start: join.relation.sourceRange.start, end: join.relation.sourceRange.end });
    else if (matches.length > 1) diagnostics.push({ code: "SQL_RELATION_AMBIGUOUS", message: `Relation is ambiguous: ${join.relation.name}.`, start: join.relation.sourceRange.start, end: join.relation.sourceRange.end });
    else output.push({ reference: join.relation, relation: matches[0], nullable: join.type === "left" || join.type === "full" });
  }
  for (const join of statement.joins ?? []) if (join.type === "right" || join.type === "full") {
    const base = output.find((entry) => entry.reference === statement.from);
    if (base) output[output.indexOf(base)] = { ...base, nullable: true };
  }
  return output;
}

function outputName(item: SelectItem): string {
  if (item.alias) return item.alias;
  const parts = item.expression.split(".");
  return unquoteIdentifier(parts.at(-1) ?? item.expression).value;
}

function typeFromLiteral(expression: string): { readonly type: string; readonly nullable: boolean } | undefined {
  if (/^\d+(?:\.\d+)?$/u.test(expression)) return { type: "number", nullable: false };
  if (/^(?:true|false)$/iu.test(expression)) return { type: "boolean", nullable: false };
  if (/^'(?:''|[^'])*'$/u.test(expression)) return { type: "string", nullable: false };
  if (/^null$/iu.test(expression)) return { type: "unknown", nullable: true };
  return undefined;
}

function resolveColumn(expression: string, scope: readonly ScopeRelation[], diagnostics: ParseDiagnostic[], range: { readonly start: number; readonly end: number }): ResultColumn | undefined {
  const literal = typeFromLiteral(expression);
  if (literal) return { name: outputName({ expression, sourceRange: range }), ...literal };
  if (expression === "*") return undefined;
  const parts = identifierParts(expression);
  if (!parts.length || parts.length > 2 || parts.some((part) => !/^[A-Za-z_$\p{L}][A-Za-z0-9_$\p{L}\p{N}]*$/u.test(part))) return { name: outputName({ expression, sourceRange: range }), type: "unknown", nullable: true };
  const candidates = scope.filter((entry) => {
    const relationName = normalizedIdentifier(entry.reference.name).split(".").at(-1);
    const alias = entry.reference.alias?.toLowerCase();
    if (parts.length === 2 && parts[0] !== relationName && parts[0] !== alias) return false;
    return entry.relation.columns.some((column) => normalizedIdentifier(column.name) === parts.at(-1));
  });
  if (candidates.length > 1) {
    diagnostics.push({ code: "SQL_COLUMN_AMBIGUOUS", message: `Column is ambiguous: ${expression}.`, start: range.start, end: range.end });
    return { name: outputName({ expression, sourceRange: range }), type: "unknown", nullable: true };
  }
  const match = candidates[0];
  const column = match?.relation.columns.find((candidate) => normalizedIdentifier(candidate.name) === parts.at(-1));
  if (!match || !column) {
    diagnostics.push({ code: "SQL_COLUMN", message: `Column not found: ${expression}.`, start: range.start, end: range.end });
    return { name: outputName({ expression, sourceRange: range }), type: "unknown", nullable: true };
  }
  return { name: outputName({ expression, sourceRange: range }), type: column.tsType ?? "unknown", nullable: column.nullable || match.nullable, source: match.relation.identity };
}

function inferExpression(expression: string, scope: readonly ScopeRelation[], diagnostics: ParseDiagnostic[], range: { readonly start: number; readonly end: number }): ResultColumn {
  const literal = typeFromLiteral(expression);
  if (literal) return { name: outputName({ expression, sourceRange: range }), ...literal };
  const coalesce = /^coalesce\(([^,]+),\s*([^\)]+)\)$/iu.exec(expression);
  if (coalesce) {
    const left = inferExpression(coalesce[1].trim(), scope, diagnostics, range);
    const right = inferExpression(coalesce[2].trim(), scope, diagnostics, range);
    return { name: outputName({ expression, sourceRange: range }), type: left.type === right.type ? left.type : "unknown", nullable: left.nullable && right.nullable };
  }
  const simple = resolveColumn(expression, scope, diagnostics, range);
  if (simple) return simple;
  if (/^(?:count|row_number)\s*\(/iu.test(expression)) return { name: outputName({ expression, sourceRange: range }), type: "number", nullable: false };
  return { name: outputName({ expression, sourceRange: range }), type: "unknown", nullable: true };
}

function placeholderNumber(text: string, ordinal: number): number {
  const positional = /^\$(\d+)$/u.exec(text);
  return positional ? Number(positional[1]) : ordinal;
}

function bindExpectations(parsed: ParseResult, statement: Statement, scope: readonly ScopeRelation[], diagnostics: ParseDiagnostic[], snapshot: SchemaSnapshot): readonly BindExpectation[] {
  const binds: BindExpectation[] = [];
  let ordinal = 0;
  const tokens = significant(parsed.tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "placeholder") continue;
    ordinal += 1;
    let column: ResultColumn | undefined;
    const operatorIndex = index - 1;
    if (["=", ">", "<", ">=", "<=", "<>", "!=", "LIKE", "IN", "IS"].includes(tokens[operatorIndex]?.text.toUpperCase() ?? "")) {
      let expressionStart = operatorIndex - 1;
      while (expressionStart > 0 && ![",", "AND", "OR", "WHERE", "ON", "SET", "VALUES"].includes(tokens[expressionStart - 1].text.toUpperCase())) expressionStart -= 1;
      const left = tokens.slice(expressionStart, operatorIndex);
      if (left.length) column = resolveColumn(tokenText(left), scope, diagnostics, { start: left[0].start, end: left.at(-1)?.end ?? left[0].end });
    }
    if (statement.kind === "update" && statement.assignments) {
      const assignment = statement.assignments.find((entry) => entry.expression.includes(token.text));
      if (assignment) {
        const target = scope[0]?.relation.columns.find((candidate) => normalizedIdentifier(candidate.name) === normalizedIdentifier(assignment.column));
        if (target) column = { name: target.name, type: target.tsType ?? "unknown", nullable: target.nullable, source: scope[0].relation.identity };
      }
    }
    const routine = statement.kind === "call" ? routineAt(snapshot, statement.routine, statement.arguments.length) : undefined;
    const argumentIndex = statement.kind === "call" ? statement.arguments.findIndex((argument) => argument.trim() === token.text) : -1;
    const routineArguments = routine?.arguments.filter((argument) => argument.mode === "in" || argument.mode === "inout" || argument.mode === "variadic");
    const routineArgument = routineArguments && argumentIndex >= 0 ? routineArguments[argumentIndex] : undefined;
    const routineIdentity = routine?.identity;
    binds.push({ placeholder: placeholderNumber(token.text, ordinal), type: routineArgument?.tsType ?? column?.type ?? "unknown", ...(routineArgument?.nullable === undefined && column?.nullable === undefined ? {} : { nullable: routineArgument?.nullable ?? column?.nullable }), ...(routineIdentity ? { evidence: `routine:${routineIdentity}` } : column?.source ? { evidence: `column:${column.name}` } : {}) });
  }
  return binds;
}

function routineAt(snapshot: SchemaSnapshot, name: string, arity: number): RoutineSnapshot | undefined {
  return Object.values(snapshot.routines).flat().find((routine) => normalizedIdentifier(routine.name) === normalizedIdentifier(name) && routine.arguments.filter((argument) => argument.mode === "in" || argument.mode === "inout" || argument.mode === "variadic").length === arity);
}

function resolveRoutine(snapshot: SchemaSnapshot, statement: CallStatement, diagnostics: ParseDiagnostic[]): { readonly routine?: RoutineSnapshot; readonly binds: readonly BindExpectation[]; readonly columns: readonly ResultColumn[] | "unknown" } {
  const candidates = Object.values(snapshot.routines).flat().filter((routine) => normalizedIdentifier(routine.name) === normalizedIdentifier(statement.routine) || normalizedIdentifier(routine.identity) === normalizedIdentifier(statement.routine));
  const inputArguments = (routine: RoutineSnapshot) => routine.arguments.filter((argument) => argument.mode === "in" || argument.mode === "inout" || argument.mode === "variadic");
  const acceptsArity = (routine: RoutineSnapshot): boolean => {
    const args = inputArguments(routine);
    const required = args.filter((argument) => argument.mode !== "variadic" && !argument.hasDefault).length;
    const variadic = args.some((argument) => argument.mode === "variadic");
    return statement.arguments.length >= required && (variadic || statement.arguments.length <= args.length);
  };
  const arity = candidates.filter(acceptsArity);
  const procedures = arity.filter((routine) => routine.kind === "procedure");
  const selected = (procedures.length ? procedures : arity);
  if (selected.length !== 1) {
    diagnostics.push({ code: selected.length ? "SQL_ROUTINE_AMBIGUOUS" : "SQL_ROUTINE_ARITY", message: selected.length ? `Routine call is ambiguous: ${statement.routine}.` : `No routine overload accepts ${statement.arguments.length} argument(s): ${statement.routine}.`, start: 0, end: statement.routine.length });
    return { binds: [], columns: "unknown" };
  }
  const routine = selected[0];
  if (routine.kind !== "procedure") {
    diagnostics.push({ code: "SQL_ROUTINE_KIND", message: `CALL target is not a procedure: ${routine.identity}.`, start: 0, end: statement.routine.length });
    return { routine, binds: [], columns: "unknown" };
  }
  const args = inputArguments(routine);
  const binds: BindExpectation[] = statement.arguments.flatMap((argument, index) => {
    const placeholder = /^\$(\d+)$/.exec(argument.trim());
    if (!placeholder) return [];
    const signature = args[Math.min(index, args.length - 1)];
    return [{ placeholder: Number(placeholder[1]), type: signature?.tsType ?? "unknown", ...(signature?.nullable === undefined ? {} : { nullable: signature.nullable }), ...(signature ? { evidence: `routine:${routine.identity}` } : {}) }];
  });
  if (routine.result.kind === "table" || routine.result.kind === "record" || routine.result.kind === "set") return { routine, binds, columns: routine.result.columns?.map((column) => ({ name: column.name, type: column.tsType ?? "unknown", nullable: column.nullable, source: routine.identity })) ?? "unknown" };
  if (routine.result.kind === "scalar") return { routine, binds, columns: [{ name: routine.name, type: routine.result.tsType ?? "unknown", nullable: routine.result.nullable ?? true, source: routine.identity }] };
  return { routine, binds, columns: "unknown" };
}

export function resolveStatement(parsed: ParseResult, snapshot: SchemaSnapshot): SemanticResult {
  if (!parsed.statement) return { statementKind: "unknown", columns: "unknown", binds: [], diagnostics: parsed.diagnostics, resultKind: "unknown" };
  const diagnostics = [...parsed.diagnostics];
  const statement = parsed.statement;
  if (statement.kind === "call") {
    const resolved = resolveRoutine(snapshot, statement, diagnostics);
    return { statementKind: "call", columns: resolved.columns, binds: resolved.binds, diagnostics, resultKind: "call" };
  }
  if (statement.kind === "select") {
    const scope = scopeRelations(statement, snapshot, diagnostics);
    if (statement.from && !scope.length) return { statementKind: "select", columns: "unknown", binds: bindExpectations(parsed, statement, scope, diagnostics, snapshot), diagnostics, resultKind: "rows" };
    const columns: ResultColumn[] = [];
    for (const item of statement.items) {
      if (item.expression === "*") {
        for (const relation of scope) for (const column of relation.relation.columns) columns.push({ name: column.name, type: column.tsType ?? "unknown", nullable: column.nullable || relation.nullable, source: relation.relation.identity });
      } else columns.push({ ...inferExpression(item.expression, scope, diagnostics, item.sourceRange), ...(item.alias ? { name: item.alias } : {}) });
    }
    const names = new Set<string>();
    for (const column of columns) if (names.has(column.name)) diagnostics.push({ code: "SQL_DUPLICATE_OUTPUT", message: `Duplicate result column: ${column.name}.`, start: 0, end: 0 }); else names.add(column.name);
    const binds = bindExpectations(parsed, statement, scope, diagnostics, snapshot);
    return { statementKind: "select", columns: diagnostics.length ? "unknown" : columns, binds, diagnostics, resultKind: "rows", dependencies: scope.map((entry) => entry.relation.identity) };
  }
  const relation = statement.table ? relationFor(snapshot, statement.table.name) : undefined;
  if (statement.table && !relation) diagnostics.push({ code: "SQL_RELATION", message: `Relation not found: ${statement.table.name}.`, start: statement.table.sourceRange.start, end: statement.table.sourceRange.end });
  const scope = relation && statement.table ? [{ reference: statement.table, relation, nullable: false }] : [];
  const returning: ResultColumn[] = [];
  for (const item of statement.returning ?? []) {
    if (item.expression === "*") {
      for (const column of relation?.columns ?? []) returning.push({ name: column.name, type: column.tsType ?? "unknown", nullable: column.nullable, source: relation?.identity });
    } else returning.push(inferExpression(item.expression, scope, diagnostics, item.sourceRange));
  }
  return { statementKind: statement.kind, columns: diagnostics.length ? "unknown" : statement.returning ? returning : [], binds: bindExpectations(parsed, statement, scope, diagnostics, snapshot), diagnostics, resultKind: statement.returning ? "rows" : "command", dependencies: relation ? [relation.identity] : [] };
}
