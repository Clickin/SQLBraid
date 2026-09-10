import {
  SQL_FRAGMENT,
  type BindNode,
  type ChooseNode,
  type Dialect,
  type DialectLexicalProfile,
  type IfNode,
  type ListNode,
  type Query,
  type RenderLimits,
  type RenderedQuery,
  type SqlFragment,
  SqlRenderError,
  type SqlTag,
  type SourceRange,
  type TemplateIr,
  type TemplateNode,
  type TrimAttributes,
  type TrimNode,
} from "@sqlbraid/core";

const DEFAULT_LIMITS: Required<RenderLimits> = {
  maxSqlBytes: 1_000_000,
  maxBindCount: 10_000,
  maxStructuralItems: 10_000,
  maxNestingDepth: 128,
};

export const postgresDialect: Dialect = {
  id: "postgres",
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  lexicalProfile: {
    lineCommentPrefixes: ["--"],
    supportsNestedBlockComments: true,
    supportsDollarQuotes: true,
    backslashEscapes: false,
  },
};

const knownFragments = new WeakSet<object>();
const isFragment = (value: unknown): value is SqlFragment =>
  typeof value === "object" && value !== null && knownFragments.has(value) && SQL_FRAGMENT in value && value[SQL_FRAGMENT] === true;

interface CharUnit {
  readonly kind: "char";
  readonly value: string;
  readonly position: number;
}

interface HoleUnit {
  readonly kind: "hole";
  readonly interpolation: number;
  readonly position: number;
}

type Unit = CharUnit | HoleUnit;

function buildUnits(strings: readonly string[]): { readonly units: readonly Unit[]; readonly sourceLength: number } {
  const units: Unit[] = [];
  let position = 0;
  for (let index = 0; index < strings.length; index += 1) {
    const text = strings[index];
    if (typeof text !== "string") throw new SqlRenderError("BRAID_ESCAPE", "Invalid cooked template escape.");
    for (let offset = 0; offset < text.length; offset += 1) units.push({ kind: "char", value: text[offset], position: position++ });
    if (index < strings.length - 1) units.push({ kind: "hole", interpolation: index, position: position++ });
  }
  return { units, sourceLength: position };
}

function charAt(units: readonly Unit[], index: number): string | undefined {
  const unit = units[index];
  return unit?.kind === "char" ? unit.value : undefined;
}

function startsWith(units: readonly Unit[], index: number, text: string): boolean {
  for (let offset = 0; offset < text.length; offset += 1) if (charAt(units, index + offset) !== text[offset]) return false;
  return true;
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_$]/u.test(value);
}

interface DirectiveToken {
  readonly kind: "directive";
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly text: string;
  readonly holes: readonly number[];
}

interface HoleToken {
  readonly kind: "hole";
  readonly start: number;
  readonly end: number;
  readonly interpolation: number;
}

interface TextToken {
  readonly kind: "text";
  readonly start: number;
  readonly end: number;
}

type SpecialToken = DirectiveToken | HoleToken | TextToken;

function dollarDelimiter(units: readonly Unit[], start: number): string | undefined {
  if (charAt(units, start) !== "$") return undefined;
  let cursor = start + 1;
  while (cursor < units.length && charAt(units, cursor) !== "$") {
    const value = charAt(units, cursor);
    if (value === undefined || !/[A-Za-z0-9_]/.test(value)) return undefined;
    cursor += 1;
  }
  if (charAt(units, cursor) !== "$") return undefined;
  return units.slice(start, cursor + 1).map((unit) => unit.kind === "char" ? unit.value : "").join("");
}

function directiveStart(units: readonly Unit[], index: number): boolean {
  return startsWith(units, index, "/*@braid") && !isWordCharacter(charAt(units, index + 8));
}

function scanDirective(units: readonly Unit[], start: number): DirectiveToken {
  const body: string[] = [];
  const holes: number[] = [];
  let cursor = start + 8;
  while (cursor < units.length) {
    const unit = units[cursor];
    if (unit.kind === "hole") {
      holes.push(unit.interpolation);
      body.push(" ");
      cursor += 1;
      continue;
    }
    if (startsWith(units, cursor, "*/")) {
      const text = body.join("").trim();
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      if (!match) throw new SqlRenderError("BRAID_DIRECTIVE", "Empty @braid directive.");
      return { kind: "directive", start, end: cursor + 2, name: match[1], text: match[2] ?? "", holes };
    }
    body.push(unit.value);
    cursor += 1;
  }
  throw new SqlRenderError("BRAID_DIRECTIVE_UNTERMINATED", "Unterminated /*@braid directive.");
}

function lineCommentStart(units: readonly Unit[], index: number, profile: DialectLexicalProfile): string | undefined {
  for (const prefix of profile.lineCommentPrefixes) {
    if (!startsWith(units, index, prefix)) continue;
    if (prefix === "--" && charAt(units, index + prefix.length) !== undefined && !/\s/u.test(charAt(units, index + prefix.length) ?? "")) continue;
    return prefix;
  }
  return undefined;
}

