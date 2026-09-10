import type { RelationSnapshot, SchemaSnapshot } from "../../schema/src/index.js";

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
}

export interface SelectItem {
  readonly expression: string;
  readonly alias?: string;
  readonly sourceRange: { readonly start: number; readonly end: number };
}

export interface RelationRef {
  readonly name: string;
  readonly alias?: string;
  readonly sourceRange: { readonly start: number; readonly end: number };
}

export interface SelectStatement {
  readonly kind: "select";
  readonly items: readonly SelectItem[];
  readonly from?: RelationRef;
  readonly where?: string;
}

export interface DmlStatement {
  readonly kind: "insert" | "update" | "delete";
  readonly table?: RelationRef;
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
}

const DEFAULT_LIMITS: Required<ParserLimits> = { maxSourceBytes: 1_000_000, maxTokens: 100_000, maxNestingDepth: 128 };
const KEYWORDS = new Set(["SELECT", "FROM", "WHERE", "AS", "INSERT", "UPDATE", "DELETE", "INTO", "RETURNING", "JOIN", "ON", "AND", "OR", "GROUP", "ORDER", "LIMIT", "OFFSET", "VALUES"]);

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

export function lexSql(source: string, limits: ParserLimits = {}): readonly SqlToken[] {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  if (Buffer.byteLength(source, "utf8") > merged.maxSourceBytes) throw new Error("SQL source exceeds maxSourceBytes.");
  const tokens: SqlToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (isWhitespace(source[cursor])) { cursor += 1; continue; }
    const start = cursor;
    const current = source[cursor];
    const next = source[cursor + 1];
    if (current === "-" && next === "-") {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== "\n") cursor += 1;
      tokens.push({ kind: "comment", text: source.slice(start, cursor), start, end: cursor });
    } else if (current === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      if (end < 0) throw new Error("Unterminated SQL block comment.");
      cursor = end + 2;
      tokens.push({ kind: "comment", text: source.slice(start, cursor), start, end: cursor });
    } else if (current === "'" || current === '"' || current === "`") {
      const quote = current;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === quote && source[cursor + 1] === quote) { cursor += 2; continue; }
        if (source[cursor] === quote) { cursor += 1; break; }
        cursor += 1;
      }
      tokens.push({ kind: quote === "'" ? "string" : "quoted-identifier", text: source.slice(start, cursor), start, end: cursor });
    } else if (current === "?" || current === "$" && /\d/.test(next ?? "") || current === ":" && isIdentifierStart(next ?? "")) {
      cursor += 1;
      if (current === "$") while (cursor < source.length && /\d/.test(source[cursor])) cursor += 1;
      if (current === ":") while (cursor < source.length && isIdentifierPart(source[cursor])) cursor += 1;
      tokens.push({ kind: "placeholder", text: source.slice(start, cursor), start, end: cursor });
    } else if (/[0-9]/.test(current)) {
      cursor += 1;
      while (cursor < source.length && /[0-9._]/.test(source[cursor])) cursor += 1;
      tokens.push({ kind: "number", text: source.slice(start, cursor), start, end: cursor });
    } else if (isIdentifierStart(current)) {
      cursor += 1;
      while (cursor < source.length && isIdentifierPart(source[cursor])) cursor += 1;
      const text = source.slice(start, cursor);
      tokens.push({ kind: KEYWORDS.has(text.toUpperCase()) ? "keyword" : "identifier", text, start, end: cursor });
    } else if (",().;".includes(current)) {
      cursor += 1;
      tokens.push({ kind: "punctuation", text: current, start, end: cursor });
    } else {
      cursor += 1;
      while (cursor < source.length && !isWhitespace(source[cursor]) && !",().;".includes(source[cursor])) cursor += 1;
      tokens.push({ kind: "operator", text: source.slice(start, cursor), start, end: cursor });
    }
    if (tokens.length > merged.maxTokens) throw new Error("SQL source exceeds maxTokens.");
  }
  return [...tokens, { kind: "eof", text: "", start: source.length, end: source.length }];
}

function significant(tokens: readonly SqlToken[]): readonly SqlToken[] {
  return tokens.filter((token) => token.kind !== "comment" && token.kind !== "eof");
}

function splitTopLevel(tokens: readonly SqlToken[], separator: string): readonly SqlToken[][] {
  const parts: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && token.text === separator) { parts.push(current); current = []; } else current.push(token);
  }
  if (current.length) parts.push(current);
  return parts;
}

