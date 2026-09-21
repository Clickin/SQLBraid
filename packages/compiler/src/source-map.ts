import ts from "typescript";
import { GenMapping, addSegment, setSourceContent, toEncodedMap } from "@jridgewell/gen-mapping";
import { discoverQueries, hasGuard, sourceFileFor } from "./discovery.js";
import { createLoweringPlan, directivePrologueEnd, queryKey } from "./lowering.js";
import type {
  CompileDiagnostic,
  SourceAnalysisResult,
  SourceMap,
  SourceMapOrigin,
  TransformSourceOptions,
  TransformSourceResult,
} from "./types.js";

interface SourceEdit {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly generatedText: string;
}

interface MappingPoint {
  readonly generatedOffset: number;
  readonly sourceOffset: number;
}

function lineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function positionAt(
  text: string,
  starts: readonly number[],
  offset: number,
): { readonly line: number; readonly column: number } {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= safeOffset) low = middle;
    else high = middle;
  }
  return { line: low, column: safeOffset - starts[low] };
}

function addChunkLinePoints(
  points: MappingPoint[],
  generatedText: string,
  generatedStart: number,
  sourceText: string,
  sourceStart: number,
  exactSourceLines = true,
): void {
  points.push({ generatedOffset: generatedStart, sourceOffset: sourceStart });
  for (let index = 0; index < generatedText.length; index += 1) {
    if (generatedText[index] === "\n") {
      points.push({
        generatedOffset: generatedStart + index + 1,
        sourceOffset: exactSourceLines ? Math.min(sourceText.length, sourceStart + index + 1) : sourceStart,
      });
    }
  }
}

function sourceMapFor(
  generatedText: string,
  sourceText: string,
  fileName: string,
  points: readonly MappingPoint[],
  origins: readonly SourceMapOrigin[],
): SourceMap {
  const generatedStarts = lineStarts(generatedText);
  const sourceStarts = lineStarts(sourceText);
  const byLine = new Map<number, MappingPoint[]>();
  const sorted = [...points]
    .filter((point) => point.generatedOffset >= 0 && point.generatedOffset <= generatedText.length)
    .toSorted((left, right) => left.generatedOffset - right.generatedOffset || left.sourceOffset - right.sourceOffset);
  for (const point of sorted) {
    const location = positionAt(generatedText, generatedStarts, point.generatedOffset);
    const linePoints = byLine.get(location.line) ?? [];
    const previous = linePoints.at(-1);
    if (previous?.generatedOffset === point.generatedOffset) {
      linePoints[linePoints.length - 1] = point;
    } else linePoints.push(point);
    byLine.set(location.line, linePoints);
  }
  const generator = new GenMapping({ file: fileName });
  setSourceContent(generator, fileName, sourceText);
  for (const [generatedLine, entries] of byLine) {
    const generatedLineStart = generatedStarts[generatedLine] ?? generatedText.length;
    for (const point of entries) {
      const original = positionAt(sourceText, sourceStarts, point.sourceOffset);
      addSegment(
        generator,
        generatedLine,
        point.generatedOffset - generatedLineStart,
        fileName,
        original.line,
        original.column,
      );
    }
  }
  const encoded = toEncodedMap(generator);
  return { ...encoded, ...(origins.length ? { x_sqlbraid_origins: origins } : {}) };
}

function prefixInsertionOffset(sourceFile: ts.SourceFile): number {
  const index = directivePrologueEnd(sourceFile.statements);
  if (index === 0) {
    if (!sourceFile.text.startsWith("#!")) return 0;
    const lineBreak = sourceFile.text.search(/\r\n|\r|\n/u);
    return lineBreak < 0
      ? sourceFile.text.length
      : lineBreak + (sourceFile.text[lineBreak] === "\r" && sourceFile.text[lineBreak + 1] === "\n" ? 2 : 1);
  }
  const last = sourceFile.statements[index - 1];
  let offset = last.end;
  for (const comment of ts.getTrailingCommentRanges(sourceFile.text, offset) ?? []) {
    offset = comment.end;
  }
  while (offset < sourceFile.text.length && /\s/u.test(sourceFile.text[offset]!)) offset += 1;
  return offset;
}