function scanNext(units: readonly Unit[], start: number, profile: DialectLexicalProfile): SpecialToken {
  let cursor = start;
  let textStart = start;
  let state: "code" | "single" | "double" | "backtick" | "bracket" | "line" | "block" | "dollar" = "code";
  let blockDepth = 0;
  let dollar = "";
  while (cursor < units.length) {
    const unit = units[cursor];
    if (unit.kind === "hole") {
      if (state !== "code") throw new SqlRenderError("BRAID_HOLE_CONTEXT", "Interpolation inside a SQL literal or comment is unsupported.");
      if (cursor > textStart) return { kind: "text", start: textStart, end: cursor };
      return { kind: "hole", start: cursor, end: cursor + 1, interpolation: unit.interpolation };
    }
    const current = unit.value;
    const next = charAt(units, cursor + 1);
    if (state === "line") {
      if (current === "\n" || current === "\r") state = "code";
      cursor += 1;
      continue;
    }
    if (state === "block") {
      if (profile.supportsNestedBlockComments && current === "/" && next === "*") { blockDepth += 1; cursor += 2; continue; }
      if (current === "*" && next === "/") {
        blockDepth -= 1;
        cursor += 2;
        if (blockDepth === 0) state = "code";
        continue;
      }
      cursor += 1;
      continue;
    }
    if (state === "single" || state === "double" || state === "backtick") {
      if (current === "\\") { cursor += 2; continue; }
      if (current === state[0] && next === state[0]) { cursor += 2; continue; }
      if ((state === "single" && current === "'") || (state === "double" && current === '"') || (state === "backtick" && current === "`")) state = "code";
      cursor += 1;
      continue;
    }
    if (state === "bracket") {
      if (current === "]") state = "code";
      cursor += 1;
      continue;
    }
    if (state === "dollar") {
      if (startsWith(units, cursor, dollar)) { cursor += dollar.length; state = "code"; }
      else cursor += 1;
      continue;
    }
    if (directiveStart(units, cursor)) {
      if (cursor > textStart) return { kind: "text", start: textStart, end: cursor };
      return scanDirective(units, cursor);
    }
    const lineComment = lineCommentStart(units, cursor, profile);
    if (lineComment) { state = "line"; cursor += lineComment.length; continue; }
    if (current === "/" && next === "*") { state = "block"; blockDepth = 1; cursor += 2; continue; }
    if (current === "'") { state = "single"; cursor += 1; continue; }
    if (current === '"') { state = "double"; cursor += 1; continue; }
    if (current === "`") { state = "backtick"; cursor += 1; continue; }
    if (current === "[") { state = "bracket"; cursor += 1; continue; }
    const delimiter = profile.supportsDollarQuotes === false ? undefined : dollarDelimiter(units, cursor);
    if (delimiter) { state = "dollar"; dollar = delimiter; cursor += delimiter.length; continue; }
    cursor += 1;
  }
  if (state !== "code") throw new SqlRenderError("BRAID_SQL_LEX", "Unterminated SQL literal or comment in template.");
  return { kind: "text", start: textStart, end: units.length };
}

function textFrom(units: readonly Unit[], start: number, end: number): string {
  return units.slice(start, end).map((unit) => unit.kind === "char" ? unit.value : "").join("");
}

function appendTextNodes(nodes: TemplateNode[], units: readonly Unit[], start: number, end: number): void {
  if (end <= start) return;
  nodes.push({ kind: "text", text: textFrom(units, start, end), range: { start, end } });
}

interface ParseResult {
  readonly nodes: readonly TemplateNode[];
  readonly next: number;
  readonly stop?: DirectiveToken;
}

function conditionOf(directive: DirectiveToken): number {
  if (directive.holes.length !== 1 || directive.text.trim()) throw new SqlRenderError("BRAID_CONDITION", "Directive condition must contain exactly one interpolation.");
  return directive.holes[0];
}

function parseAttributes(text: string): TrimAttributes {
  const attributes: Record<string, string> = {};
  const pattern = /(prefix|prefixOverrides|suffix|suffixOverrides)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  let consumed = "";
  while ((match = pattern.exec(text)) !== null) {
    if (attributes[match[1]] !== undefined) throw new SqlRenderError("BRAID_ATTRIBUTES", `Duplicate trim attribute: ${match[1]}`);
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
    consumed += match[0];
  }
  const unknown = text.replace(pattern, "").trim();
  if (unknown) throw new SqlRenderError("BRAID_ATTRIBUTES", `Unsupported trim attributes: ${unknown}`);
  const split = (value: string | undefined): readonly string[] =>
    (value ?? "").split("|").map((item) => item.trim().toUpperCase()).filter(Boolean);
  return {
    prefix: attributes.prefix ?? "",
    prefixOverrides: split(attributes.prefixOverrides),
    suffix: attributes.suffix ?? "",
    suffixOverrides: split(attributes.suffixOverrides),
  };
}

