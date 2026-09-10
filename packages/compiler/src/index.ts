import ts from "typescript";
import { parseTemplate } from "../../template/src/index.js";
import type { TemplateIr } from "../../core/src/index.js";

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface BindingSite {
  readonly interpolation: number;
  readonly range: SourceRange;
  readonly expression: string;
}

export interface DiscoveredQuery {
  readonly tagName: string;
  readonly moduleSpecifier: string;
  readonly range: SourceRange;
  readonly templateRange: SourceRange;
  readonly strings: readonly string[];
  readonly bindings: readonly BindingSite[];
  readonly ir: TemplateIr;
}

export interface CompileDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly range: SourceRange;
}

export interface InferredQueryShape {
  readonly rowType: string;
  readonly bindingTypes?: readonly (string | "unknown")[];
  readonly diagnostics?: readonly CompileDiagnostic[];
}

export interface SourceAnalysisResult {
  readonly queries: readonly DiscoveredQuery[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

export interface OverlayOptions {
  readonly moduleSpecifier: string;
  readonly tagExport?: string;
  readonly analyze?: (query: DiscoveredQuery) => InferredQueryShape;
}

function range(node: ts.Node, sourceFile: ts.SourceFile): SourceRange {
  return { start: node.getStart(sourceFile), end: node.getEnd() };
}

function createTemplateStrings(values: readonly string[]): TemplateStringsArray {
  const strings = [...values] as string[] & { raw?: readonly string[] };
  strings.raw = values;
  return strings as unknown as TemplateStringsArray;
}

function importAliases(sourceFile: ts.SourceFile, moduleSpecifier: string, tagExport: string): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleSpecifier) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name && tagExport === "default") aliases.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) if (element.name.text === tagExport || element.propertyName?.text === tagExport) aliases.add(element.name.text);
    }
  }
  return aliases;
}

function extractTemplate(node: ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression, sourceFile: ts.SourceFile): { strings: readonly string[]; bindings: readonly BindingSite[]; templateRange: SourceRange } {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { strings: [node.text], bindings: [], templateRange: range(node, sourceFile) };
  const strings: string[] = [node.head.text];
  const bindings: BindingSite[] = [];
  for (const span of node.templateSpans) {
    bindings.push({ interpolation: bindings.length, range: range(span.expression, sourceFile), expression: span.expression.getText(sourceFile) });
    strings.push(span.literal.text);
  }
  return { strings, bindings, templateRange: range(node, sourceFile) };
}

export function discoverQueries(sourceText: string, fileName: string, options: OverlayOptions): SourceAnalysisResult {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = importAliases(sourceFile, options.moduleSpecifier, options.tagExport ?? "sql");
  const queries: DiscoveredQuery[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  function visit(node: ts.Node): void {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = ts.isIdentifier(node.tag) ? node.tag.text : undefined;
      if (tag && aliases.has(tag)) {
        const extracted = extractTemplate(node.template, sourceFile);
        try {
          queries.push({
            tagName: tag,
            moduleSpecifier: options.moduleSpecifier,
            range: range(node, sourceFile),
            templateRange: extracted.templateRange,
            strings: extracted.strings,
            bindings: extracted.bindings,
            ir: parseTemplate(createTemplateStrings(extracted.strings)),
          });
        } catch (error) {
          diagnostics.push({ code: "BRAID_TEMPLATE", message: error instanceof Error ? error.message : String(error), severity: "error", range: range(node.template, sourceFile) });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { queries, diagnostics };
}

export interface OverlayQueryType {
  readonly range: SourceRange;
  readonly rowType: string;
  readonly bindingTypes: readonly (string | "unknown")[];
}

export interface VirtualTypeScriptOverlay {
  readonly sourceFileName: string;
  readonly sourceText: string;
  readonly queryTypes: readonly OverlayQueryType[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

export function createVirtualOverlay(sourceText: string, fileName: string, options: OverlayOptions): VirtualTypeScriptOverlay {
  const discovered = discoverQueries(sourceText, fileName, options);
  const queryTypes: OverlayQueryType[] = [];
  const diagnostics = [...discovered.diagnostics];
  for (const query of discovered.queries) {
    const inferred = options.analyze?.(query) ?? { rowType: "unknown", bindingTypes: query.bindings.map(() => "unknown" as const) };
    queryTypes.push({ range: query.range, rowType: inferred.rowType, bindingTypes: inferred.bindingTypes ?? query.bindings.map(() => "unknown" as const) });
    if (inferred.diagnostics) diagnostics.push(...inferred.diagnostics);
  }
  return { sourceFileName: fileName, sourceText, queryTypes, diagnostics };
}

export function sourcePosition(sourceText: string, offset: number): { readonly line: number; readonly character: number } {
  const prefix = sourceText.slice(0, offset);
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length, character: lines[lines.length - 1].length + 1 };
}
