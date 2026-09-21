import { type Query, type QueryResultKind, type SqlTagLike, type TemplateIr, type TemplateNode } from "@sqlbraid/core";
import { cachedTemplate } from "./parser.js";
import { assertDirectiveCondition } from "./render.js";
import { createTemplateStrings, isTemplateStringsArray } from "./lexical.js";
import { preparedQueryFactories } from "./tag.js";

function hasGuard(nodes: readonly TemplateNode[]): boolean {
  return nodes.some(
    (node) =>
      node.kind === "if" ||
      (node.kind === "choose" &&
        (node.whens.some((when) => hasGuard(when.children)) || Boolean(node.otherwise && hasGuard(node.otherwise)))) ||
      (node.kind === "trim" && hasGuard(node.children)),
  );
}

// Compiler-lowered thunks are evaluated only along the selected branch and memoized by interpolation index.
export function captureActive(
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

/**
 * Build a query from compiler-lowered guarded captures.
 * Only conditions and bindings in the selected branch are evaluated, once each; inactive branches stay lazy.
 */
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

/** Build a query from compiler-lowered capture assignments without changing the tag's rendering semantics. */
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
