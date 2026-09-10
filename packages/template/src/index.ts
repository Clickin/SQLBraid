import {
  BindNode,
  ChooseNode,
  Dialect,
  IfNode,
  ListNode,
  Query,
  RenderLimits,
  RenderedQuery,
  SqlFragment,
  SqlRenderError,
  SqlTag,
  SourceRange,
  TemplateIr,
  TemplateNode,
  TrimAttributes,
  TrimNode,
  SQL_FRAGMENT,
} from "../../core/src/index.js";

const MARKER_START = "\u0000";
const MARKER_END = "\u0000";
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
};

const isFragment = (value: unknown): value is SqlFragment =>
  typeof value === "object" && value !== null && (value as Partial<SqlFragment>)[SQL_FRAGMENT] === true;

const marker = (index: number): string => `${MARKER_START}${index}${MARKER_END}`;

function buildSource(strings: TemplateStringsArray): { source: string; sourceLength: number } {
  let source = "";
  for (let index = 0; index < strings.length; index += 1) {
    source += strings[index];
    if (index < strings.length - 1) source += marker(index);
  }
  return { source, sourceLength: source.length };
}

function markerIndex(value: string): number | undefined {
  const match = /^\u0000(\d+)\u0000$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function directiveEnd(source: string, start: number): number {
  const end = source.indexOf("*/", start + 8);
  if (end < 0) throw new SqlRenderError("BRAID_DIRECTIVE_UNTERMINATED", "Unterminated /*@braid directive.");
  return end + 2;
}

function directiveBody(source: string, start: number, end: number): string {
  return source.slice(start + 8, end - 2).trim();
}

interface ParseResult {
  readonly nodes: readonly TemplateNode[];
  readonly next: number;
  readonly stop?: string;
}

function parseMarker(text: string, sourceOffset: number): number {
  const index = markerIndex(text);
  if (index === undefined) {
    throw new SqlRenderError("BRAID_CONDITION", `Directive condition must contain exactly one interpolation at ${sourceOffset}.`);
  }
  return index;
}

function splitDirective(body: string): { name: string; rest: string } {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) throw new SqlRenderError("BRAID_DIRECTIVE", "Empty @braid directive.");
  return { name: match[1], rest: match[2] ?? "" };
}

function parseAttributes(text: string): TrimAttributes {
  const attributes: Record<string, string> = {};
  const pattern = /(prefix|prefixOverrides|suffix|suffixOverrides)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
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

function appendTextNodes(nodes: TemplateNode[], text: string, start: number): void {
  const pattern = /\u0000(\d+)\u0000/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push({ kind: "text", text: text.slice(cursor, match.index), range: { start: start + cursor, end: start + match.index } });
    const markerEnd = match.index + match[0].length;
    nodes.push({ kind: "bind", interpolation: Number(match[1]), range: { start: start + match.index, end: start + markerEnd } });
    cursor = markerEnd;
  }
  if (cursor < text.length) nodes.push({ kind: "text", text: text.slice(cursor), range: { start: start + cursor, end: start + text.length } });
}

