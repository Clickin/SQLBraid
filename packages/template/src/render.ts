import {
  SqlRenderError,
  createRenderedStatement,
  isBoundParameter,
  isRoutineParameter,
  type Dialect,
  type ParameterTypeHint,
  type QueryResultKind,
  type RenderLimits,
  type RenderedParameter,
  type RenderedStatement,
  type RoutineContract,
  type SqlFragment,
  type TemplateIr,
  type TemplateNode,
  type TrimAttributes,
  type DialectLexicalProfile,
} from "@sqlbraid/core";
import {
  DEFAULT_LEXICAL_PROFILE,
  DEFAULT_LIMITS,
  createTemplateStrings,
  isFragment,
  isTemplateStringsArray,
  isWordCharacter,
  postgresDialect,
  utf8ByteLength,
} from "./lexical.js";
import { validateNativeTemplate } from "./parser.js";
import { applyTrim, hasSqlToken, removeLeadingOverride, removeTrailingOverride, trimSegmentEnd } from "./trim.js";

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

export function validateLimits(limits: RenderLimits): Required<RenderLimits> {
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

/** Convert a guarded directive condition to boolean; typed bind hints are invalid in control-flow positions. */
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
  trimmed[trimmed.length - 1] = removeTrailingOverride(
    trimmed[trimmed.length - 1],
    attributes.suffixOverrides,
    profile,
  );
  trimmed[0] = trimSegmentStart(trimmed[0]);
  trimmed[trimmed.length - 1] = trimSegmentEnd(trimmed[trimmed.length - 1], profile);
  trimmed[0] = `${attributes.prefix}${trimmed[0]}`;
  trimmed[trimmed.length - 1] = `${trimmed[trimmed.length - 1]}${attributes.suffix}`;
  return trimmed;
}

// Rendering mutates only local state; captured values are read, never re-evaluated, and inactive guards are skipped.
export function renderNodes(
  nodes: readonly TemplateNode[],
  captured: readonly unknown[],
  state: RenderState,
  rawNodes: readonly TemplateNode[] = nodes,
): void {
  state.depth += 1;
  if (state.depth > state.limits.maxNestingDepth)
    throw new SqlRenderError("BRAID_DEPTH", "Render nesting limit exceeded.");
  for (const [nodeIndex, node] of nodes.entries()) {
    const rawNode = rawNodes[nodeIndex] ?? node;
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
      // Trim renders into an isolated segment/parameter buffer so prefix/suffix surgery cannot reorder outer binds.
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

// Fragments are structural and dialect-bound; crossing dialects is rejected instead of silently requoting text.
export function renderFragment(fragment: SqlFragment, state: RenderState): void {
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

export function renderIr(
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

export function renderPlainTemplate(
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
/** Render frozen IR into the logical value-only statement boundary consumed by adapters. */
export function renderTemplateIr(
  ir: TemplateIr,
  captured: readonly unknown[],
  dialect: Dialect = postgresDialect,
  limits?: RenderLimits,
): RenderedStatement {
  return renderIr(ir, captured, dialect, limits);
}
