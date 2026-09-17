import {
  SQL_FRAGMENT,
  createBoundParameter,
  createRoutineInOutParameter,
  createRoutineOutParameter,
  createRenderedStatement,
  isBoundParameter,
  isRoutineParameter,
  type Dialect,
  type DialectLexicalProfile,
  type Query,
  type QueryResultKind,
  type RoutineContract,
  type RenderLimits,
  type RenderedParameter,
  type RenderedStatement,
  type ParameterTypeHint,
  type StandardSchemaV1,
  type SqlFragment,
  SqlRenderError,
  type SqlTag,
  type SqlTagLike,
  type SourceRange,
  type TemplateIr,
  type TemplateNode,
  type TrimAttributes,
} from "@sqlbraid/core";

/**
 * Return the number of bytes produced by UTF-8 encoding `value`.
 *
 * This follows TextEncoder's replacement behavior for lone UTF-16
 * surrogates without allocating an intermediate byte array.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      // BMP code points and lone surrogates encode as three UTF-8 bytes
      // (lone surrogates are replaced with U+FFFD).
      bytes += 3;
    }
  }
  return bytes;
}

const DEFAULT_LIMITS: Required<RenderLimits> = {
  maxSqlBytes: 1_000_000,
  maxBindCount: 10_000,
  maxStructuralItems: 10_000,
  maxNestingDepth: 128,
};

export const postgresDialect: Dialect = {
  id: "postgres",
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
  typeof value === "object" &&
  value !== null &&
  knownFragments.has(value) &&
  SQL_FRAGMENT in value &&
  value[SQL_FRAGMENT] === true;

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
    for (let offset = 0; offset < text.length; offset += 1)
      units.push({ kind: "char", value: text[offset], position: position++ });
    if (index < strings.length - 1) units.push({ kind: "hole", interpolation: index, position: position++ });
  }
  return { units, sourceLength: position };
}

function hexDigit(value: string | undefined): number {
  if (value === undefined) return -1;
  const code = value.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

function decodeTemplateRawSegment(segment: string): string {
  let decoded = "";
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] !== "\\") {
      decoded += segment[index];
      continue;
    }
    const escape = segment[index + 1];
    if (escape === undefined) {
      decoded += "\\";
      continue;
    }
    index += 1;
    if (escape === "x") {
      const high = hexDigit(segment[index + 1]);
      const low = hexDigit(segment[index + 2]);
      if (high >= 0 && low >= 0) {
        decoded += String.fromCharCode((high << 4) | low);
        index += 2;
        continue;
      }
      decoded += escape;
      continue;
    }
    if (escape === "u") {
      if (segment[index + 1] === "{") {
        const close = segment.indexOf("}", index + 2);
        if (close >= 0) {
          const codePoint = Number.parseInt(segment.slice(index + 2, close), 16);
          if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
            decoded += String.fromCodePoint(codePoint);
            index = close;
            continue;
          }
        }
      } else {
        const digits = segment.slice(index + 1, index + 5);
        if (digits.length === 4) {
          const codePoint = Number.parseInt(digits, 16);
          if (Number.isInteger(codePoint) && /^[\da-f]{4}$/iu.test(digits)) {
            decoded += String.fromCharCode(codePoint);
            index += 4;
            continue;
          }
        }
      }
      decoded += escape;
      continue;
    }
    if (escape === "\r" || escape === "\n" || escape === "\u2028" || escape === "\u2029") {
      if (escape === "\r" && segment[index + 1] === "\n") index += 1;
      continue;
    }
    switch (escape) {
      case "b":
        decoded += "\b";
        break;
      case "f":
        decoded += "\f";
        break;
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      case "v":
        decoded += "\v";
        break;
      default:
        decoded += escape;
        break;
    }
  }
  return decoded;
}

function charAt(units: readonly Unit[], index: number): string | undefined {
  const unit = units[index];
  return unit?.kind === "char" ? unit.value : undefined;
}

function startsWith(units: readonly Unit[], index: number, text: string): boolean {
  for (let offset = 0; offset < text.length; offset += 1)
    if (charAt(units, index + offset) !== text[offset]) return false;
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
  return units
    .slice(start, cursor + 1)
    .map((unit) => (unit.kind === "char" ? unit.value : ""))
    .join("");
}

function oracleQDelimiter(
  units: readonly Unit[],
  start: number,
): { readonly open: string; readonly close: string } | undefined {
  const quote = charAt(units, start);
  if ((quote !== "q" && quote !== "Q") || isWordCharacter(charAt(units, start - 1)) || charAt(units, start + 1) !== "'")
    return undefined;
  const open = charAt(units, start + 2);
  if (open === undefined || /\s/u.test(open) || open === "'" || open === '"' || open === "`") return undefined;
  const close = ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Readonly<Record<string, string>>)[open] ?? open;
  return { open, close };
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
    if (prefix === "--" && profile.doubleDashRequiresWhitespace) {
      const next = charAt(units, index + prefix.length);
      if (
        next === undefined
          ? index + prefix.length < units.length
          : next.charCodeAt(0) > 0x20 && next.charCodeAt(0) !== 0x7f && !/\s/u.test(next)
      )
        continue;
    }
    return prefix;
  }
  return undefined;
}

function scanNext(units: readonly Unit[], start: number, profile: DialectLexicalProfile): SpecialToken {
  let cursor = start;
  let textStart = start;
  let state: "code" | "single" | "double" | "backtick" | "bracket" | "line" | "block" | "dollar" | "oracleQ" = "code";
  let blockDepth = 0;
  let dollar = "";
  let oracleQClose = "";
  while (cursor < units.length) {
    const unit = units[cursor];
    if (unit.kind === "hole") {
      if (state !== "code")
        throw new SqlRenderError("BRAID_HOLE_CONTEXT", "Interpolation inside a SQL literal or comment is unsupported.");
      if (cursor > textStart) return { kind: "text", start: textStart, end: cursor };
      return { kind: "hole", start: cursor, end: cursor + 1, interpolation: unit.interpolation };
    }
    const current = unit.value;
    const next = charAt(units, cursor + 1);
    if (state === "line") {
      if ((profile.lineCommentTerminators ?? "\r\n").includes(current)) state = "code";
      cursor += 1;
      continue;
    }
    if (state === "block") {
      if (profile.supportsNestedBlockComments && current === "/" && next === "*") {
        blockDepth += 1;
        cursor += 2;
        continue;
      }
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
      if (current === "\\" && profile.backslashEscapes !== false) {
        if (units[cursor + 1]?.kind === "hole")
          throw new SqlRenderError("BRAID_HOLE_CONTEXT", "Interpolation inside a SQL literal or comment is unsupported.");
        cursor += 2;
        continue;
      }
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (current === quote && next === quote) {
        cursor += 2;
        continue;
      }
      if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "backtick" && current === "`")
      )
        state = "code";
      cursor += 1;
      continue;
    }
    if (state === "bracket") {
      if (current === "]" && next === "]") {
        cursor += 2;
        continue;
      }
      if (current === "]") state = "code";
      cursor += 1;
      continue;
    }
    if (state === "dollar") {
      if (startsWith(units, cursor, dollar)) {
        cursor += dollar.length;
        state = "code";
      } else cursor += 1;
      continue;
    }
    if (state === "oracleQ") {
      if (current === oracleQClose && next === "'") {
        cursor += 2;
        state = "code";
      } else cursor += 1;
      continue;
    }
    if (directiveStart(units, cursor)) {
      if (cursor > textStart) return { kind: "text", start: textStart, end: cursor };
      return scanDirective(units, cursor);
    }
    const lineComment = lineCommentStart(units, cursor, profile);
    if (lineComment) {
      state = "line";
      cursor += lineComment.length;
      continue;
    }
    if (current === "/" && next === "*") {
      state = "block";
      blockDepth = 1;
      cursor += 2;
      continue;
    }
    if (current === "'") {
      state = "single";
      cursor += 1;
      continue;
    }
    if (current === '"') {
      state = "double";
      cursor += 1;
      continue;
    }
    if (current === "`" && profile.supportsBacktickIdentifiers) {
      state = "backtick";
      cursor += 1;
      continue;
    }
    if (current === "[" && profile.supportsBracketIdentifiers) {
      state = "bracket";
      cursor += 1;
      continue;
    }
    const qDelimiter = profile.supportsOracleQQuotes ? oracleQDelimiter(units, cursor) : undefined;
    if (qDelimiter) {
      state = "oracleQ";
      oracleQClose = qDelimiter.close;
      cursor += 3;
      continue;
    }
    const delimiter = profile.supportsDollarQuotes === false ? undefined : dollarDelimiter(units, cursor);
    if (delimiter) {
      state = "dollar";
      dollar = delimiter;
      cursor += delimiter.length;
      continue;
    }
    cursor += 1;
  }
  if (state !== "code" && state !== "line")
    throw new SqlRenderError("BRAID_SQL_LEX", "Unterminated SQL literal or comment in template.");
  return { kind: "text", start: textStart, end: units.length };
}

function textFrom(units: readonly Unit[], start: number, end: number): string {
  return units
    .slice(start, end)
    .map((unit) => (unit.kind === "char" ? unit.value : ""))
    .join("");
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
  if (directive.holes.length !== 1 || directive.text.trim())
    throw new SqlRenderError("BRAID_CONDITION", "Directive condition must contain exactly one interpolation.");
  return directive.holes[0];
}

function parseAttributes(text: string): TrimAttributes {
  const attributes: Record<string, string> = {};
  const pattern = /(prefix|prefixOverrides|suffix|suffixOverrides)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  let consumed = "";
  while ((match = pattern.exec(text)) !== null) {
    if (attributes[match[1]] !== undefined)
      throw new SqlRenderError("BRAID_ATTRIBUTES", `Duplicate trim attribute: ${match[1]}`);
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
    consumed += match[0];
  }
  const unknown = text.replace(pattern, "").trim();
  if (unknown) throw new SqlRenderError("BRAID_ATTRIBUTES", `Unsupported trim attributes: ${unknown}`);
  const split = (value: string | undefined): readonly string[] =>
    (value ?? "")
      .split("|")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
  return {
    prefix: attributes.prefix ?? "",
    prefixOverrides: split(attributes.prefixOverrides),
    suffix: attributes.suffix ?? "",
    suffixOverrides: split(attributes.suffixOverrides),
  };
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

function freezeNode(node: TemplateNode): TemplateNode {
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

function freezeTemplateIr(ir: TemplateIr): TemplateIr {
  return Object.freeze({
    version: ir.version,
    nodes: Object.freeze(ir.nodes.map(freezeNode)),
    sourceLength: ir.sourceLength,
    ...(ir.rawNodes === undefined ? {} : { rawNodes: Object.freeze(ir.rawNodes.map(freezeNode)) }),
  });
}

function sameTemplateShape(left: readonly TemplateNode[], right: readonly TemplateNode[]): boolean {
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

const DEFAULT_LEXICAL_PROFILE: DialectLexicalProfile = {
  lineCommentPrefixes: ["--"],
  supportsNestedBlockComments: true,
  supportsDollarQuotes: true,
  backslashEscapes: true,
};

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

const templateCache = new WeakMap<object, Map<string, TemplateIr>>();
const nativeLexicalCache = new WeakMap<object, Map<string, true>>();

function profileKey(profile: DialectLexicalProfile, maxNestingDepth: number): string {
  return `${JSON.stringify(profile)}:${maxNestingDepth}`;
}

function cachedTemplate(
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

function validateNativeTemplateParts(strings: readonly string[], profile: DialectLexicalProfile): void {
  const units = buildUnits(strings).units;
  let cursor = 0;
  while (cursor < units.length) {
    const token = scanNext(units, cursor, profile);
    if (token.end <= cursor) throw new SqlRenderError("BRAID_SQL_LEX", "Template lexical validation did not advance.");
    cursor = token.end;
  }
}

function validateNativeTemplate(strings: TemplateStringsArray, profile: DialectLexicalProfile): void {
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

interface TrimToken {
  readonly kind: "comment" | "string" | "identifier" | "punctuation" | "other";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly depth: number;
}

function trimTokens(text: string, profile: DialectLexicalProfile = DEFAULT_LEXICAL_PROFILE): readonly TrimToken[] {
  const tokens: TrimToken[] = [];
  let cursor = 0;
  let depth = 0;
  while (cursor < text.length) {
    const start = cursor;
    const current = text[cursor];
    const next = text[cursor + 1];
    if (/\s/.test(current)) {
      cursor += 1;
      continue;
    }
    let lineComment: string | undefined;
    for (const prefix of profile.lineCommentPrefixes) {
      if (!text.startsWith(prefix, cursor)) continue;
      const following = text[cursor + prefix.length];
      if (
        prefix === "--" &&
        profile.doubleDashRequiresWhitespace &&
        following !== undefined &&
        following.charCodeAt(0) > 0x20 &&
        following.charCodeAt(0) !== 0x7f &&
        !/\s/u.test(following)
      )
        continue;
      lineComment = prefix;
      break;
    }
    if (lineComment !== undefined) {
      cursor += lineComment.length;
      while (cursor < text.length && !(profile.lineCommentTerminators ?? "\r\n").includes(text[cursor])) cursor += 1;
      tokens.push({ kind: "comment", text: text.slice(start, cursor), start, end: cursor, depth });
      continue;
    }
    if (current === "/" && next === "*") {
      cursor += 2;
      let nested = 1;
      while (cursor < text.length && nested > 0) {
        if (profile.supportsNestedBlockComments && text[cursor] === "/" && text[cursor + 1] === "*") {
          nested += 1;
          cursor += 2;
          continue;
        }
        if (text[cursor] === "*" && text[cursor + 1] === "/") {
          nested -= 1;
          cursor += 2;
          continue;
        }
        cursor += 1;
      }
      tokens.push({ kind: "comment", text: text.slice(start, cursor), start, end: cursor, depth });
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      const quote = current;
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text[cursor] === quote && text[cursor + 1] === quote) {
          cursor += 2;
          continue;
        }
        if (text[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      tokens.push({ kind: "string", text: text.slice(start, cursor), start, end: cursor, depth });
      continue;
    }
    if (current === "(") {
      depth += 1;
      cursor += 1;
      tokens.push({ kind: "punctuation", text: current, start, end: cursor, depth: depth - 1 });
      continue;
    }
    if (current === ")") {
      depth = Math.max(0, depth - 1);
      cursor += 1;
      tokens.push({ kind: "punctuation", text: current, start, end: cursor, depth });
      continue;
    }
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

function trimOuter(text: string, profile: DialectLexicalProfile): string {
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) start += 1;
  return trimSegmentEnd(text, profile).slice(start);
}

function hasSqlToken(text: string, profile: DialectLexicalProfile): boolean {
  return trimTokens(text, profile).some((token) => token.kind !== "comment");
}

function removeLeadingOverride(text: string, overrides: readonly string[], profile: DialectLexicalProfile): string {
  const tokens = trimTokens(text, profile);
  const first = tokens.find((token) => token.kind !== "comment");
  if (!first || first.kind !== "identifier" || !overrides.includes(first.text.toUpperCase())) return text;
  let end = first.end;
  while (end < text.length && /\s/.test(text[end])) end += 1;
  return `${text.slice(0, first.start)}${text.slice(end)}`;
}

function removeTrailingOverride(text: string, overrides: readonly string[], profile: DialectLexicalProfile): string {
  if (!overrides.length) return text;
  const tokens = trimTokens(text, profile);
  const candidate = [...tokens].reverse().find((token) => token.kind !== "comment" && token.depth === 0);
  if (!candidate || !overrides.includes(candidate.text.toUpperCase())) return text;
  return `${text.slice(0, candidate.start)}${text.slice(candidate.end)}`;
}

function applyTrim(text: string, attributes: TrimAttributes, profile: DialectLexicalProfile): string {
  let body = trimOuter(text, profile);
  if (!body) return "";
  body = removeLeadingOverride(body, attributes.prefixOverrides, profile);
  body = removeTrailingOverride(body, attributes.suffixOverrides, profile);
  body = trimOuter(body, profile);
  if (!hasSqlToken(body, profile)) return body;
  return `${attributes.prefix}${body}${attributes.suffix}`;
}

interface RenderState {
  readonly dialect: Dialect;
  readonly limits: Required<RenderLimits>;
  readonly resultKind: QueryResultKind;
  readonly parameters: RenderedParameter[];
  readonly segments: string[];
  readonly rawSegments: string[];
  readonly variantPath: string[];
  readonly outputNames: Set<string>;
  structuralItems: number;
  depth: number;
  sqlBytes: number;
  afterParameter: boolean;
}

function validateLimits(limits: RenderLimits): Required<RenderLimits> {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, value] of Object.entries(merged))
    if (!Number.isFinite(value) || value < 0)
      throw new SqlRenderError("BRAID_LIMIT", `${key} must be a finite non-negative number.`);
  return merged;
}

function addText(state: RenderState, text: string, rawText = text): void {
  if (!text) return;
  const segment = state.segments.at(-1);
  const previousChar = segment?.at(-1);
  const nextChar = text[0];
  if (
    (previousChar || state.afterParameter) &&
    nextChar &&
    /[\p{L}\p{N}_$]/u.test(previousChar ?? "0") &&
    /[\p{L}\p{N}_$]/u.test(nextChar)
  ) {
    state.segments[state.segments.length - 1] += " ";
    state.rawSegments[state.rawSegments.length - 1] += " ";
    state.sqlBytes += 1;
  }
  state.segments[state.segments.length - 1] += text;
  state.rawSegments[state.rawSegments.length - 1] += rawText;
  state.sqlBytes += utf8ByteLength(text);
  if (state.sqlBytes > state.limits.maxSqlBytes)
    throw new SqlRenderError("BRAID_SQL_LIMIT", "Rendered SQL exceeds maxSqlBytes.");
  state.afterParameter = false;
}

function addStructural(state: RenderState, count = 1): void {
  state.structuralItems += count;
  if (state.structuralItems > state.limits.maxStructuralItems)
    throw new SqlRenderError("BRAID_STRUCTURE_LIMIT", "Rendered structural item count exceeds maxStructuralItems.");
}

export function assertDirectiveCondition(value: unknown): boolean {
  if (isBoundParameter(value))
    throw new SqlRenderError("BRAID_BIND_HINT_CONTEXT", "sql.bind(...) cannot be used as a directive condition.");
  return Boolean(value);
}

function appendParameter(state: RenderState, parameter: RenderedParameter): void {
  if (state.parameters.length >= state.limits.maxBindCount)
    throw new SqlRenderError("BRAID_BIND_LIMIT", "Rendered bind count exceeds maxBindCount.");
  if (parameter.direction !== undefined && parameter.direction !== "in") {
    const allowed = state.resultKind === "call" || (state.resultKind === "rows" && parameter.direction === "out");
    if (!allowed) {
      throw new SqlRenderError(
        "BRAID_CALL_ONLY",
        parameter.direction === "inout"
          ? "sql.inOut() is only valid in sql.call queries."
          : "sql.out() is only valid in sql.call or sql.rows queries.",
      );
    }
  }
  if (parameter.outputName !== undefined) {
    if (state.outputNames.has(parameter.outputName))
      throw new SqlRenderError("BRAID_CALL_OUTPUT_NAME", `Duplicate routine outputName: ${parameter.outputName}`);
    state.outputNames.add(parameter.outputName);
  }
  const segment = state.segments[state.segments.length - 1];
  if ((segment.at(-1) && /[\p{L}\p{N}_$]/u.test(segment.at(-1)!)) || state.afterParameter) {
    state.segments[state.segments.length - 1] += " ";
    state.rawSegments[state.rawSegments.length - 1] += " ";
    state.sqlBytes += 1;
    if (state.sqlBytes > state.limits.maxSqlBytes)
      throw new SqlRenderError("BRAID_SQL_LIMIT", "Rendered SQL exceeds maxSqlBytes.");
  }
  state.parameters.push(parameter);
  state.segments.push("");
  state.rawSegments.push("");
  state.afterParameter = true;
}

function addBind(
  state: RenderState,
  value: unknown,
  interpolation?: number,
  hint?: ParameterTypeHint,
  direction?: RenderedParameter["direction"],
  outputName?: string,
): void {
  appendParameter(state, {
    value,
    ...(interpolation === undefined ? {} : { interpolation }),
    ...(hint === undefined ? {} : { hint }),
    ...(direction === undefined ? {} : { direction }),
    ...(outputName === undefined ? {} : { outputName }),
  });
}

function appendRendered(
  state: RenderState,
  segments: readonly string[],
  parameters: readonly RenderedParameter[],
  rawSegments: readonly string[] = segments,
): void {
  addText(state, segments[0] ?? "", rawSegments[0] ?? "");
  for (let index = 0; index < parameters.length; index += 1) {
    appendParameter(state, parameters[index]);
    addText(state, segments[index + 1] ?? "", rawSegments[index + 1] ?? "");
  }
}

function trimSegmentStart(text: string): string {
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) start += 1;
  return text.slice(start);
}

function trimSegmentEnd(text: string, profile: DialectLexicalProfile): string {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  const tokens = trimTokens(text, profile);
  const last = tokens.at(-1);
  if (last?.kind === "comment" && profile.lineCommentPrefixes.some((prefix) => last.text.startsWith(prefix))) {
    end = last.end;
    if (end < text.length) end += text[end] === "\r" && text[end + 1] === "\n" ? 2 : 1;
  }
  return text.slice(0, end);
}

function applyTrimToSegments(
  segments: readonly string[],
  parameters: readonly RenderedParameter[],
  attributes: TrimAttributes,
  profile: DialectLexicalProfile,
): readonly string[] {
  if (!parameters.length) return [applyTrim(segments[0] ?? "", attributes, profile)];
  const trimmed = [...segments];
  trimmed[0] = trimSegmentStart(trimmed[0] ?? "");
  trimmed[trimmed.length - 1] = trimSegmentEnd(trimmed[trimmed.length - 1] ?? "", profile);
  trimmed[0] = removeLeadingOverride(trimmed[0], attributes.prefixOverrides, profile);
  trimmed[trimmed.length - 1] = removeTrailingOverride(trimmed[trimmed.length - 1], attributes.suffixOverrides, profile);
  trimmed[0] = trimSegmentStart(trimmed[0]);
  trimmed[trimmed.length - 1] = trimSegmentEnd(trimmed[trimmed.length - 1], profile);
  trimmed[0] = `${attributes.prefix}${trimmed[0]}`;
  trimmed[trimmed.length - 1] = `${trimmed[trimmed.length - 1]}${attributes.suffix}`;
  return trimmed;
}

function renderNodes(
  nodes: readonly TemplateNode[],
  captured: readonly unknown[],
  state: RenderState,
  rawNodes: readonly TemplateNode[] = nodes,
): void {
  state.depth += 1;
  if (state.depth > state.limits.maxNestingDepth)
    throw new SqlRenderError("BRAID_DEPTH", "Render nesting limit exceeded.");
  for (const [index, node] of nodes.entries()) {
    const rawNode = rawNodes[index] ?? node;
    if (node.kind === "text") {
      addText(state, node.text, rawNode.kind === "text" ? rawNode.text : node.text);
      continue;
    }
    if (node.kind === "bind") {
      const value = captured[node.interpolation];
      if (isFragment(value)) renderFragment(value, state);
      else if (isRoutineParameter(value))
        addBind(state, value.value, node.interpolation, value.hint, value.direction, value.outputName);
      else if (isBoundParameter(value)) addBind(state, value.value, node.interpolation, value.hint);
      else addBind(state, value, node.interpolation);
      continue;
    }
    if (node.kind === "if") {
      const enabled = assertDirectiveCondition(captured[node.condition]);
      state.variantPath.push(`if:${node.condition}:${enabled ? "1" : "0"}`);
      if (enabled)
        renderNodes(node.children, captured, state, rawNode.kind === "if" ? rawNode.children : node.children);
      continue;
    }
    if (node.kind === "choose") {
      let selected = false;
      for (const [index, when] of node.whens.entries()) {
        if (assertDirectiveCondition(captured[when.condition])) {
          selected = true;
          state.variantPath.push(`when:${index}:${when.condition}`);
          const rawWhen = rawNode.kind === "choose" ? rawNode.whens[index] : undefined;
          renderNodes(when.children, captured, state, rawWhen?.children ?? when.children);
          break;
        }
      }
      if (!selected && node.otherwise) {
        state.variantPath.push("otherwise");
        renderNodes(
          node.otherwise,
          captured,
          state,
          rawNode.kind === "choose" ? (rawNode.otherwise ?? node.otherwise) : node.otherwise,
        );
      }
      continue;
    }
    if (node.kind === "trim") {
      const nested: RenderState = {
        ...state,
        resultKind: state.resultKind,
        parameters: [],
        segments: [""],
        rawSegments: [""],
        variantPath: state.variantPath,
        outputNames: state.outputNames,
        depth: state.depth,
        sqlBytes: 0,
        afterParameter: false,
      };
      renderNodes(node.children, captured, nested, rawNode.kind === "trim" ? rawNode.children : node.children);
      state.structuralItems = nested.structuralItems;
      const profile = state.dialect.lexicalProfile ?? DEFAULT_LEXICAL_PROFILE;
      const trimmed = applyTrimToSegments(nested.segments, nested.parameters, node.attributes, profile);
      const rawTrimmed = applyTrimToSegments(nested.rawSegments, nested.parameters, node.attributes, profile);
      const body = trimmed.join("");
      if (node.attributes.prefix === "SET " && !hasSqlToken(body, profile) && !nested.parameters.length)
        throw new SqlRenderError("BRAID_EMPTY_SET", "@braid set rendered no assignments.");
      appendRendered(state, trimmed, nested.parameters, rawTrimmed);
      continue;
    }
    if (node.kind === "fragment") {
      renderFragment(node.fragment, state);
      continue;
    }
    if (node.kind === "identifier") {
      addStructural(state);
      const parts = typeof node.value === "string" ? node.value.split(".") : node.value;
      addText(state, parts.map((part) => state.dialect.quoteIdentifier(part)).join("."));
      continue;
    }
    if (node.kind === "raw") {
      addStructural(state);
      addText(state, node.text);
      continue;
    }
    if (node.kind === "list") {
      if (!node.values.length)
        throw new SqlRenderError(
          "BRAID_EMPTY_LIST",
          "sql.list([]) has no implicit SQL meaning; guard it or choose an explicit empty strategy.",
        );
      addStructural(state, node.values.length);
      for (const [index, value] of node.values.entries()) {
        if (index) addText(state, ", ");
        if (isRoutineParameter(value))
          addBind(state, value.value, undefined, value.hint, value.direction, value.outputName);
        else if (isBoundParameter(value)) addBind(state, value.value, undefined, value.hint);
        else addBind(state, value);
      }
    }
  }
  state.depth -= 1;
}

function renderFragment(fragment: SqlFragment, state: RenderState): void {
  if (fragment.dialectId !== state.dialect.id)
    throw new SqlRenderError(
      "BRAID_DIALECT",
      `Fragment dialect ${fragment.dialectId} cannot render in ${state.dialect.id}.`,
    );
  addStructural(state);
  renderNodes(fragment.ir.nodes, fragment.values, state, fragment.ir.rawNodes);
}

const synthesizedTemplateCache = new WeakMap<object, Map<string, TemplateStringsArray>>();
const MAX_SYNTHESIZED_TEMPLATES = 64;

function parameterShape(parameter: RenderedParameter): unknown {
  return {
    interpolation: parameter.interpolation,
    hint: parameter.hint,
    direction: parameter.direction,
    outputName: parameter.outputName,
  };
}

function synthesizedTemplate(
  owner: object,
  segments: readonly string[],
  rawSegments: readonly string[],
  parameters: readonly RenderedParameter[],
  variantFingerprint: string,
): TemplateStringsArray {
  const key = JSON.stringify([variantFingerprint, segments, rawSegments, parameters.map(parameterShape)]);
  const entries = synthesizedTemplateCache.get(owner);
  const cached = entries?.get(key);
  if (cached) return cached;
  const template = createTemplateStrings(segments, rawSegments);
  const next = entries ?? new Map<string, TemplateStringsArray>();
  if (next.size >= MAX_SYNTHESIZED_TEMPLATES) {
    const first = next.keys().next().value;
    if (first !== undefined) next.delete(first);
  }
  next.set(key, template);
  synthesizedTemplateCache.set(owner, next);
  return template;
}

function renderIr(
  ir: TemplateIr,
  captured: readonly unknown[],
  dialect: Dialect,
  limits?: RenderLimits,
  resultKind: QueryResultKind = "unknown",
  routineProcedure?: RoutineContract["procedure"],
  nativeTemplateOwner: object = ir,
): RenderedStatement {
  const state: RenderState = {
    dialect,
    limits: validateLimits(limits ?? {}),
    resultKind,
    parameters: [],
    segments: [""],
    rawSegments: [""],
    variantPath: [],
    outputNames: new Set<string>(),
    structuralItems: 0,
    depth: 0,
    sqlBytes: 0,
    afterParameter: false,
  };
  renderNodes(ir.nodes, captured, state, ir.rawNodes);
  const variantFingerprint = state.variantPath.join("|");
  return createRenderedStatement({
    segments: state.segments,
    parameters: state.parameters,
    dialectId: dialect.id,
    nativeTemplate: synthesizedTemplate(
      nativeTemplateOwner,
      state.segments,
      state.rawSegments,
      state.parameters,
      variantFingerprint,
    ),
    ...(routineProcedure === undefined ? {} : { routineProcedure }),
    variantFingerprint,
    resultKind,
  });
}

function plainParameter(
  value: unknown,
  interpolation: number,
  resultKind: QueryResultKind,
  outputNames: Set<string>,
): RenderedParameter {
  const parameter: RenderedParameter = isRoutineParameter(value)
    ? {
        value: value.value,
        interpolation,
        ...(value.hint === undefined ? {} : { hint: value.hint }),
        direction: value.direction,
        outputName: value.outputName,
      }
    : isBoundParameter(value)
      ? {
          value: value.value,
          interpolation,
          hint: value.hint,
        }
      : { value, interpolation };
  if (parameter.direction !== undefined && parameter.direction !== "in") {
    const allowed = resultKind === "call" || (resultKind === "rows" && parameter.direction === "out");
    if (!allowed) {
      throw new SqlRenderError(
        "BRAID_CALL_ONLY",
        parameter.direction === "inout"
          ? "sql.inOut() is only valid in sql.call queries."
          : "sql.out() is only valid in sql.call or sql.rows queries.",
      );
    }
  }
  if (parameter.outputName !== undefined) {
    if (outputNames.has(parameter.outputName))
      throw new SqlRenderError("BRAID_CALL_OUTPUT_NAME", `Duplicate routine outputName: ${parameter.outputName}`);
    outputNames.add(parameter.outputName);
  }
  return parameter;
}

function plainSegments(
  strings: TemplateStringsArray,
  parameterCount: number,
): { readonly segments: readonly string[]; readonly rawSegments: readonly string[] } {
  const segments = [...strings];
  const rawSegments = [...(Array.isArray(strings.raw) ? strings.raw : strings)];
  let afterParameter = false;
  for (let index = 0; index < parameterCount; index += 1) {
    const current = segments[index] ?? "";
    const rawCurrent = rawSegments[index] ?? "";
    if ((afterParameter || isWordCharacter(current.at(-1))) && current.length === 0) {
      segments[index] = " ";
      rawSegments[index] = " ";
    } else if (afterParameter || isWordCharacter(current.at(-1))) {
      segments[index] = `${current} `;
      rawSegments[index] = `${rawCurrent} `;
    }
    const next = segments[index + 1] ?? "";
    if (isWordCharacter(next[0])) {
      segments[index + 1] = ` ${next}`;
      rawSegments[index + 1] = ` ${rawSegments[index + 1] ?? ""}`;
      afterParameter = false;
    } else {
      afterParameter = next.length === 0;
    }
  }
  return { segments, rawSegments };
}

function renderPlainTemplate(
  strings: TemplateStringsArray,
  captured: readonly unknown[],
  dialect: Dialect,
  limits: Required<RenderLimits>,
  resultKind: QueryResultKind,
  routineProcedure?: RoutineContract["procedure"],
  nativeTemplateOwner: object = {},
): RenderedStatement {
  validateNativeTemplate(strings, dialect.lexicalProfile ?? DEFAULT_LEXICAL_PROFILE);
  if (strings.length !== captured.length + 1)
    throw new TypeError("Template values must match template interpolation count.");
  if (captured.length > limits.maxBindCount)
    throw new SqlRenderError("BRAID_BIND_LIMIT", "Rendered bind count exceeds maxBindCount.");
  const parameters: RenderedParameter[] = [];
  const outputNames = new Set<string>();
  for (let index = 0; index < captured.length; index += 1) {
    parameters.push(plainParameter(captured[index], index, resultKind, outputNames));
  }
  const { segments, rawSegments } = plainSegments(strings, parameters.length);
  const sqlBytes = segments.reduce((total, segment) => total + utf8ByteLength(segment), 0);
  if (sqlBytes > limits.maxSqlBytes) throw new SqlRenderError("BRAID_SQL_LIMIT", "Rendered SQL exceeds maxSqlBytes.");
  const preservesIdentity =
    isTemplateStringsArray(strings) && segments.every((segment, index) => segment === strings[index]);
  return createRenderedStatement({
    segments,
    parameters,
    dialectId: dialect.id,
    nativeTemplate: preservesIdentity
      ? strings
      : synthesizedTemplate(nativeTemplateOwner, segments, rawSegments, parameters, ""),
    ...(routineProcedure === undefined ? {} : { routineProcedure }),
    resultKind,
  });
}
export function renderTemplateIr(
  ir: TemplateIr,
  captured: readonly unknown[],
  dialect: Dialect = postgresDialect,
  limits?: RenderLimits,
): RenderedStatement {
  return renderIr(ir, captured, dialect, limits);
}

function collectConditions(
  nodes: readonly TemplateNode[],
  output: Set<number>,
  local: { value: boolean; seen: boolean },
  insideTrim = false,
): void {
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
      const isLocal =
        (node.attributes.prefix === "WHERE " || node.attributes.prefix === "SET ") &&
        localClauseNodes(node.children, node.attributes.prefix);
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
    else if (node.kind === "choose") {
      for (const when of node.whens) parts.push(staticText(when.children));
      if (node.otherwise) parts.push(staticText(node.otherwise));
    }
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
  if (local.value && local.seen)
    return { conditionCount, estimatedVariants: "linear", localClauseAnalysis: true, diagnostics: [] };
  const estimatedVariants = conditionCount > 30 ? "overflow" : 2 ** conditionCount;
  const diagnostics =
    estimatedVariants !== "overflow" && estimatedVariants > maxVariants
      ? ["BRAID_VARIANT_LIMIT: structural variant expansion exceeds maxVariants."]
      : [];
  return { conditionCount, estimatedVariants, localClauseAnalysis: false, diagnostics };
}

export interface StructuralVariant {
  readonly values: readonly unknown[];
  readonly rendered: RenderedStatement;
}

export function renderVariants(
  ir: TemplateIr,
  values: readonly unknown[],
  options: { readonly dialect?: Dialect; readonly limits?: RenderLimits; readonly maxVariants?: number } = {},
): readonly StructuralVariant[] {
  const maxVariants = options.maxVariants ?? 256;
  const analysis = analyzeStructuralVariants(ir, maxVariants);
  if (analysis.estimatedVariants === "linear") {
    const rendered = renderIr(ir, values, options.dialect ?? postgresDialect, options.limits);
    return [{ values: Object.freeze([...values]), rendered }];
  }
  if (analysis.estimatedVariants === "overflow" || analysis.estimatedVariants > maxVariants)
    throw new SqlRenderError("BRAID_VARIANT_LIMIT", "Structural variant expansion exceeds maxVariants.");
  const conditionIndexes = new Set<number>();
  const local = { value: true, seen: false };
  collectConditions(ir.nodes, conditionIndexes, local);
  const indexes = [...conditionIndexes];
  const variants: StructuralVariant[] = [];
  for (let mask = 0; mask < (analysis.estimatedVariants as number); mask += 1) {
    const captured = [...values];
    indexes.forEach((index, position) => {
      captured[index] = Boolean(mask & (1 << position));
    });
    variants.push({
      values: Object.freeze([...captured]),
      rendered: renderIr(ir, captured, options.dialect ?? postgresDialect, options.limits),
    });
  }
  return Object.freeze(variants);
}

function makeFragment(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  dialect: Dialect,
  limits: RenderLimits,
): SqlFragment {
  const fragment = {
    [SQL_FRAGMENT]: true as const,
    ir: cachedTemplate(strings, dialect.lexicalProfile, limits.maxNestingDepth),
    values: Object.freeze([...values]),
    dialectId: dialect.id,
  };
  knownFragments.add(fragment);
  return Object.freeze(fragment);
}

function makeStaticFragment(nodes: readonly TemplateNode[], sourceLength: number, dialect: Dialect): SqlFragment {
  const fragment = {
    [SQL_FRAGMENT]: true as const,
    ir: Object.freeze({ version: 1 as const, nodes: Object.freeze(nodes.map(freezeNode)), sourceLength }),
    values: Object.freeze([]),
    dialectId: dialect.id,
  };
  knownFragments.add(fragment);
  return Object.freeze(fragment);
}

export interface SqlTagOptions {
  readonly dialect?: Dialect;
  readonly limits?: RenderLimits;
}

function assertStandardSchema(value: unknown): asserts value is StandardSchemaV1<unknown, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("sql.rows(schema) requires a Standard Schema object.");
  }
  const standard = (value as { readonly "~standard"?: unknown })["~standard"];
  if (typeof standard !== "object" || standard === null) {
    throw new TypeError("sql.rows(schema) requires a Standard Schema object.");
  }
  const protocol = standard as { readonly version?: unknown; readonly validate?: unknown };
  if (protocol.version !== 1 || typeof protocol.validate !== "function") {
    throw new TypeError("sql.rows(schema) requires a Standard Schema v1 object.");
  }
}

function normalizeRoutineContract(value: RoutineContract): RoutineContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("sql.call(contract) requires a routine contract object.");
  }
  const contract = value as {
    readonly output?: unknown;
    readonly resultSets?: unknown;
    readonly returnValue?: unknown;
    readonly procedure?: unknown;
  };
  if (contract.output !== undefined) assertStandardSchema(contract.output);
  if (contract.resultSets !== undefined) {
    if (!Array.isArray(contract.resultSets)) throw new TypeError("sql.call(contract).resultSets must be an array.");
    for (const schema of contract.resultSets) assertStandardSchema(schema);
  }
  if (contract.returnValue !== undefined) assertStandardSchema(contract.returnValue);
  let procedure: RoutineContract["procedure"];
  if (contract.procedure !== undefined) {
    if (typeof contract.procedure !== "object" || contract.procedure === null || Array.isArray(contract.procedure)) {
      throw new TypeError("sql.call(contract).procedure must be an object.");
    }
    const candidate = contract.procedure as { readonly name?: unknown; readonly parameterNames?: unknown };
    if (typeof candidate.name !== "string" || !candidate.name.trim())
      throw new TypeError("Routine procedure name must be a non-empty string.");
    if (
      !Array.isArray(candidate.parameterNames) ||
      candidate.parameterNames.some((name) => typeof name !== "string" || !name.trim())
    ) {
      throw new TypeError("Routine procedure parameterNames must contain non-empty strings.");
    }
    if (new Set(candidate.parameterNames).size !== candidate.parameterNames.length) {
      throw new TypeError("Routine procedure parameterNames must be unique.");
    }
    procedure = Object.freeze({
      name: candidate.name,
      parameterNames: Object.freeze([...candidate.parameterNames]),
    });
  }
  return Object.freeze({
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.resultSets === undefined ? {} : { resultSets: Object.freeze([...value.resultSets]) }),
    ...(value.returnValue === undefined ? {} : { returnValue: value.returnValue }),
    ...(procedure === undefined ? {} : { procedure }),
  });
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Array.isArray((value as { readonly raw?: unknown }).raw);
}

type PreparedQueryFactory = (
  strings: TemplateStringsArray,
  values: readonly unknown[],
  preparsedIr?: TemplateIr,
) => Query<unknown, QueryResultKind>;
const preparedQueryFactories = new WeakMap<object, PreparedQueryFactory>();

export function createSqlTag(options: SqlTagOptions = {}): SqlTag {
  const dialect = options.dialect ?? postgresDialect;
  const limits = validateLimits(options.limits ?? {});
  const nativeTemplateOwner = {};
  const createQuery = <Row, Kind extends QueryResultKind>(
    strings: TemplateStringsArray,
    values: readonly unknown[],
    resultKind: Kind,
    resultSchema?: StandardSchemaV1<unknown, Row>,
    routineContract?: RoutineContract,
    preparsedIr?: TemplateIr,
  ): Query<Row, Kind> => {
    const captured = Object.freeze([...values]);
    let ir = preparsedIr === undefined ? undefined : freezeTemplateIr(preparsedIr);
    const getIr = (): TemplateIr => {
      if (ir === undefined) ir = cachedTemplate(strings, dialect.lexicalProfile, limits.maxNestingDepth);
      return ir;
    };
    const structural =
      preparsedIr !== undefined || strings.some((segment) => segment.includes("/*@braid")) || captured.some(isFragment);
    if (!structural) validateNativeTemplate(strings, dialect.lexicalProfile ?? DEFAULT_LEXICAL_PROFILE);
    const query = {
      get ir() {
        return getIr();
      },
      values: captured,
      resultKind,
      ...(resultSchema === undefined ? {} : { resultSchema }),
      ...(routineContract === undefined ? {} : { routineContract }),
      render: () =>
        structural
          ? renderIr(getIr(), captured, dialect, limits, resultKind, routineContract?.procedure, nativeTemplateOwner)
          : renderPlainTemplate(
              strings,
              captured,
              dialect,
              limits,
              resultKind,
              routineContract?.procedure,
              nativeTemplateOwner,
            ),
    } as Query<Row, Kind>;
    return Object.freeze(query);
  };
  const createUnknown = (strings: TemplateStringsArray, values: readonly unknown[], preparsedIr?: TemplateIr) =>
    createQuery<unknown, "unknown">(strings, values, "unknown", undefined, undefined, preparsedIr);
  const tag = ((strings: TemplateStringsArray, ...values: readonly unknown[]): Query<unknown, "unknown"> =>
    createUnknown(strings, values)) as SqlTag;
  preparedQueryFactories.set(tag, createUnknown);
  const createRows = (strings: TemplateStringsArray, values: readonly unknown[], preparsedIr?: TemplateIr) =>
    createQuery<unknown, "rows">(strings, values, "rows", undefined, undefined, preparsedIr);
  tag.rows = ((first: TemplateStringsArray | StandardSchemaV1, ...values: readonly unknown[]) => {
    if (isTemplateStringsArray(first)) return createRows(first, values);
    assertStandardSchema(first);
    const schema = first;
    const rowTag = ((strings: TemplateStringsArray, ...tagValues: readonly unknown[]) =>
      createQuery(strings, tagValues, "rows", schema)) as SqlTagLike<"rows", unknown>;
    preparedQueryFactories.set(rowTag, (strings, tagValues, preparsedIr) =>
      createQuery(strings, tagValues, "rows", schema, undefined, preparsedIr),
    );
    return rowTag;
  }) as SqlTag["rows"];
  preparedQueryFactories.set(tag.rows, createRows);
  const createCommand = (strings: TemplateStringsArray, values: readonly unknown[], preparsedIr?: TemplateIr) =>
    createQuery<unknown, "command">(strings, values, "command", undefined, undefined, preparsedIr);
  tag.command = ((strings: TemplateStringsArray, ...values: readonly unknown[]): Query<unknown, "command"> =>
    createCommand(strings, values)) as SqlTag["command"];
  preparedQueryFactories.set(tag.command, createCommand);
  tag.call = ((first: TemplateStringsArray | RoutineContract, ...values: readonly unknown[]) => {
    if (isTemplateStringsArray(first)) return createQuery(first, values, "call");
    const contract = normalizeRoutineContract(first);
    const callTag = ((strings: TemplateStringsArray, ...tagValues: readonly unknown[]) =>
      createQuery(strings, tagValues, "call", undefined, contract)) as SqlTag["call"];
    preparedQueryFactories.set(callTag, (strings, tagValues, preparsedIr) =>
      createQuery(strings, tagValues, "call", undefined, contract, preparsedIr),
    );
    return callTag;
  }) as SqlTag["call"];
  tag.bind = ((value: unknown, hint: ParameterTypeHint) => createBoundParameter(value, hint)) as SqlTag["bind"];
  tag.out = ((name: string, hint?: ParameterTypeHint) => createRoutineOutParameter(name, hint)) as SqlTag["out"];
  tag.inOut = ((name: string, value: unknown, hint?: ParameterTypeHint) =>
    createRoutineInOutParameter(name, value, hint)) as SqlTag["inOut"];
  tag.fragment = (strings, ...values) => makeFragment(strings, values, dialect, limits);
  tag.empty = makeStaticFragment([], 0, dialect);
  tag.ident = (identifier) =>
    makeStaticFragment(
      [
        {
          kind: "identifier",
          value: typeof identifier === "string" ? identifier : Object.freeze([...identifier]),
          range: { start: 0, end: 0 },
        },
      ],
      0,
      dialect,
    );
  tag.raw = (text) =>
    makeStaticFragment([{ kind: "raw", text, range: { start: 0, end: text.length } }], text.length, dialect);
  tag.join = (items, separator = tag.empty) => {
    if (!items.every(isFragment) || !isFragment(separator))
      throw new SqlRenderError("BRAID_FRAGMENT", "sql.join accepts SQLBraid fragments only.");
    const nodes: TemplateNode[] = [];
    items.forEach((item, index) => {
      if (item.dialectId !== dialect.id || separator.dialectId !== dialect.id)
        throw new SqlRenderError("BRAID_DIALECT", "Cannot join fragments from another dialect.");
      if (index) nodes.push({ kind: "fragment", fragment: separator, range: { start: 0, end: 0 } });
      nodes.push({ kind: "fragment", fragment: item, range: { start: 0, end: 0 } });
    });
    return makeStaticFragment(nodes, 0, dialect);
  };
  tag.list = (values) => {
    if (!Array.isArray(values)) throw new SqlRenderError("BRAID_LIST", "sql.list requires an array.");
    for (let index = 0; index < values.length; index += 1)
      if (!Object.hasOwn(values, index))
        throw new SqlRenderError("BRAID_LIST", "sql.list does not accept sparse arrays.");
    if (values.some(isFragment))
      throw new SqlRenderError(
        "BRAID_LIST",
        "sql.list accepts bind values only; use sql.join for structural fragments.",
      );
    if (!values.length)
      throw new SqlRenderError(
        "BRAID_EMPTY_LIST",
        "sql.list([]) has no implicit SQL meaning; guard it or choose an explicit empty strategy.",
      );
    return makeStaticFragment(
      [{ kind: "list", values: Object.freeze([...values]), range: { start: 0, end: 0 } }],
      0,
      dialect,
    );
  };
  return tag;
}

function createTemplateStrings(values: readonly string[], rawValues: readonly string[] = values): TemplateStringsArray {
  if (values.length !== rawValues.length)
    throw new TypeError("Template cooked/raw segments must have matching lengths.");
  const strings = [...values] as string[] & { raw?: readonly string[] };
  const raw = Object.freeze([...rawValues]);
  Object.defineProperty(strings, "raw", {
    value: raw,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(strings) as unknown as TemplateStringsArray;
}

function hasGuard(nodes: readonly TemplateNode[]): boolean {
  return nodes.some(
    (node) =>
      node.kind === "if" ||
      (node.kind === "choose" &&
        (node.whens.some((when) => hasGuard(when.children)) || Boolean(node.otherwise && hasGuard(node.otherwise)))) ||
      (node.kind === "trim" && hasGuard(node.children)),
  );
}

function captureActive(
  nodes: readonly TemplateNode[],
  thunks: readonly (() => unknown)[],
  values: unknown[],
  evaluated = new Set<number>(),
): void {
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
      if (assertDirectiveCondition(values[node.condition])) captureActive(node.children, thunks, values, evaluated);
      continue;
    }
    if (node.kind === "choose") {
      let selected = false;
      for (const when of node.whens) {
        if (!evaluated.has(when.condition)) {
          values[when.condition] = thunks[when.condition]();
          evaluated.add(when.condition);
        }
        if (assertDirectiveCondition(values[when.condition])) {
          captureActive(when.children, thunks, values, evaluated);
          selected = true;
          break;
        }
      }
      if (!selected && node.otherwise) captureActive(node.otherwise, thunks, values, evaluated);
      continue;
    }
    if (node.kind === "trim") {
      captureActive(node.children, thunks, values, evaluated);
      continue;
    }
  }
}

export function guarded<Row = unknown, Kind extends QueryResultKind = QueryResultKind>(
  tag: SqlTagLike<Kind, Row>,
  strings: readonly string[],
  thunks: readonly (() => unknown)[],
): Query<Row, Kind> {
  const templateStrings = createTemplateStrings(strings);
  const ir = cachedTemplate(templateStrings);
  if (!hasGuard(ir.nodes)) return tag(templateStrings, ...thunks.map((thunk) => thunk()));
  const values = Array.from({ length: Math.max(0, strings.length - 1) }, () => undefined);
  captureActive(ir.nodes, thunks, values);
  return tag(templateStrings, ...values);
}

export function capture<Row = unknown, Kind extends QueryResultKind = QueryResultKind>(
  tag: SqlTagLike<Kind, Row>,
  strings: readonly string[],
  build: (values: unknown[]) => void,
  preparsedIr?: TemplateIr,
): Query<Row, Kind> {
  const captured = Array.from({ length: Math.max(0, strings.length - 1) }, () => undefined);
  build(captured);
  const templateStrings = isTemplateStringsArray(strings) ? strings : createTemplateStrings(strings);
  const factory = preparedQueryFactories.get(tag as unknown as object);
  if (preparsedIr !== undefined && factory) return factory(templateStrings, captured, preparsedIr) as Query<Row, Kind>;
  return tag(templateStrings, ...captured);
}

export const sql = createSqlTag();
export { SqlRenderError };
