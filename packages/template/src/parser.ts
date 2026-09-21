import {
  SqlRenderError,
  type DialectLexicalProfile,
  type SourceRange,
  type TemplateIr,
  type TemplateNode,
} from "@sqlbraid/core";
import {
  DEFAULT_LEXICAL_PROFILE,
  DEFAULT_LIMITS,
  appendTextNodes,
  buildUnits,
  decodeTemplateRawSegment,
  scanNext,
  type DirectiveToken,
  type Unit,
} from "./lexical.js";
import { parseAttributes } from "./trim.js";

interface ParseResult {
  readonly nodes: readonly TemplateNode[];
  readonly next: number;
  readonly stop?: DirectiveToken;
}

function conditionOf(directive: DirectiveToken): number {
  if (directive.holes.length !== 1 || directive.text.trim())
    throw new SqlRenderError("BRAID_CONDITION", "Directive condition must contain exactly one interpolation.");
  return directive.holes[0];
}

function parseSequence(
  units: readonly Unit[],
  start: number,
  stopNames: readonly string[],
  depth: number,
  profile: DialectLexicalProfile,
  maxNestingDepth: number,
): ParseResult {
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
      if (!child.stop || child.stop.name !== "end")
        throw new SqlRenderError("BRAID_STRUCTURE", "Missing @braid end for if.");
      nodes.push({ kind: "if", condition, children: child.nodes, range: { start: token.start, end: child.next } });
      cursor = child.next;
      continue;
    }
    if (token.name === "choose") {
      const whens: { condition: number; children: readonly TemplateNode[]; range: SourceRange }[] = [];
      let otherwise: readonly TemplateNode[] | undefined;
      let branch = parseSequence(units, token.end, ["when", "otherwise", "end"], depth + 1, profile, maxNestingDepth);
      if (!branch.stop) throw new SqlRenderError("BRAID_STRUCTURE", "Missing @braid end for choose.");
      if (branch.nodes.some((node) => node.kind !== "text" || node.text.trim()))
        throw new SqlRenderError("BRAID_STRUCTURE", "Choose must begin with when or otherwise.");
      let stop = branch.stop;
      while (stop.name === "when") {
        const condition = conditionOf(stop);
        const content = parseSequence(
          units,
          branch.next,
          ["when", "otherwise", "end"],
          depth + 1,
          profile,
          maxNestingDepth,
        );
        whens.push({ condition, children: content.nodes, range: { start: stop.start, end: content.next } });
        if (!content.stop) throw new SqlRenderError("BRAID_STRUCTURE", "Missing branch terminator in choose.");
        branch = content;
        stop = content.stop;
      }
      if (stop.name === "otherwise") {
        if (stop.holes.length || stop.text.trim())
          throw new SqlRenderError("BRAID_STRUCTURE", "otherwise does not accept a condition.");
        const content = parseSequence(units, branch.next, ["end"], depth + 1, profile, maxNestingDepth);
        if (!content.stop || content.stop.name !== "end")
          throw new SqlRenderError("BRAID_STRUCTURE", "Missing @braid end for otherwise.");
        otherwise = content.nodes;
        branch = content;
        stop = content.stop;
      }
      if (stop.name !== "end")
        throw new SqlRenderError("BRAID_STRUCTURE", `Unexpected choose directive: ${stop.name}.`);
      nodes.push({
        kind: "choose",
        whens,
        ...(otherwise === undefined ? {} : { otherwise }),
        range: { start: token.start, end: branch.next },
      });
      cursor = branch.next;
      continue;
    }
    if (token.name === "where" || token.name === "set" || token.name === "trim") {
      if (token.name !== "trim" && (token.holes.length || token.text.trim()))
        throw new SqlRenderError("BRAID_ATTRIBUTES", `${token.name} does not accept attributes.`);
      const child = parseSequence(units, token.end, ["end"], depth + 1, profile, maxNestingDepth);
      if (!child.stop || child.stop.name !== "end")
        throw new SqlRenderError("BRAID_STRUCTURE", `Missing @braid end for ${token.name}.`);
      const attributes =
        token.name === "where"
          ? { prefix: "WHERE ", prefixOverrides: ["AND", "OR"], suffix: "", suffixOverrides: [] }
          : token.name === "set"
            ? { prefix: "SET ", prefixOverrides: [], suffix: "", suffixOverrides: [","] }
            : parseAttributes(token.text);
      nodes.push({ kind: "trim", attributes, children: child.nodes, range: { start: token.start, end: child.next } });
      cursor = child.next;
      continue;
    }
    if (token.name === "when" || token.name === "otherwise")
      throw new SqlRenderError("BRAID_STRUCTURE", `${token.name} is only valid inside choose.`);
    throw new SqlRenderError("BRAID_DIRECTIVE", `Unknown @braid directive: ${token.name}.`);
  }
  return { nodes, next: cursor };
}