function parseSequence(units: readonly Unit[], start: number, stopNames: readonly string[], depth: number, profile: DialectLexicalProfile, maxNestingDepth: number): ParseResult {
  if (depth > maxNestingDepth) throw new SqlRenderError("BRAID_DEPTH", "Template nesting limit exceeded.");
  const nodes: TemplateNode[] = [];
  let cursor = start;
  while (cursor < units.length) {
    const token = scanNext(units, cursor, profile);
    if (token.kind === "text") {
      appendTextNodes(nodes, units, token.start, token.end);
      if (token.end >= units.length) return { nodes, next: token.end };
      cursor = token.end;
      continue;
    }
    if (token.kind === "hole") {
      nodes.push({ kind: "bind", interpolation: token.interpolation, range: { start: token.start, end: token.end } });
      cursor = token.end;
      continue;
    }
    if (stopNames.includes(token.name)) return { nodes, next: token.end, stop: token };
    if (token.name === "end") throw new SqlRenderError("BRAID_STRUCTURE", "Unexpected @braid end.");
    if (token.name === "if") {
      const condition = conditionOf(token);
      const child = parseSequence(units, token.end, ["end"], depth + 1, profile, maxNestingDepth);
      if (!child.stop || child.stop.name !== "end") throw new SqlRenderError("BRAID_STRUCTURE", "Missing @braid end for if.");
      nodes.push({ kind: "if", condition, children: child.nodes, range: { start: token.start, end: child.next } });
      cursor = child.next;
      continue;
    }
    if (token.name === "choose") {
      const whens: { condition: number; children: readonly TemplateNode[]; range: SourceRange }[] = [];
      let otherwise: readonly TemplateNode[] | undefined;
      let branch = parseSequence(units, token.end, ["when", "otherwise", "end"], depth + 1, profile, maxNestingDepth);
      if (!branch.stop) throw new SqlRenderError("BRAID_STRUCTURE", "Missing @braid end for choose.");
      if (branch.nodes.some((node) => node.kind !== "text" || node.text.trim())) throw new SqlRenderError("BRAID_STRUCTURE", "Choose must begin with when or otherwise.");
      let stop = branch.stop;
      while (stop.name === "when") {
        const condition = conditionOf(stop);
        const content = parseSequence(units, branch.next, ["when", "otherwise", "end"], depth + 1, profile, maxNestingDepth);
        whens.push({ condition, children: content.nodes, range: { start: stop.start, end: content.next } });
        if (!content.stop) throw new SqlRenderError("BRAID_STRUCTURE", "Missing branch terminator in choose.");
        branch = content;
        stop = content.stop;
      }
      if (stop.name === "otherwise") {
        if (stop.holes.length || stop.text.trim()) throw new SqlRenderError("BRAID_STRUCTURE", "otherwise does not accept a condition.");
        const content = parseSequence(units, branch.next, ["end"], depth + 1, profile, maxNestingDepth);
        if (!content.stop || content.stop.name !== "end") throw new SqlRenderError("BRAID_STRUCTURE", "Missing @braid end for otherwise.");
        otherwise = content.nodes;
        branch = content;
        stop = content.stop;
      }
      if (stop.name !== "end") throw new SqlRenderError("BRAID_STRUCTURE", `Unexpected choose directive: ${stop.name}.`);
      nodes.push({ kind: "choose", whens, ...(otherwise === undefined ? {} : { otherwise }), range: { start: token.start, end: branch.next } });
      cursor = branch.next;
      continue;
    }
    if (token.name === "where" || token.name === "set" || token.name === "trim") {
      if (token.name !== "trim" && (token.holes.length || token.text.trim())) throw new SqlRenderError("BRAID_ATTRIBUTES", `${token.name} does not accept attributes.`);
      const child = parseSequence(units, token.end, ["end"], depth + 1, profile, maxNestingDepth);
      if (!child.stop || child.stop.name !== "end") throw new SqlRenderError("BRAID_STRUCTURE", `Missing @braid end for ${token.name}.`);
      const attributes = token.name === "where"
        ? { prefix: "WHERE ", prefixOverrides: ["AND", "OR"], suffix: "", suffixOverrides: [] }
        : token.name === "set"
          ? { prefix: "SET ", prefixOverrides: [], suffix: "", suffixOverrides: [","] }
          : parseAttributes(token.text);
      nodes.push({ kind: "trim", attributes, children: child.nodes, range: { start: token.start, end: child.next } });
      cursor = child.next;
      continue;
    }
    if (token.name === "when" || token.name === "otherwise") throw new SqlRenderError("BRAID_STRUCTURE", `${token.name} is only valid inside choose.`);
    throw new SqlRenderError("BRAID_DIRECTIVE", `Unknown @braid directive: ${token.name}.`);
  }
  return { nodes, next: cursor };
}

