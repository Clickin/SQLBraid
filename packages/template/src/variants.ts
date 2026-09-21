import {
  SqlRenderError,
  type Dialect,
  type RenderLimits,
  type RenderedStatement,
  type TemplateIr,
  type TemplateNode,
} from "@sqlbraid/core";
import { postgresDialect } from "./lexical.js";
import { renderIr } from "./render.js";
import { trimTokens } from "./trim.js";

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
  const first = trimTokens(text)
    .find((token) => token.kind !== "comment")
    ?.text.toUpperCase();
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

/** Static estimate of guarded structural shapes; local WHERE/SET guards are treated as linear. */
export interface StructuralAnalysis {
  readonly conditionCount: number;
  readonly estimatedVariants: number | "overflow" | "linear";
  readonly localClauseAnalysis: boolean;
  readonly diagnostics: readonly string[];
}

/** Analyze structural guards without executing captured application expressions. */
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

/** One bounded structural variant: captured values plus its independently rendered statement. */
export interface StructuralVariant {
  readonly values: readonly unknown[];
  readonly rendered: RenderedStatement;
}

/** Render all structural variants up to `maxVariants`; throws rather than silently truncating expansion. */
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