export function freezeNode(node: TemplateNode): TemplateNode {
  if (node.kind === "if") return Object.freeze({ ...node, children: Object.freeze(node.children.map(freezeNode)) });
  if (node.kind === "choose")
    return Object.freeze({
      ...node,
      whens: Object.freeze(
        node.whens.map((when) => Object.freeze({ ...when, children: Object.freeze(when.children.map(freezeNode)) })),
      ),
      ...(node.otherwise ? { otherwise: Object.freeze(node.otherwise.map(freezeNode)) } : {}),
    });
  if (node.kind === "trim")
    return Object.freeze({
      ...node,
      attributes: Object.freeze({
        ...node.attributes,
        prefixOverrides: Object.freeze([...node.attributes.prefixOverrides]),
        suffixOverrides: Object.freeze([...node.attributes.suffixOverrides]),
      }),
      children: Object.freeze(node.children.map(freezeNode)),
    });
  if (node.kind === "identifier" && Array.isArray(node.value))
    return Object.freeze({ ...node, value: Object.freeze([...node.value]) });
  if (node.kind === "list") return Object.freeze({ ...node, values: Object.freeze([...node.values]) });
  return Object.freeze(node);
}

export function freezeTemplateIr(ir: TemplateIr): TemplateIr {
  return Object.freeze({
    version: ir.version,
    nodes: Object.freeze(ir.nodes.map(freezeNode)),
    sourceLength: ir.sourceLength,
    ...(ir.rawNodes === undefined ? {} : { rawNodes: Object.freeze(ir.rawNodes.map(freezeNode)) }),
  });
}

export function sameTemplateShape(left: readonly TemplateNode[], right: readonly TemplateNode[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftNode = left[index];
    const rightNode = right[index];
    if (leftNode.kind !== rightNode.kind) return false;
    if (leftNode.kind === "bind") {
      if (rightNode.kind !== "bind" || leftNode.interpolation !== rightNode.interpolation) return false;
      continue;
    }
    if (leftNode.kind === "if") {
      if (
        rightNode.kind !== "if" ||
        leftNode.condition !== rightNode.condition ||
        !sameTemplateShape(leftNode.children, rightNode.children)
      )
        return false;
      continue;
    }
    if (leftNode.kind === "choose") {
      if (rightNode.kind !== "choose" || leftNode.whens.length !== rightNode.whens.length) return false;
      for (let whenIndex = 0; whenIndex < leftNode.whens.length; whenIndex += 1) {
        const leftWhen = leftNode.whens[whenIndex];
        const rightWhen = rightNode.whens[whenIndex];
        if (leftWhen.condition !== rightWhen.condition || !sameTemplateShape(leftWhen.children, rightWhen.children))
          return false;
      }
      if ((leftNode.otherwise === undefined) !== (rightNode.otherwise === undefined)) return false;
      if (leftNode.otherwise && rightNode.otherwise && !sameTemplateShape(leftNode.otherwise, rightNode.otherwise))
        return false;
      continue;
    }
    if (leftNode.kind === "trim") {
      if (rightNode.kind !== "trim" || !sameTemplateShape(leftNode.children, rightNode.children)) return false;
      continue;
    }
    if (
      leftNode.kind === "fragment" ||
      leftNode.kind === "identifier" ||
      leftNode.kind === "raw" ||
      leftNode.kind === "list"
    )
      continue;
  }
  return true;
}