function freezeNode(node: TemplateNode): TemplateNode {
  if (node.kind === "if") return Object.freeze({ ...node, children: Object.freeze(node.children.map(freezeNode)) });
  if (node.kind === "choose") return Object.freeze({ ...node, whens: Object.freeze(node.whens.map((when) => Object.freeze({ ...when, children: Object.freeze(when.children.map(freezeNode)) }))), ...(node.otherwise ? { otherwise: Object.freeze(node.otherwise.map(freezeNode)) } : {}) });
  if (node.kind === "trim") return Object.freeze({ ...node, attributes: Object.freeze({ ...node.attributes, prefixOverrides: Object.freeze([...node.attributes.prefixOverrides]), suffixOverrides: Object.freeze([...node.attributes.suffixOverrides]) }), children: Object.freeze(node.children.map(freezeNode)) });
  if (node.kind === "identifier" && Array.isArray(node.value)) return Object.freeze({ ...node, value: Object.freeze([...node.value]) });
  if (node.kind === "list") return Object.freeze({ ...node, values: Object.freeze([...node.values]) });
  return Object.freeze(node);
}

const DEFAULT_LEXICAL_PROFILE: DialectLexicalProfile = { lineCommentPrefixes: ["--"], supportsNestedBlockComments: true, supportsDollarQuotes: true, backslashEscapes: true };

export function parseTemplate(strings: TemplateStringsArray, profile: DialectLexicalProfile = DEFAULT_LEXICAL_PROFILE, maxNestingDepth = DEFAULT_LIMITS.maxNestingDepth): TemplateIr {
  if (!Number.isFinite(maxNestingDepth) || maxNestingDepth < 0) throw new SqlRenderError("BRAID_LIMIT", "maxNestingDepth must be a finite non-negative number.");
  const built = buildUnits(strings);
  const parsed = parseSequence(built.units, 0, [], 0, profile, maxNestingDepth);
  return Object.freeze({ version: 1, nodes: Object.freeze(parsed.nodes.map(freezeNode)), sourceLength: built.sourceLength });
}

const templateCache = new WeakMap<object, Map<string, TemplateIr>>();

function profileKey(profile: DialectLexicalProfile, maxNestingDepth: number): string {
  return `${JSON.stringify(profile)}:${maxNestingDepth}`;
}

function cachedTemplate(strings: TemplateStringsArray, profile: DialectLexicalProfile = DEFAULT_LEXICAL_PROFILE, maxNestingDepth = DEFAULT_LIMITS.maxNestingDepth): TemplateIr {
  const key = profileKey(profile, maxNestingDepth);
  const entries = templateCache.get(strings);
  const cached = entries?.get(key);
  if (cached) return cached;
  const parsed = parseTemplate(strings, profile, maxNestingDepth);
  const next = entries ?? new Map<string, TemplateIr>();
  next.set(key, parsed);
  templateCache.set(strings, next);
  return parsed;
}

interface TrimToken {
  readonly kind: "comment" | "string" | "identifier" | "punctuation" | "other";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly depth: number;
}

function trimTokens(text: string): readonly TrimToken[] {
  const tokens: TrimToken[] = [];
  let cursor = 0;
  let depth = 0;
  while (cursor < text.length) {
    const start = cursor;
    const current = text[cursor];
    const next = text[cursor + 1];
    if (/\s/.test(current)) { cursor += 1; continue; }
    if (current === "-" && next === "-") {
      cursor += 2;
      while (cursor < text.length && text[cursor] !== "\n" && text[cursor] !== "\r") cursor += 1;
      tokens.push({ kind: "comment", text: text.slice(start, cursor), start, end: cursor, depth });
      continue;
    }
    if (current === "/" && next === "*") {
      cursor += 2;
      let nested = 1;
      while (cursor < text.length && nested > 0) {
        if (text[cursor] === "/" && text[cursor + 1] === "*") { nested += 1; cursor += 2; continue; }
        if (text[cursor] === "*" && text[cursor + 1] === "/") { nested -= 1; cursor += 2; continue; }
        cursor += 1;
      }
      tokens.push({ kind: "comment", text: text.slice(start, cursor), start, end: cursor, depth });
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      const quote = current;
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") { cursor += 2; continue; }
        if (text[cursor] === quote && text[cursor + 1] === quote) { cursor += 2; continue; }
        if (text[cursor] === quote) { cursor += 1; break; }
        cursor += 1;
      }
      tokens.push({ kind: "string", text: text.slice(start, cursor), start, end: cursor, depth });
      continue;
    }
    if (current === "(") { depth += 1; cursor += 1; tokens.push({ kind: "punctuation", text: current, start, end: cursor, depth: depth - 1 }); continue; }
    if (current === ")") { depth = Math.max(0, depth - 1); cursor += 1; tokens.push({ kind: "punctuation", text: current, start, end: cursor, depth }); continue; }
    if (/[A-Za-z_\p{L}]/u.test(current)) {
      cursor += 1;
      while (cursor < text.length && /[A-Za-z0-9_$\p{L}\p{N}]/u.test(text[cursor])) cursor += 1;
      tokens.push({ kind: "identifier", text: text.slice(start, cursor), start, end: cursor, depth });
      continue;
    }
    cursor += 1;
    tokens.push({ kind: current === "," ? "punctuation" : "other", text: current, start, end: cursor, depth });
  }
  return tokens;
}