function parseSequence(source: string, start: number, stopNames: readonly string[], depth: number): ParseResult {
  if (depth > DEFAULT_LIMITS.maxNestingDepth) throw new SqlRenderError("BRAID_DEPTH", "Template nesting limit exceeded.");
  const nodes: TemplateNode[] = [];
  let cursor = start;
  while (cursor < source.length) {
    const directive = source.indexOf("/*@braid", cursor);
    if (directive < 0) {
      if (cursor < source.length) appendTextNodes(nodes, source.slice(cursor), cursor);
      return { nodes, next: source.length };
    }
    if (directive > cursor) appendTextNodes(nodes, source.slice(cursor, directive), cursor);
    const end = directiveEnd(source, directive);
    const body = directiveBody(source, directive, end);
    const { name, rest } = splitDirective(body);
    if (stopNames.includes(name)) return { nodes, next: end, stop: body };
    if (name === "end") throw new SqlRenderError("BRAID_STRUCTURE", "Unexpected @braid end.");
    if (name === "if") {
      const condition = parseMarker(rest, directive);
      const child = parseSequence(source, end, ["end"], depth + 1);
      if (child.stop !== "end") throw new SqlRenderError("BRAID_STRUCTURE", "Missing @braid end for if.");
      nodes.push({ kind: "if", condition, children: child.nodes, range: { start: directive, end: child.next } });
      cursor = child.next;
      continue;
    }
    if (name === "choose") {
      const whens: { condition: number; children: readonly TemplateNode[]; range: SourceRange }[] = [];
      let otherwise: readonly TemplateNode[] | undefined;
      let branch = parseSequence(source, end, ["when", "otherwise", "end"], depth + 1);
      if (!branch.stop) throw new SqlRenderError("BRAID_STRUCTURE", "Missing @braid end for choose.");
      let stop = splitDirective(branch.stop);
      if (branch.nodes.some((node) => node.kind !== "text" || node.text.trim())) throw new SqlRenderError("BRAID_STRUCTURE", "Choose must begin with when or otherwise.");
      while (stop.name === "when") {
        const condition = parseMarker(stop.rest, branch.next);
        const content = parseSequence(source, branch.next, ["when", "otherwise", "end"], depth + 1);
        if (!content.stop) throw new SqlRenderError("BRAID_STRUCTURE", "Missing branch terminator in choose.");
        whens.push({ condition, children: content.nodes, range: { start: branch.next, end: content.next } });
        branch = content;
        if (!branch.stop) throw new SqlRenderError("BRAID_STRUCTURE", "Missing branch terminator in choose.");
        stop = splitDirective(branch.stop);
      }
      if (stop.name === "otherwise") {
        const content = parseSequence(source, branch.next, ["end"], depth + 1);
        if (content.stop !== "end") throw new SqlRenderError("BRAID_STRUCTURE", "Missing @braid end for otherwise.");
        otherwise = content.nodes;
        branch = content;
      }
      if (stop.name !== "end" && stop.name !== "otherwise") throw new SqlRenderError("BRAID_STRUCTURE", `Unexpected choose directive: ${stop.name}.`);
      nodes.push({ kind: "choose", whens, ...(otherwise === undefined ? {} : { otherwise }), range: { start: directive, end: branch.next } });
      cursor = branch.next;
      continue;
    }
    if (name === "where" || name === "set" || name === "trim") {
      const child = parseSequence(source, end, ["end"], depth + 1);
      if (child.stop !== "end") throw new SqlRenderError("BRAID_STRUCTURE", `Missing @braid end for ${name}.`);
      const attrs = name === "where"
        ? { prefix: "WHERE ", prefixOverrides: ["AND", "OR"], suffix: "", suffixOverrides: [] }
        : name === "set"
          ? { prefix: "SET ", prefixOverrides: [], suffix: "", suffixOverrides: [","] }
          : parseAttributes(rest);
      nodes.push({ kind: "trim", attributes: attrs, children: child.nodes, range: { start: directive, end: child.next } });
      cursor = child.next;
      continue;
    }
    if (name === "when" || name === "otherwise") throw new SqlRenderError("BRAID_STRUCTURE", `${name} is only valid inside choose.`);
    throw new SqlRenderError("BRAID_DIRECTIVE", `Unknown @braid directive: ${name}.`);
  }
  return { nodes, next: cursor };
}

export function parseTemplate(strings: TemplateStringsArray): TemplateIr {
  const { source, sourceLength } = buildSource(strings);
  const parsed = parseSequence(source, 0, [], 0);
  return { version: 1, nodes: parsed.nodes, sourceLength };
}

const templateCache = new WeakMap<TemplateStringsArray, TemplateIr>();