/**
 * Parse one tagged template using the supplied dialect lexical profile.
 * The returned IR is frozen and source-ranged.
 *
 * @throws {SqlRenderError} For unterminated directives, lexical violations, or nesting-limit breaches.
 */
export function parseTemplate(
  strings: TemplateStringsArray,
  profile: DialectLexicalProfile = DEFAULT_LEXICAL_PROFILE,
  maxNestingDepth = DEFAULT_LIMITS.maxNestingDepth,
): TemplateIr {
  if (!Number.isFinite(maxNestingDepth) || maxNestingDepth < 0)
    throw new SqlRenderError("BRAID_LIMIT", "maxNestingDepth must be a finite non-negative number.");
  const built = buildUnits(strings);
  const parsed = parseSequence(built.units, 0, [], 0, profile, maxNestingDepth);
  const raw = Array.isArray(strings.raw) ? strings.raw : strings;
  let rawNodes: readonly TemplateNode[] | undefined;
  if (raw.some((value, index) => value !== strings[index])) {
    try {
      const parsedRaw = parseSequence(buildUnits(raw).units, 0, [], 0, profile, maxNestingDepth).nodes;
      if (sameTemplateShape(parsed.nodes, parsedRaw)) rawNodes = parsedRaw.map(freezeNode);
    } catch (error) {
      // Raw JavaScript escape spelling need not have the cooked SQL's lexical shape.
      if (!(error instanceof SqlRenderError)) throw error;
    }
  }
  return Object.freeze({
    version: 1,
    nodes: Object.freeze(parsed.nodes.map(freezeNode)),
    sourceLength: built.sourceLength,
    ...(rawNodes === undefined ? {} : { rawNodes: Object.freeze(rawNodes) }),
  });
}

export const templateCache = new WeakMap<object, Map<string, TemplateIr>>();
export const nativeLexicalCache = new WeakMap<object, Map<string, true>>();

function profileKey(profile: DialectLexicalProfile, maxNestingDepth: number): string {
  return `${JSON.stringify(profile)}:${maxNestingDepth}`;
}

export function cachedTemplate(
  strings: TemplateStringsArray,
  profile: DialectLexicalProfile = DEFAULT_LEXICAL_PROFILE,
  maxNestingDepth = DEFAULT_LIMITS.maxNestingDepth,
): TemplateIr {
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

export function validateNativeTemplateParts(strings: readonly string[], profile: DialectLexicalProfile): void {
  const units = buildUnits(strings).units;
  let cursor = 0;
  while (cursor < units.length) {
    const token = scanNext(units, cursor, profile);
    if (token.end <= cursor) throw new SqlRenderError("BRAID_SQL_LEX", "Template lexical validation did not advance.");
    cursor = token.end;
  }
}

export function validateNativeTemplate(strings: TemplateStringsArray, profile: DialectLexicalProfile): void {
  const key = JSON.stringify(profile);
  const raw = (strings as { readonly raw?: unknown }).raw;
  const hasDistinctRaw = Array.isArray(raw) && (raw as unknown) !== strings;
  const cacheable = Object.isFrozen(strings) && (!Array.isArray(raw) || Object.isFrozen(raw));
  if (cacheable && nativeLexicalCache.get(strings)?.has(key)) return;
  validateNativeTemplateParts(strings, profile);
  // `.raw` contains JavaScript source spelling. Decode its escapes before
  // applying SQL lexical rules so an escaped template delimiter is not
  // mistaken for a SQL backslash escape.
  if (hasDistinctRaw) validateNativeTemplateParts(raw.map(decodeTemplateRawSegment), profile);
  if (!cacheable) return;
  const entries = nativeLexicalCache.get(strings) ?? new Map<string, true>();
  entries.set(key, true);
  nativeLexicalCache.set(strings, entries);
}