function tokenText(tokens: readonly SqlToken[]): string {
  return tokens.map((token) => token.text).join(" ");
}

function parseRelation(tokens: readonly SqlToken[]): RelationRef | undefined {
  if (!tokens.length) return undefined;
  const nameTokens = tokens.filter((token) => token.kind === "identifier" || token.kind === "quoted-identifier");
  if (!nameTokens.length) return undefined;
  const name = nameTokens[0].text.replace(/^['"`]|['"`]$/g, "");
  const aliasToken = nameTokens[1];
  return { name, alias: aliasToken?.text.replace(/^['"`]|['"`]$/g, ""), sourceRange: { start: tokens[0].start, end: tokens[tokens.length - 1].end } };
}

export function parseSql(source: string, limits: ParserLimits = {}): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  let tokens: readonly SqlToken[];
  try { tokens = lexSql(source, limits); } catch (error) { return { tokens: [], diagnostics: [{ code: "SQL_LEX", message: error instanceof Error ? error.message : String(error), start: 0, end: source.length }] }; }
  const items = significant(tokens);
  const first = items[0];
  if (!first) return { tokens, diagnostics: [{ code: "SQL_EMPTY", message: "SQL statement is empty.", start: 0, end: 0 }] };
  const keyword = first.text.toUpperCase();
  if (keyword === "SELECT") {
    const fromIndex = items.findIndex((token) => token.text.toUpperCase() === "FROM");
    const whereIndex = items.findIndex((token) => token.text.toUpperCase() === "WHERE");
    const projectionEnd = fromIndex >= 0 ? fromIndex : items.length;
    const projection = items.slice(1, projectionEnd);
    const parsedItems = splitTopLevel(projection, ",").map((part) => {
      const aliasIndex = part.findIndex((token) => token.text.toUpperCase() === "AS");
      const alias = aliasIndex >= 0 ? part[aliasIndex + 1]?.text : undefined;
      return { expression: tokenText(aliasIndex >= 0 ? part.slice(0, aliasIndex) : part), alias, sourceRange: { start: part[0]?.start ?? first.end, end: part.at(-1)?.end ?? first.end } };
    });
    const from = fromIndex >= 0 ? parseRelation(items.slice(fromIndex + 1, whereIndex >= 0 ? whereIndex : items.length)) : undefined;
    const where = whereIndex >= 0 ? tokenText(items.slice(whereIndex + 1)) : undefined;
    return { tokens, statement: { kind: "select", items: parsedItems, from, where }, diagnostics };
  }
  if (keyword === "INSERT" || keyword === "UPDATE" || keyword === "DELETE") {
    const tableStart = keyword === "UPDATE" ? 1 : items.findIndex((token) => token.text.toUpperCase() === "INTO") + 1;
    const relation = keyword === "DELETE" ? parseRelation(items.slice(tableStart + 1)) : parseRelation(items.slice(tableStart));
    return { tokens, statement: { kind: keyword.toLowerCase() as DmlStatement["kind"], table: relation }, diagnostics };
  }
  if (keyword === "CALL") {
    const routine = items[1]?.text ?? "";
    const open = items.findIndex((token) => token.text === "(");
    let close = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].text === ")") { close = index; break; }
    }
    const argumentsText = open >= 0 && close > open ? splitTopLevel(items.slice(open + 1, close), ",").map(tokenText) : [];
    return { tokens, statement: { kind: "call", routine, arguments: argumentsText }, diagnostics };
  }
  diagnostics.push({ code: "SQL_UNSUPPORTED", message: `Unsupported statement: ${keyword}.`, start: first.start, end: first.end });
  return { tokens, diagnostics };
}

function normalizeIdentifier(identifier: string): string {
  return identifier.replace(/^['"`]|['"`]$/g, "").toLowerCase();
}

function relationFor(snapshot: SchemaSnapshot, name: string): RelationSnapshot | undefined {
  const normalized = normalizeIdentifier(name);
  return Object.values(snapshot.relations).find((relation) => normalizeIdentifier(relation.name) === normalized || normalizeIdentifier(relation.identity) === normalized || normalizeIdentifier(relation.identity.split(".").at(-1) ?? "") === normalized);
}

function inferBinds(where: string | undefined, relation: RelationSnapshot | undefined): readonly BindExpectation[] {
  if (!where) return [];
  const binds: BindExpectation[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_$]*)\s*(?:=|>=|<=|>|<|IN)\s*(\$\d+|\?|:[A-Za-z_][A-Za-z0-9_$]*)/gi;
  let match: RegExpExecArray | null;
  let ordinal = 0;
  while ((match = pattern.exec(where)) !== null) {
    ordinal += 1;
    const columnName = normalizeIdentifier(match[1]);
    const column = relation?.columns.find((candidate) => normalizeIdentifier(candidate.name) === columnName);
    const placeholder = match[2].startsWith("$") ? Number(match[2].slice(1)) : ordinal;
    binds.push({ placeholder, type: column?.tsType ?? "unknown", nullable: column?.nullable, evidence: column ? `column:${column.name}` : undefined });
  }
  return binds;
}

export function resolveStatement(parsed: ParseResult, snapshot: SchemaSnapshot): SemanticResult {
  if (!parsed.statement) return { statementKind: "unknown", columns: "unknown", binds: [], diagnostics: parsed.diagnostics };
  const statement = parsed.statement;
  if (statement.kind === "call") {
    const diagnostics = [...parsed.diagnostics];
    const routine = Object.values(snapshot.routines).flat().find((candidate) => normalizeIdentifier(candidate.name) === normalizeIdentifier(statement.routine) || normalizeIdentifier(candidate.identity) === normalizeIdentifier(statement.routine));
    if (!routine) {
      diagnostics.push({ code: "SQL_ROUTINE", message: `Routine not found: ${statement.routine}.`, start: 0, end: statement.routine.length });
      return { statementKind: "call", columns: "unknown", binds: [], diagnostics };
    }
    const binds: BindExpectation[] = [];
    for (const [index, argument] of statement.arguments.entries()) {
      const placeholder = /^\$(\d+)$/.exec(argument.trim());
      if (!placeholder) continue;
      const signature = routine.arguments[index];
      binds.push({ placeholder: Number(placeholder[1]), type: signature?.tsType ?? "unknown", ...(signature?.nullable === undefined ? {} : { nullable: signature.nullable }), ...(signature ? { evidence: `routine:${routine.identity}` } : {}) });
    }
    if (routine.result.kind === "table" || routine.result.kind === "record" || routine.result.kind === "set") {
      const columns = routine.result.columns?.map((column) => ({ name: column.name, type: column.tsType ?? "unknown", nullable: column.nullable, source: routine.identity })) ?? "unknown";
      return { statementKind: "call", columns, binds, diagnostics };
    }
    if (routine.result.kind === "scalar") return { statementKind: "call", columns: [{ name: routine.name, type: routine.result.tsType ?? "unknown", nullable: routine.result.nullable ?? true, source: routine.identity }], binds, diagnostics };
    return { statementKind: "call", columns: "unknown", binds, diagnostics };
  }
  if (statement.kind !== "select") return { statementKind: statement.kind, columns: [], binds: [], diagnostics: parsed.diagnostics };
  const relation = statement.from ? relationFor(snapshot, statement.from.name) : undefined;
  const diagnostics = [...parsed.diagnostics];
  if (statement.from && !relation) diagnostics.push({ code: "SQL_RELATION", message: `Relation not found: ${statement.from.name}.`, start: statement.from.sourceRange.start, end: statement.from.sourceRange.end });
  if (!relation) return { statementKind: "select", columns: "unknown", binds: inferBinds(statement.where, relation), diagnostics };
  const columns: ResultColumn[] = [];
  for (const item of statement.items) {
    if (item.expression === "*") {
      for (const column of relation.columns) columns.push({ name: column.name, type: column.tsType ?? "unknown", nullable: column.nullable, source: relation.identity });
      continue;
    }
    const match = /^(?:[A-Za-z_][A-Za-z0-9_$]*\.)?([A-Za-z_][A-Za-z0-9_$]*)$/.exec(item.expression);
    if (!match) { columns.push({ name: item.alias ?? item.expression, type: "unknown", nullable: true }); continue; }
    const column = relation.columns.find((candidate) => normalizeIdentifier(candidate.name) === normalizeIdentifier(match[1]));
    if (!column) {
      diagnostics.push({ code: "SQL_COLUMN", message: `Column not found: ${match[1]}.`, start: item.sourceRange.start, end: item.sourceRange.end });
      columns.push({ name: item.alias ?? match[1], type: "unknown", nullable: true });
      continue;
    }
    columns.push({ name: item.alias ?? column.name, type: column.tsType ?? "unknown", nullable: column.nullable, source: relation.identity });
  }
  return { statementKind: "select", columns, binds: inferBinds(statement.where, relation), diagnostics };
}