function trimOuter(text: string): string {
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) start += 1;
  const tokens = trimTokens(text);
  let end = text.length;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  const last = tokens.at(-1);
  if (last?.kind === "comment" && last.text.startsWith("--")) {
    const newline = text.indexOf("\n", last.end);
    if (newline >= 0) end = newline + 1;
    else end = last.end;
  }
  return text.slice(start, end);
}

function hasSqlToken(text: string): boolean {
  return trimTokens(text).some((token) => token.kind !== "comment");
}

function removeLeadingOverride(text: string, overrides: readonly string[]): string {
  const tokens = trimTokens(text);
  const first = tokens.find((token) => token.kind !== "comment");
  if (!first || first.kind !== "identifier" || !overrides.includes(first.text.toUpperCase())) return text;
  let end = first.end;
  while (end < text.length && /\s/.test(text[end])) end += 1;
  return `${text.slice(0, first.start)}${text.slice(end)}`;
}

function removeTrailingOverride(text: string, overrides: readonly string[]): string {
  if (!overrides.length) return text;
  const tokens = trimTokens(text);
  const candidate = [...tokens].reverse().find((token) => token.kind !== "comment" && token.depth === 0);
  if (!candidate || !overrides.includes(candidate.text.toUpperCase())) return text;
  return `${text.slice(0, candidate.start)}${text.slice(candidate.end)}`;
}

function applyTrim(text: string, attributes: TrimAttributes): string {
  let body = trimOuter(text);
  if (!body) return "";
  body = removeLeadingOverride(body, attributes.prefixOverrides);
  body = removeTrailingOverride(body, attributes.suffixOverrides);
  body = trimOuter(body);
  if (!hasSqlToken(body)) return body;
  return `${attributes.prefix}${body}${attributes.suffix}`;
}

interface RenderState {
  readonly dialect: Dialect;
  readonly limits: Required<RenderLimits>;
  readonly values: unknown[];
  readonly bindingMap: { readonly placeholder: number; readonly interpolation?: number }[];
  readonly output: string[];
  readonly variantPath: string[];
  structuralItems: number;
  depth: number;
  sqlBytes: number;
}

function validateLimits(limits: RenderLimits): Required<RenderLimits> {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, value] of Object.entries(merged)) if (!Number.isFinite(value) || value < 0) throw new SqlRenderError("BRAID_LIMIT", `${key} must be a finite non-negative number.`);
  return merged;
}

function addText(state: RenderState, text: string): void {
  if (!text) return;
  const previous = state.output.at(-1);
  const previousChar = previous?.at(-1);
  const nextChar = text[0];
  if (previousChar && nextChar && /[\p{L}\p{N}_$]/u.test(previousChar) && /[\p{L}\p{N}_$]/u.test(nextChar)) {
    state.output.push(" ");
    state.sqlBytes += 1;
  }
  state.output.push(text);
  state.sqlBytes += Buffer.byteLength(text, "utf8");
  if (state.sqlBytes > state.limits.maxSqlBytes) throw new SqlRenderError("BRAID_SQL_LIMIT", "Rendered SQL exceeds maxSqlBytes.");
}

function addStructural(state: RenderState, count = 1): void {
  state.structuralItems += count;
  if (state.structuralItems > state.limits.maxStructuralItems) throw new SqlRenderError("BRAID_STRUCTURE_LIMIT", "Rendered structural item count exceeds maxStructuralItems.");
}

function addBind(state: RenderState, value: unknown, interpolation?: number): void {
  if (state.values.length >= state.limits.maxBindCount) throw new SqlRenderError("BRAID_BIND_LIMIT", "Rendered bind count exceeds maxBindCount.");
  state.values.push(value);
  const placeholder = state.values.length;
  state.bindingMap.push({ placeholder, ...(interpolation === undefined ? {} : { interpolation }) });
  addText(state, state.dialect.placeholder(placeholder));
}