function cachedTemplate(strings: TemplateStringsArray): TemplateIr {
  const cached = templateCache.get(strings);
  if (cached) return cached;
  const parsed = parseTemplate(strings);
  templateCache.set(strings, parsed);
  return parsed;
}

function trimComment(source: string, start: number): number {
  if (source.startsWith("--", start)) {
    const line = source.indexOf("\n", start + 2);
    return line < 0 ? source.length : line + 1;
  }
  if (source.startsWith("/*", start)) {
    const end = source.indexOf("*/", start + 2);
    return end < 0 ? source.length : end + 2;
  }
  return start;
}

function removeLeadingOverrides(text: string, overrides: readonly string[]): string {
  let cursor = 0;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    const next = trimComment(text, cursor);
    if (next === cursor) break;
    cursor = next;
  }
  const match = /^[A-Za-z]+/.exec(text.slice(cursor));
  if (!match || !overrides.includes(match[0].toUpperCase())) return text;
  const after = cursor + match[0].length;
  if (/[A-Za-z0-9_$]/.test(text[after] ?? "")) return text;
  return `${text.slice(0, cursor)}${text.slice(after).replace(/^\s+/, "")}`;
}

function topLevelTrailingOverride(text: string, overrides: readonly string[]): string {
  if (!overrides.length) return text;
  let depth = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  let candidate = -1;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (current === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (current === "-" && next === "-") { lineComment = true; index += 1; continue; }
    if (current === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (current === "'" || current === '"' || current === "`" || current === "[") { quote = current === "[" ? "]" : current; continue; }
    if (current === "(") { depth += 1; continue; }
    if (current === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && overrides.includes(current)) candidate = index;
  }
  if (candidate < 0) return text;
  const suffix = text.slice(candidate + 1);
  if (!/^(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$))*$/.test(suffix)) return text;
  return `${text.slice(0, candidate)}${suffix}`;
}

function applyTrim(text: string, attributes: TrimAttributes): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  let body = removeLeadingOverrides(trimmed, attributes.prefixOverrides);
  if (attributes.suffixOverrides.length) body = topLevelTrailingOverride(body, attributes.suffixOverrides);
  body = body.trim();
  return body ? `${attributes.prefix}${body}${attributes.suffix}` : "";
}

interface RenderState {
  readonly dialect: Dialect;
  readonly limits: Required<RenderLimits>;
  readonly values: unknown[];
  readonly output: string[];
  readonly activeVariant: string[];
  readonly variantPath: string[];
  depth: number;
}

function addText(state: RenderState, text: string): void {
  state.output.push(text);
  if (state.output.join("").length > state.limits.maxSqlBytes) throw new SqlRenderError("BRAID_SQL_LIMIT", "Rendered SQL exceeds maxSqlBytes.");
}

function addBind(state: RenderState, value: unknown): void {
  if (state.values.length >= state.limits.maxBindCount) throw new SqlRenderError("BRAID_BIND_LIMIT", "Rendered bind count exceeds maxBindCount.");
  state.values.push(value);
  addText(state, state.dialect.placeholder(state.values.length));
}

