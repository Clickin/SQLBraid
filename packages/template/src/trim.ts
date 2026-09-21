import { SqlRenderError, type DialectLexicalProfile, type TrimAttributes } from "@sqlbraid/core";
import { DEFAULT_LEXICAL_PROFILE } from "./lexical.js";

export function splitTrimOverrides(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split("|")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

export function parseAttributes(text: string): TrimAttributes {
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
  return {
    prefix: attributes.prefix ?? "",
    prefixOverrides: splitTrimOverrides(attributes.prefixOverrides),
    suffix: attributes.suffix ?? "",
    suffixOverrides: splitTrimOverrides(attributes.suffixOverrides),
  };
}
export interface TrimToken {
  readonly kind: "comment" | "string" | "identifier" | "punctuation" | "other";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly depth: number;
}

export function trimTokens(
  text: string,
  profile: DialectLexicalProfile = DEFAULT_LEXICAL_PROFILE,
): readonly TrimToken[] {
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

export function trimSegmentEnd(text: string, profile: DialectLexicalProfile): string {
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

export function trimOuter(text: string, profile: DialectLexicalProfile): string {
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) start += 1;
  return trimSegmentEnd(text, profile).slice(start);
}

export function hasSqlToken(text: string, profile: DialectLexicalProfile): boolean {
  return trimTokens(text, profile).some((token) => token.kind !== "comment");
}

export function removeLeadingOverride(
  text: string,
  overrides: readonly string[],
  profile: DialectLexicalProfile,
): string {
  const tokens = trimTokens(text, profile);
  const first = tokens.find((token) => token.kind !== "comment");
  if (!first || first.kind !== "identifier" || !overrides.includes(first.text.toUpperCase())) return text;
  let end = first.end;
  while (end < text.length && /\s/.test(text[end])) end += 1;
  return `${text.slice(0, first.start)}${text.slice(end)}`;
}

export function removeTrailingOverride(
  text: string,
  overrides: readonly string[],
  profile: DialectLexicalProfile,
): string {
  if (!overrides.length) return text;
  const tokens = trimTokens(text, profile);
  // oxlint-disable-next-line unicorn/no-array-reverse -- Reverse only this owned copy; Node 16 lacks toReversed.
  const candidate = [...tokens].reverse().find((token) => token.kind !== "comment" && token.depth === 0);
  if (!candidate || !overrides.includes(candidate.text.toUpperCase())) return text;
  return `${text.slice(0, candidate.start)}${text.slice(candidate.end)}`;
}

export function applyTrim(text: string, attributes: TrimAttributes, profile: DialectLexicalProfile): string {
  let body = trimOuter(text, profile);
  if (!body) return "";
  body = removeLeadingOverride(body, attributes.prefixOverrides, profile);
  body = removeTrailingOverride(body, attributes.suffixOverrides, profile);
  body = trimOuter(body, profile);
  if (!hasSqlToken(body, profile)) return body;
  return `${attributes.prefix}${body}${attributes.suffix}`;
}