function renderNodes(nodes: readonly TemplateNode[], captured: readonly unknown[], state: RenderState): void {
  state.depth += 1;
  if (state.depth > state.limits.maxNestingDepth) throw new SqlRenderError("BRAID_DEPTH", "Render nesting limit exceeded.");
  for (const node of nodes) {
    if (node.kind === "text") { addText(state, node.text); continue; }
    if (node.kind === "bind") {
      const value = captured[node.interpolation];
      if (isFragment(value)) renderFragment(value, state);
      else addBind(state, value, node.interpolation);
      continue;
    }
    if (node.kind === "if") {
      const enabled = Boolean(captured[node.condition]);
      state.variantPath.push(`if:${node.condition}:${enabled ? "1" : "0"}`);
      if (enabled) renderNodes(node.children, captured, state);
      continue;
    }
    if (node.kind === "choose") {
      let selected = false;
      for (const [index, when] of node.whens.entries()) {
        if (Boolean(captured[when.condition])) {
          selected = true;
          state.variantPath.push(`when:${index}:${when.condition}`);
          renderNodes(when.children, captured, state);
          break;
        }
      }
      if (!selected && node.otherwise) {
        state.variantPath.push("otherwise");
        renderNodes(node.otherwise, captured, state);
      }
      continue;
    }
    if (node.kind === "trim") {
      const nested: RenderState = { ...state, output: [], bindingMap: state.bindingMap, variantPath: state.variantPath, depth: state.depth, sqlBytes: 0 };
      renderNodes(node.children, captured, nested);
      state.structuralItems = nested.structuralItems;
      const body = applyTrim(nested.output.join(""), node.attributes);
      if (node.attributes.prefix === "SET " && !hasSqlToken(body)) throw new SqlRenderError("BRAID_EMPTY_SET", "@braid set rendered no assignments.");
      addText(state, body);
      continue;
    }
    if (node.kind === "fragment") { renderFragment(node.fragment, state); continue; }
    if (node.kind === "identifier") {
      addStructural(state);
      const parts = typeof node.value === "string" ? node.value.split(".") : node.value;
      addText(state, parts.map((part) => state.dialect.quoteIdentifier(part)).join("."));
      continue;
    }
    if (node.kind === "raw") { addStructural(state); addText(state, node.text); continue; }
    if (node.kind === "list") {
      if (!node.values.length) throw new SqlRenderError("BRAID_EMPTY_LIST", "sql.list([]) has no implicit SQL meaning; guard it or choose an explicit empty strategy.");
      addStructural(state, node.values.length);
      for (const [index, value] of node.values.entries()) {
        if (index) addText(state, ", ");
        addBind(state, value);
      }
    }
  }
  state.depth -= 1;
}

function renderFragment(fragment: SqlFragment, state: RenderState): void {
  if (fragment.dialectId !== state.dialect.id) throw new SqlRenderError("BRAID_DIALECT", `Fragment dialect ${fragment.dialectId} cannot render in ${state.dialect.id}.`);
  addStructural(state);
  renderNodes(fragment.ir.nodes, fragment.values, state);
}

function renderIr(ir: TemplateIr, captured: readonly unknown[], dialect: Dialect, limits?: RenderLimits): RenderedQuery {
  const state: RenderState = { dialect, limits: validateLimits(limits ?? {}), values: [], bindingMap: [], output: [], variantPath: [], structuralItems: 0, depth: 0, sqlBytes: 0 };
  renderNodes(ir.nodes, captured, state);
  const rendered: RenderedQuery = { text: state.output.join(""), values: Object.freeze([...state.values]), variantFingerprint: state.variantPath.join("|") };
  Object.defineProperty(rendered, "bindingMap", { value: Object.freeze(state.bindingMap.map((entry) => Object.freeze(entry))), enumerable: false });
  return Object.freeze(rendered);
}

export function renderTemplateIr(ir: TemplateIr, captured: readonly unknown[], dialect: Dialect = postgresDialect, limits?: RenderLimits): RenderedQuery {
  return renderIr(ir, captured, dialect, limits);
}

function collectConditions(nodes: readonly TemplateNode[], output: Set<number>, local: { value: boolean; seen: boolean }, insideTrim = false): void {
  for (const node of nodes) {
    if (node.kind === "if") {
      output.add(node.condition);
      local.seen = true;
      if (!insideTrim) local.value = false;
      collectConditions(node.children, output, local, insideTrim);
    } else if (node.kind === "choose") {
      for (const when of node.whens) {
        output.add(when.condition);
        local.seen = true;
        if (!insideTrim) local.value = false;
        collectConditions(when.children, output, local, insideTrim);
      }
      if (node.otherwise) collectConditions(node.otherwise, output, local, insideTrim);
    } else if (node.kind === "trim") {
      const isLocal = (node.attributes.prefix === "WHERE " || node.attributes.prefix === "SET ") && localClauseNodes(node.children, node.attributes.prefix);
      collectConditions(node.children, output, local, insideTrim || isLocal);
    }
  }
}