function renderNodes(nodes: readonly TemplateNode[], captured: readonly unknown[], state: RenderState): void {
  state.depth += 1;
  if (state.depth > state.limits.maxNestingDepth) throw new SqlRenderError("BRAID_DEPTH", "Render nesting limit exceeded.");
  for (const node of nodes) {
    if (node.kind === "text") { addText(state, node.text); continue; }
    if (node.kind === "bind") {
      const value = captured[node.interpolation];
      if (isFragment(value)) renderFragment(value, state);
      else addBind(state, value);
      continue;
    }
    if (node.kind === "if") {
      const enabled = Boolean(captured[node.condition]);
      state.activeVariant.push(enabled ? "1" : "0");
      state.variantPath.push(`if:${node.condition}:${enabled ? "1" : "0"}`);
      if (enabled) renderNodes(node.children, captured, state);
      state.activeVariant.pop();
      continue;
    }
    if (node.kind === "choose") {
      let selected = false;
      for (const when of node.whens) {
        if (Boolean(captured[when.condition])) { selected = true; state.activeVariant.push("w"); state.variantPath.push(`when:${when.condition}`); renderNodes(when.children, captured, state); state.activeVariant.pop(); break; }
      }
      if (!selected && node.otherwise) { state.activeVariant.push("o"); state.variantPath.push("otherwise"); renderNodes(node.otherwise, captured, state); state.activeVariant.pop(); }
      continue;
    }
    if (node.kind === "trim") {
      const nested: RenderState = { ...state, output: [], values: state.values, activeVariant: state.activeVariant, variantPath: state.variantPath, depth: state.depth };
      renderNodes(node.children, captured, nested);
      addText(state, applyTrim(nested.output.join(""), node.attributes));
      continue;
    }
    if (node.kind === "fragment") { renderFragment(node.fragment, state); continue; }
    if (node.kind === "identifier") {
      const parts = typeof node.value === "string" ? node.value.split(".") : node.value;
      addText(state, parts.map((part) => state.dialect.quoteIdentifier(part)).join("."));
      continue;
    }
    if (node.kind === "raw") { addText(state, node.text); continue; }
    if (node.kind === "list") {
      if (node.values.length > state.limits.maxStructuralItems) throw new SqlRenderError("BRAID_STRUCTURE_LIMIT", "List exceeds maxStructuralItems.");
      if (!node.values.length) { addText(state, "NULL"); continue; }
      node.values.forEach((value, index) => {
        if (index) addText(state, ", ");
        addBind(state, value);
      });
    }
  }
  state.depth -= 1;
}

function renderFragment(fragment: SqlFragment, state: RenderState): void {
  renderNodes(fragment.ir.nodes, fragment.values, state);
}

function renderIr(ir: TemplateIr, captured: readonly unknown[], dialect: Dialect, limits?: RenderLimits): RenderedQuery {
  const merged: Required<RenderLimits> = { ...DEFAULT_LIMITS, ...limits };
  const state: RenderState = { dialect, limits: merged, values: [], output: [], activeVariant: [], variantPath: [], depth: 0 };
  renderNodes(ir.nodes, captured, state);
  return { text: state.output.join(""), values: state.values, variantFingerprint: state.variantPath.join("|") };
}

function collectConditions(nodes: readonly TemplateNode[], output: Set<number>, insideTrim = false, outsideTrim: { value: boolean } = { value: false }): void {
  for (const node of nodes) {
    if (node.kind === "if") {
      output.add(node.condition);
      if (!insideTrim) outsideTrim.value = true;
      collectConditions(node.children, output, insideTrim, outsideTrim);
    } else if (node.kind === "choose") {
      for (const when of node.whens) {
        output.add(when.condition);
        if (!insideTrim) outsideTrim.value = true;
        collectConditions(when.children, output, insideTrim, outsideTrim);
      }
      if (node.otherwise) collectConditions(node.otherwise, output, insideTrim, outsideTrim);
    } else if (node.kind === "trim") collectConditions(node.children, output, true, outsideTrim);
  }
}

export interface StructuralAnalysis {
  readonly conditionCount: number;
  readonly estimatedVariants: number | "overflow";
  readonly localClauseAnalysis: boolean;
  readonly diagnostics: readonly string[];
}

export function analyzeStructuralVariants(ir: TemplateIr, maxVariants = 256): StructuralAnalysis {
  const conditions = new Set<number>();
  const outsideTrim = { value: false };
  collectConditions(ir.nodes, conditions, false, outsideTrim);
  const conditionCount = conditions.size;
  const estimatedVariants = conditionCount > 30 ? "overflow" : 2 ** conditionCount;
  const diagnostics = estimatedVariants !== "overflow" && estimatedVariants > maxVariants && outsideTrim.value ? ["BRAID_VARIANT_LIMIT: structural variant expansion exceeds maxVariants."] : [];
  return { conditionCount, estimatedVariants, localClauseAnalysis: !outsideTrim.value, diagnostics };
}

