import {
  SQL_FRAGMENT,
  SqlRenderError,
  type Dialect,
  type DialectLexicalProfile,
  type RenderLimits,
  type SqlFragment,
  type TemplateNode,
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

export const DEFAULT_LIMITS: Required<RenderLimits> = {
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

export const knownFragments = new WeakSet<object>();
export const isFragment = (value: unknown): value is SqlFragment =>
  typeof value === "object" &&
  value !== null &&
  knownFragments.has(value) &&
  SQL_FRAGMENT in value &&
  value[SQL_FRAGMENT] === true;

export interface CharUnit {
  readonly kind: "char";
  readonly value: string;
  readonly position: number;
}

export interface HoleUnit {
  readonly kind: "hole";
  readonly interpolation: number;
  readonly position: number;
}

export type Unit = CharUnit | HoleUnit;

export function buildUnits(strings: readonly string[]): {
  readonly units: readonly Unit[];
  readonly sourceLength: number;
} {
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

export function decodeTemplateRawSegment(segment: string): string {
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

export function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_$]/u.test(value);
}

export interface DirectiveToken {
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

export function scanNext(units: readonly Unit[], start: number, profile: DialectLexicalProfile): SpecialToken {
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
          throw new SqlRenderError(
            "BRAID_HOLE_CONTEXT",
            "Interpolation inside a SQL literal or comment is unsupported.",
          );
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

export function appendTextNodes(nodes: TemplateNode[], units: readonly Unit[], start: number, end: number): void {
  if (end <= start) return;
  nodes.push({ kind: "text", text: textFrom(units, start, end), range: { start, end } });
}

export const DEFAULT_LEXICAL_PROFILE: DialectLexicalProfile = {
  lineCommentPrefixes: ["--"],
  supportsNestedBlockComments: true,
  supportsDollarQuotes: true,
  backslashEscapes: true,
};

export function createTemplateStrings(
  values: readonly string[],
  rawValues: readonly string[] = values,
): TemplateStringsArray {
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

export function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Array.isArray((value as { readonly raw?: unknown }).raw);
}