function localClauseNodes(nodes: readonly TemplateNode[], prefix: string): boolean {
  for (const node of nodes) {
    if (node.kind === "if") {
      if (!localClauseNodes(node.children, prefix)) return false;
      continue;
    }
    if (node.kind === "choose") {
      if (node.whens.some((when) => !localClauseNodes(when.children, prefix))) return false;
      if (node.otherwise && !localClauseNodes(node.otherwise, prefix)) return false;
      continue;
    }
    if (node.kind === "trim") return false;
  }
  const text = staticText(nodes);
  const tokens = trimTokens(text).filter((token) => token.kind !== "comment");
  const first = tokens[0]?.text.toUpperCase();
  if (prefix === "WHERE ") return first === "AND" || first === "OR";
  if (prefix === "SET ") return first !== undefined && text.includes("=");
  return false;
}

function staticText(nodes: readonly TemplateNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.kind === "text") parts.push(node.text);
    else if (node.kind === "if") parts.push(staticText(node.children));
    else if (node.kind === "choose") { for (const when of node.whens) parts.push(staticText(when.children)); if (node.otherwise) parts.push(staticText(node.otherwise)); }
  }
  return parts.join("");
}

export interface StructuralAnalysis {
  readonly conditionCount: number;
  readonly estimatedVariants: number | "overflow" | "linear";
  readonly localClauseAnalysis: boolean;
  readonly diagnostics: readonly string[];
}

export function analyzeStructuralVariants(ir: TemplateIr, maxVariants = 256): StructuralAnalysis {
  const conditions = new Set<number>();
  const local = { value: true, seen: false };
  collectConditions(ir.nodes, conditions, local);
  const conditionCount = conditions.size;
  if (local.value && local.seen) return { conditionCount, estimatedVariants: "linear", localClauseAnalysis: true, diagnostics: [] };
  const estimatedVariants = conditionCount > 30 ? "overflow" : 2 ** conditionCount;
  const diagnostics = estimatedVariants !== "overflow" && estimatedVariants > maxVariants ? ["BRAID_VARIANT_LIMIT: structural variant expansion exceeds maxVariants."] : [];
  return { conditionCount, estimatedVariants, localClauseAnalysis: false, diagnostics };
}

export interface StructuralVariant {
  readonly values: readonly unknown[];
  readonly rendered: RenderedQuery;
}

export function renderVariants(ir: TemplateIr, values: readonly unknown[], options: { readonly dialect?: Dialect; readonly limits?: RenderLimits; readonly maxVariants?: number } = {}): readonly StructuralVariant[] {
  const maxVariants = options.maxVariants ?? 256;
  const analysis = analyzeStructuralVariants(ir, maxVariants);
  if (analysis.estimatedVariants === "linear") {
    const rendered = renderIr(ir, values, options.dialect ?? postgresDialect, options.limits);
    return [{ values: Object.freeze([...values]), rendered }];
  }
  if (analysis.estimatedVariants === "overflow" || analysis.estimatedVariants > maxVariants) throw new SqlRenderError("BRAID_VARIANT_LIMIT", "Structural variant expansion exceeds maxVariants.");
  const conditionIndexes = new Set<number>();
  const local = { value: true, seen: false };
  collectConditions(ir.nodes, conditionIndexes, local);
  const indexes = [...conditionIndexes];
  const variants: StructuralVariant[] = [];
  for (let mask = 0; mask < (analysis.estimatedVariants as number); mask += 1) {
    const captured = [...values];
    indexes.forEach((index, position) => { captured[index] = Boolean(mask & (1 << position)); });
    variants.push({ values: Object.freeze([...captured]), rendered: renderIr(ir, captured, options.dialect ?? postgresDialect, options.limits) });
  }
  return Object.freeze(variants);
}

function makeFragment(strings: TemplateStringsArray, values: readonly unknown[], dialect: Dialect, limits: RenderLimits): SqlFragment {
  const fragment = { [SQL_FRAGMENT]: true as const, ir: cachedTemplate(strings, dialect.lexicalProfile, limits.maxNestingDepth), values: Object.freeze([...values]), dialectId: dialect.id };
  knownFragments.add(fragment);
  return Object.freeze(fragment);
}

function makeStaticFragment(nodes: readonly TemplateNode[], sourceLength: number, dialect: Dialect): SqlFragment {
  const fragment = { [SQL_FRAGMENT]: true as const, ir: Object.freeze({ version: 1 as const, nodes: Object.freeze(nodes.map(freezeNode)), sourceLength }), values: Object.freeze([]), dialectId: dialect.id };
  knownFragments.add(fragment);
  return Object.freeze(fragment);
}

export interface SqlTagOptions {
  readonly dialect?: Dialect;
  readonly limits?: RenderLimits;
}