export interface StructuralVariant {
  readonly values: readonly unknown[];
  readonly rendered: RenderedQuery;
}

export function renderVariants(ir: TemplateIr, values: readonly unknown[], options: { readonly dialect?: Dialect; readonly limits?: RenderLimits; readonly maxVariants?: number } = {}): readonly StructuralVariant[] {
  const analysis = analyzeStructuralVariants(ir, options.maxVariants ?? 256);
  if (analysis.estimatedVariants === "overflow" || analysis.estimatedVariants > (options.maxVariants ?? 256)) throw new SqlRenderError("BRAID_VARIANT_LIMIT", "Structural variant expansion exceeds maxVariants.");
  const conditionIndexes = new Set<number>();
  collectConditions(ir.nodes, conditionIndexes);
  const indexes = [...conditionIndexes];
  const variants: StructuralVariant[] = [];
  for (let mask = 0; mask < (analysis.estimatedVariants as number); mask += 1) {
    const captured = [...values];
    indexes.forEach((index, position) => { captured[index] = Boolean(mask & (1 << position)); });
    const rendered = renderIr(ir, captured, options.dialect ?? postgresDialect, options.limits);
    variants.push({ values: captured, rendered });
  }
  return variants;
}

function makeFragment(strings: TemplateStringsArray, values: readonly unknown[], dialect: Dialect, limits: RenderLimits): SqlFragment {
  return Object.freeze({ [SQL_FRAGMENT]: true as const, ir: cachedTemplate(strings), values: Object.freeze([...values]), dialect, limits });
}

function makeStaticFragment(nodes: readonly TemplateNode[], sourceLength: number, dialect: Dialect, limits: RenderLimits): SqlFragment {
  return Object.freeze({
    [SQL_FRAGMENT]: true as const,
    ir: { version: 1 as const, nodes, sourceLength },
    values: Object.freeze([]),
    dialect,
    limits,
  });
}

export interface SqlTagOptions {
  readonly dialect?: Dialect;
  readonly limits?: RenderLimits;
}

export function createSqlTag(options: SqlTagOptions = {}): SqlTag {
  const dialect = options.dialect ?? postgresDialect;
  const limits = options.limits ?? {};
  const tag = ((strings: TemplateStringsArray, ...values: readonly unknown[]): Query => {
    const ir = cachedTemplate(strings);
    return Object.freeze({
      ir,
      values: Object.freeze([...values]),
      render: () => renderIr(ir, values, dialect, limits),
    });
  }) as SqlTag;
  tag.fragment = (strings, ...values) => makeFragment(strings, values, dialect, limits);
  tag.empty = makeStaticFragment([], 0, dialect, limits);
  tag.ident = (identifier) => makeStaticFragment([{ kind: "identifier", value: identifier, range: { start: 0, end: 0 } }], 0, dialect, limits);
  tag.raw = (text) => makeStaticFragment([{ kind: "raw", text, range: { start: 0, end: text.length } }], text.length, dialect, limits);
  tag.join = (items, separator = tag.empty) => makeStaticFragment(items.flatMap((item, index) => index ? [{ kind: "fragment", fragment: separator, range: { start: 0, end: 0 } }, { kind: "fragment", fragment: item, range: { start: 0, end: 0 } }] : [{ kind: "fragment", fragment: item, range: { start: 0, end: 0 } }]), 0, dialect, limits);
  tag.list = (values) => makeStaticFragment([{ kind: "list", values, range: { start: 0, end: 0 } }], 0, dialect, limits);
  return tag;
}

export const sql = createSqlTag();
export { SqlRenderError };