function lowerSourcePreserving(
  sourceFile: ts.SourceFile,
  discovered: SourceAnalysisResult,
): { readonly code: string; readonly diagnostics: readonly CompileDiagnostic[]; readonly map: SourceMap | null } {
  const guarded = discovered.queries.filter((query) => hasGuard(query.ir.nodes));
  if (!guarded.length) return { code: sourceFile.text, diagnostics: discovered.diagnostics, map: null };
  const plan = createLoweringPlan(sourceFile, discovered, "runtime");
  const transformed = ts.transform(sourceFile, [plan.transformer]);
  transformed.dispose();
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const edits: SourceEdit[] = [];
  const origins: SourceMapOrigin[] = [];
  for (const query of guarded) {
    const loweredNode = plan.loweredNodes.get(queryKey(query.range));
    if (!loweredNode || !ts.isCallExpression(loweredNode)) continue;
    edits.push({
      sourceStart: query.range.start,
      sourceEnd: query.range.end,
      generatedText: printer.printNode(ts.EmitHint.Expression, loweredNode, sourceFile),
    });
  }
  if (edits.length && plan.prefix.length) {
    const offset = prefixInsertionOffset(sourceFile);
    const separator = offset > 0 && !/[\r\n]/u.test(sourceFile.text[offset - 1]!) ? "\n" : "";
    const generatedText = `${separator}${plan.prefix.map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile)).join("\n")}\n`;
    edits.push({ sourceStart: offset, sourceEnd: offset, generatedText });
  }
  if (!edits.length) return { code: sourceFile.text, diagnostics: plan.diagnostics, map: null };
  const ordered = edits.toSorted(
    (left, right) => left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd,
  );
  const points: MappingPoint[] = [];
  let sourceCursor = 0;
  let generatedCursor = 0;
  let code = "";
  for (const edit of ordered) {
    if (edit.sourceStart < sourceCursor) continue;
    const unchanged = sourceFile.text.slice(sourceCursor, edit.sourceStart);
    code += unchanged;
    addChunkLinePoints(points, unchanged, generatedCursor, sourceFile.text, sourceCursor);
    generatedCursor += unchanged.length;
    const replacementStart = generatedCursor;
    code += edit.generatedText;
    addChunkLinePoints(points, edit.generatedText, replacementStart, sourceFile.text, edit.sourceStart, false);
    const query = discovered.queries.find(
      (candidate) => candidate.range.start === edit.sourceStart && candidate.range.end === edit.sourceEnd,
    );
    let bindingSearchOffset = Math.max(0, edit.generatedText.indexOf("=> {"));
    for (const binding of query?.bindings ?? []) {
      let bindingOffset = edit.generatedText.indexOf(binding.expression, bindingSearchOffset);
      while (bindingOffset >= 0) {
        const before = edit.generatedText[bindingOffset - 1];
        const after = edit.generatedText[bindingOffset + binding.expression.length];
        const identifierExpression =
          /[\p{L}\p{N}_$]/u.test(binding.expression[0] ?? "") &&
          /[\p{L}\p{N}_$]/u.test(binding.expression.at(-1) ?? "");
        if (!identifierExpression || (!/[\p{L}\p{N}_$]/u.test(before ?? "") && !/[\p{L}\p{N}_$]/u.test(after ?? "")))
          break;
        bindingOffset = edit.generatedText.indexOf(
          binding.expression,
          bindingOffset + Math.max(1, binding.expression.length),
        );
      }
      if (bindingOffset < 0) continue;
      points.push({ generatedOffset: replacementStart + bindingOffset, sourceOffset: binding.range.start });
      bindingSearchOffset = bindingOffset + Math.max(1, binding.expression.length);
    }
    generatedCursor += edit.generatedText.length;
    origins.push({
      generatedStart: replacementStart,
      generatedEnd: generatedCursor,
      sourceStart: edit.sourceStart,
      sourceEnd: edit.sourceEnd,
    });
    sourceCursor = edit.sourceEnd;
  }
  const trailing = sourceFile.text.slice(sourceCursor);
  code += trailing;
  addChunkLinePoints(points, trailing, generatedCursor, sourceFile.text, sourceCursor);
  const map = sourceMapFor(code, sourceFile.text, sourceFile.fileName, points, origins);
  return { code, diagnostics: plan.diagnostics, map };
}

/** Lower guarded templates while preserving original code when no Braid directives are present. */
export function transformSource(
  sourceText: string,
  fileName: string,
  options: TransformSourceOptions = {},
): TransformSourceResult {
  // ponytail: avoid the TypeScript parser for the overwhelmingly common unrelated-module path.
  if (!sourceText.includes("@braid")) return { code: sourceText, map: null, diagnostics: [] };
  const sourceFile = sourceFileFor(sourceText, fileName, options);
  const discovered = discoverQueries(sourceText, fileName, { ...options, sourceFile });
  return lowerSourcePreserving(sourceFile, discovered);
}