export function createSqlTag(options: SqlTagOptions = {}): SqlTag {
  const dialect = options.dialect ?? postgresDialect;
  const limits = validateLimits(options.limits ?? {});
  const tag = ((strings: TemplateStringsArray, ...values: readonly unknown[]): Query<unknown> => {
    const ir = cachedTemplate(strings, dialect.lexicalProfile, limits.maxNestingDepth);
    const captured = Object.freeze([...values]);
    return Object.freeze({ ir, values: captured, resultKind: "rows" as const, render: () => renderIr(ir, captured, dialect, limits) });
  }) as SqlTag;
  tag.fragment = (strings, ...values) => makeFragment(strings, values, dialect, limits);
  tag.empty = makeStaticFragment([], 0, dialect);
  tag.ident = (identifier) => makeStaticFragment([{ kind: "identifier", value: typeof identifier === "string" ? identifier : Object.freeze([...identifier]), range: { start: 0, end: 0 } }], 0, dialect);
  tag.raw = (text) => makeStaticFragment([{ kind: "raw", text, range: { start: 0, end: text.length } }], text.length, dialect);
  tag.join = (items, separator = tag.empty) => {
    if (!items.every(isFragment) || !isFragment(separator)) throw new SqlRenderError("BRAID_FRAGMENT", "sql.join accepts SQLBraid fragments only.");
    const nodes: TemplateNode[] = [];
    items.forEach((item, index) => {
      if (item.dialectId !== dialect.id || separator.dialectId !== dialect.id) throw new SqlRenderError("BRAID_DIALECT", "Cannot join fragments from another dialect.");
      if (index) nodes.push({ kind: "fragment", fragment: separator, range: { start: 0, end: 0 } });
      nodes.push({ kind: "fragment", fragment: item, range: { start: 0, end: 0 } });
    });
    return makeStaticFragment(nodes, 0, dialect);
  };
  tag.list = (values) => {
    if (!Array.isArray(values)) throw new SqlRenderError("BRAID_LIST", "sql.list requires an array.");
    for (let index = 0; index < values.length; index += 1) if (!Object.hasOwn(values, index)) throw new SqlRenderError("BRAID_LIST", "sql.list does not accept sparse arrays.");
    if (values.some(isFragment)) throw new SqlRenderError("BRAID_LIST", "sql.list accepts bind values only; use sql.join for structural fragments.");
    if (!values.length) throw new SqlRenderError("BRAID_EMPTY_LIST", "sql.list([]) has no implicit SQL meaning; guard it or choose an explicit empty strategy.");
    return makeStaticFragment([{ kind: "list", values: Object.freeze([...values]), range: { start: 0, end: 0 } }], 0, dialect);
  };
  return tag;
}

function createTemplateStrings(values: readonly string[]): TemplateStringsArray {
  const strings = [...values] as string[] & { raw?: readonly string[] };
  strings.raw = [...values];
  return strings as unknown as TemplateStringsArray;
}

function hasGuard(nodes: readonly TemplateNode[]): boolean {
  return nodes.some((node) => node.kind === "if" || (node.kind === "choose" && (node.whens.some((when) => hasGuard(when.children)) || Boolean(node.otherwise && hasGuard(node.otherwise)))) || (node.kind === "trim" && hasGuard(node.children)));
}

function captureActive(nodes: readonly TemplateNode[], thunks: readonly (() => unknown)[], values: unknown[], evaluated = new Set<number>()): void {
  for (const node of nodes) {
    if (node.kind === "bind") {
      if (!evaluated.has(node.interpolation) && node.interpolation < thunks.length) {
        values[node.interpolation] = thunks[node.interpolation]();
        evaluated.add(node.interpolation);
      }
      continue;
    }
    if (node.kind === "if") {
      if (!evaluated.has(node.condition)) {
        values[node.condition] = thunks[node.condition]();
        evaluated.add(node.condition);
      }
      if (Boolean(values[node.condition])) captureActive(node.children, thunks, values, evaluated);
      continue;
    }
    if (node.kind === "choose") {
      let selected = false;
      for (const when of node.whens) {
        if (!evaluated.has(when.condition)) {
          values[when.condition] = thunks[when.condition]();
          evaluated.add(when.condition);
        }
        if (Boolean(values[when.condition])) { captureActive(when.children, thunks, values, evaluated); selected = true; break; }
      }
      if (!selected && node.otherwise) captureActive(node.otherwise, thunks, values, evaluated);
      continue;
    }
    if (node.kind === "trim") { captureActive(node.children, thunks, values, evaluated); continue; }
  }
}

export function guarded(tag: SqlTag, strings: readonly string[], thunks: readonly (() => unknown)[]): Query<unknown> {
  const templateStrings = createTemplateStrings(strings);
  const ir = cachedTemplate(templateStrings);
  if (!hasGuard(ir.nodes)) return tag(templateStrings, ...thunks.map((thunk) => thunk()));
  const values = new Array<unknown>(Math.max(0, strings.length - 1));
  captureActive(ir.nodes, thunks, values);
  return tag(templateStrings, ...values);
}

export function capture(tag: SqlTag, strings: readonly string[], build: (values: unknown[]) => void): Query<unknown> {
  const captured = new Array<unknown>(Math.max(0, strings.length - 1));
  build(captured);
  const templateStrings = createTemplateStrings(strings);
  return tag(templateStrings, ...captured);
}

export const sql = createSqlTag();
export { SqlRenderError };
