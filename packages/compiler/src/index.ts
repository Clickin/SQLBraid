import ts from "typescript";
import { dirname } from "node:path";
import { parseSql, resolveStatement, type SemanticResult } from "@sqlbraid/ast";
import { analyzeStructuralVariants, parseTemplate, renderTemplateIr, postgresDialect } from "@sqlbraid/template";
import type { Dialect, TemplateIr, TemplateNode } from "@sqlbraid/core";
import type { SchemaSnapshot } from "@sqlbraid/schema";

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
  readonly expectedType?: string;
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
  readonly resultKind?: "rows" | "command" | "call" | "unknown";
  readonly semantic?: SemanticResult;
}

export interface SourceAnalysisResult {
  readonly queries: readonly DiscoveredQuery[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

export interface OverlayOptions {
  readonly moduleSpecifier?: string;
  readonly moduleSpecifiers?: readonly string[];
  readonly tagExport?: string;
  readonly dialect?: Dialect;
  readonly snapshot?: SchemaSnapshot;
  readonly typePolicy?: { readonly id: string; readonly hash: string };
  readonly analyze?: (query: DiscoveredQuery) => InferredQueryShape;
  readonly limits?: { readonly maxNestingDepth?: number; readonly maxSqlBytes?: number };
  readonly compilerOptions?: ts.CompilerOptions;
  readonly typeChecker?: ts.TypeChecker;
  readonly sourceFile?: ts.SourceFile;
}

export interface TypeScriptCheckOptions extends OverlayOptions {}

export interface TypeScriptProjectContext {
  readonly projectFile: string;
  readonly compilerOptions: ts.CompilerOptions;
  readonly fileNames: readonly string[];
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
}

export interface SourceMapOrigin {
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

function range(node: ts.Node, sourceFile: ts.SourceFile): SourceRange {
  return { start: node.getStart(sourceFile), end: node.getEnd() };
}

function createTemplateStrings(values: readonly string[]): TemplateStringsArray {
  const strings = [...values] as string[] & { raw?: readonly string[] };
  strings.raw = [...values];
  return strings as unknown as TemplateStringsArray;
}

function scriptKindForFileName(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return ts.ScriptKind.JS;
  if (lower.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

function sourceFileScriptKind(sourceFile: ts.SourceFile): ts.ScriptKind {
  return (sourceFile as ts.SourceFile & { readonly scriptKind?: ts.ScriptKind }).scriptKind ?? scriptKindForFileName(sourceFile.fileName);
}

function impliedNodeFormatForFileName(fileName: string, compilerOptions: ts.CompilerOptions): ts.ModuleKind.ESNext | ts.ModuleKind.CommonJS | undefined {
  if (compilerOptions.module !== ts.ModuleKind.Node16 && compilerOptions.module !== ts.ModuleKind.NodeNext) return undefined;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".mts") || lower.endsWith(".mjs")) return ts.ModuleKind.ESNext;
  if (lower.endsWith(".cts") || lower.endsWith(".cjs")) return ts.ModuleKind.CommonJS;
  return undefined;
}

function sourceFileFor(sourceText: string, fileName: string, options: OverlayOptions): ts.SourceFile {
  const original = options.sourceFile && ts.sys.resolvePath(options.sourceFile.fileName) === ts.sys.resolvePath(fileName) ? options.sourceFile : undefined;
  if (original?.text === sourceText) return original;
  const languageVersion = original?.languageVersion ?? options.compilerOptions?.target ?? ts.ScriptTarget.Latest;
  const sourceFile = ts.createSourceFile(fileName, sourceText, languageVersion, true, original ? sourceFileScriptKind(original) : scriptKindForFileName(fileName));
  if (original?.impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = original.impliedNodeFormat;
  else {
    const impliedNodeFormat = impliedNodeFormatForFileName(fileName, options.compilerOptions ?? defaultCompilerOptions());
    if (impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = impliedNodeFormat;
  }
  return sourceFile;
}

function configuredModules(options: OverlayOptions): readonly string[] {
  return options.moduleSpecifiers ?? (options.moduleSpecifier ? [options.moduleSpecifier] : ["@sqlbraid/template"]);
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true, allowJs: false };
}

function dialectForModule(moduleSpecifier: string | undefined, options: OverlayOptions): Dialect {
  if (options.dialect) return options.dialect;
  if (moduleSpecifier?.includes("mysql")) return { id: "mysql", placeholder: () => "?", quoteIdentifier: (identifier) => `\`${identifier.replaceAll("`", "``")}\``, lexicalProfile: { lineCommentPrefixes: ["--", "#"], supportsNestedBlockComments: false, supportsDollarQuotes: false, backslashEscapes: true } };
  if (moduleSpecifier?.includes("sqlite")) return { id: "sqlite", placeholder: () => "?", quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`, lexicalProfile: { lineCommentPrefixes: ["--", "#"], supportsNestedBlockComments: false, supportsDollarQuotes: false, backslashEscapes: false } };
  return postgresDialect;
}

interface ImportBindings {
  readonly named: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlyMap<string, string>;
  readonly defaults: ReadonlyMap<string, string>;
}

function importBindings(sourceFile: ts.SourceFile, options: OverlayOptions): ImportBindings {
  const named = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const defaults = new Map<string, string>();
  const tagExport = options.tagExport ?? "sql";
  const modules = new Set(configuredModules(options));
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !modules.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name && tagExport === "default") defaults.set(clause.name.text, statement.moduleSpecifier.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, statement.moduleSpecifier.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === tagExport) named.set(element.name.text, statement.moduleSpecifier.text);
    }
  }
  return { named, namespaces, defaults };
}

function isShadowed(identifier: ts.Identifier): boolean {
  let current: ts.Node | undefined = identifier.parent;
  while (current) {
    if (ts.isFunctionLike(current) && current.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text)) return true;
    if (ts.isCatchClause(current) && current.variableDeclaration && ts.isIdentifier(current.variableDeclaration.name) && current.variableDeclaration.name.text === identifier.text) return true;
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      for (const statement of current.statements) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text) return true;
        if (ts.isClassDeclaration(statement) && statement.name?.text === identifier.text) return true;
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === identifier.text) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

interface UnwrappedTag {
  readonly expression: ts.Expression;
  readonly expectedType?: string;
}

function unwrapTag(tag: ts.Expression): UnwrappedTag {
  if (!ts.isCallExpression(tag)) return { expression: tag };
  const expectedType = tag.typeArguments?.length ? tag.typeArguments.map((argument) => argument.getText()).join(", ") : undefined;
  return { expression: tag.expression, ...(expectedType ? { expectedType } : {}) };
}

function resolvedModulePath(moduleSpecifier: string, sourceFile: ts.SourceFile, options: OverlayOptions): string | undefined {
  return ts.resolveModuleName(moduleSpecifier, sourceFile.fileName, options.compilerOptions ?? defaultCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName;
}

function checkerTagModule(expression: ts.Expression, sourceFile: ts.SourceFile, options: OverlayOptions): string | undefined {
  const checker = options.typeChecker;
  if (!checker) return undefined;
  const symbolNode = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  let symbol = checker.getSymbolAtLocation(symbolNode);
  if (!symbol) return undefined;
  while ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased === symbol) break;
    symbol = aliased;
  }
  const declarations = symbol.declarations ?? [];
  for (const moduleSpecifier of configuredModules(options)) {
    const resolved = resolvedModulePath(moduleSpecifier, sourceFile, options);
    if (!resolved) continue;
    const canonical = ts.sys.resolvePath(resolved);
    if (declarations.some((declaration) => ts.sys.resolvePath(declaration.getSourceFile().fileName) === canonical)) return moduleSpecifier;
  }
  return undefined;
}

function tagIdentity(tag: ts.Expression, bindings: ImportBindings, tagExport: string, sourceFile: ts.SourceFile, options: OverlayOptions, expectedType?: string): { readonly name?: string; readonly moduleSpecifier?: string; readonly expectedType?: string } {
  const unwrapped = unwrapTag(tag);
  const expression = unwrapped.expression;
  const contract = expectedType ?? unwrapped.expectedType;
  if (ts.isIdentifier(expression)) {
    if (!isShadowed(expression)) {
      const moduleSpecifier = bindings.named.get(expression.text) ?? bindings.defaults.get(expression.text);
      if (moduleSpecifier) return { name: expression.text, moduleSpecifier, ...(contract ? { expectedType: contract } : {}) };
    }
  } else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.name.text === tagExport && bindings.namespaces.has(expression.expression.text) && !isShadowed(expression.expression)) {
    return { name: expression.getText(sourceFile), moduleSpecifier: bindings.namespaces.get(expression.expression.text), ...(contract ? { expectedType: contract } : {}) };
  }
  const moduleSpecifier = checkerTagModule(expression, sourceFile, options);
  return moduleSpecifier ? { name: expression.getText(sourceFile), moduleSpecifier, ...(contract ? { expectedType: contract } : {}) } : { ...(contract ? { expectedType: contract } : {}) };
}

interface ExtractedTemplate {
  readonly strings: readonly string[];
  readonly bindings: readonly BindingSite[];
  readonly expressions: readonly ts.Expression[];
  readonly templateRange: SourceRange;
}

function extractTemplate(node: ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression, sourceFile: ts.SourceFile): ExtractedTemplate {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { strings: [node.text], bindings: [], expressions: [], templateRange: range(node, sourceFile) };
  const strings: string[] = [node.head.text];
  const bindings: BindingSite[] = [];
  const expressions: ts.Expression[] = [];
  for (const span of node.templateSpans) {
    bindings.push({ interpolation: bindings.length, range: range(span.expression, sourceFile), expression: span.expression.getText(sourceFile) });
    expressions.push(span.expression);
    strings.push(span.literal.text);
  }
  return { strings, bindings, expressions, templateRange: range(node, sourceFile) };
}

function emptySnapshot(dialect: string): SchemaSnapshot {
  return { formatVersion: 1, dialect, dialectVersion: "unknown", server: {}, namespaces: {}, types: {}, relations: {}, routines: {}, metadata: { completeness: "unknown" } };
}

function safeType(value: string | undefined): string {
  if (!value || value === "unknown" || value.length > 10_000) return "unknown";
  if (!/^[A-Za-z0-9_$\s{}:;,|<>()?\.\[\]"'&+\-]+$/u.test(value)) return "unknown";
  return value;
}

function rowType(semantic: SemanticResult): string {
  if (semantic.columns === "unknown") return "unknown";
  const fields = semantic.columns.map((column) => `${JSON.stringify(column.name)}: ${safeType(column.type)}${column.nullable ? " | null" : ""}`);
  return `{ ${fields.join("; ")} }`;
}

function provenSemanticRow(semantic: SemanticResult): boolean {
  return semantic.columns !== "unknown" && semantic.columns.every((column) => column.type !== "unknown" && column.type !== "any" && safeType(column.type) !== "unknown");
}

function typeNodeFromText(text: string, fileName: string): ts.TypeNode | undefined {
  if (!text.trim()) return undefined;
  const source = ts.createSourceFile(`${fileName}.type.ts`, `type __SqlBraidType = ${text};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(ts.isTypeAliasDeclaration);
  if (!declaration) return undefined;
  function detach(node: ts.Node): void {
    ts.setTextRange(node, { pos: -1, end: -1 });
    ts.forEachChild(node, detach);
  }
  detach(declaration.type);
  return declaration.type;
}

function contractDiagnostics(query: DiscoveredQuery, semantic: SemanticResult): readonly CompileDiagnostic[] {
  if (!query.expectedType || provenSemanticRow(semantic)) return [];
  return [{ code: "BRAID_CONTRACT_UNPROVEN", message: "The expected sql<T> contract cannot be verified from the available SQL evidence.", severity: "error", range: query.templateRange }];
}

function conditionIndexes(nodes: readonly TemplateNode[], output = new Set<number>()): Set<number> {
  for (const node of nodes) {
    if (node.kind === "if") {
      output.add(node.condition);
      conditionIndexes(node.children, output);
    } else if (node.kind === "choose") {
      for (const when of node.whens) {
        output.add(when.condition);
        conditionIndexes(when.children, output);
      }
      if (node.otherwise) conditionIndexes(node.otherwise, output);
    } else if (node.kind === "trim") conditionIndexes(node.children, output);
  }
  return output;
}

function hasGuard(nodes: readonly TemplateNode[]): boolean {
  return conditionIndexes(nodes).size > 0;
}

function maxInterpolation(query: DiscoveredQuery): number {
  return query.bindings.reduce((maximum, binding) => Math.max(maximum, binding.interpolation), -1);
}

function defaultAnalyze(query: DiscoveredQuery, options: OverlayOptions): InferredQueryShape {
  const dialect = dialectForModule(query.moduleSpecifier, options);
  const structural = analyzeStructuralVariants(query.ir);
  const hasChoose = query.ir.nodes.some(function containsChoose(node): boolean {
    if (node.kind === "choose") return true;
    if (node.kind === "if" || node.kind === "trim") return node.children.some(containsChoose);
    return false;
  });
  if (hasGuard(query.ir.nodes) && (!structural.localClauseAnalysis || hasChoose)) {
    return {
      rowType: "unknown",
      bindingTypes: query.bindings.map(() => "unknown"),
      diagnostics: [{ code: "BRAID_DYNAMIC_UNPROVEN", message: "Dynamic SQL changes structural SQL outside a proven local WHERE/SET clause.", severity: "error", range: query.templateRange }],
      resultKind: "unknown",
    };
  }
  const captured = new Array(Math.max(0, maxInterpolation(query) + 1)).fill(null) as unknown[];
  for (const index of conditionIndexes(query.ir.nodes)) captured[index] = true;
  let rendered;
  try {
    rendered = renderTemplateIr(query.ir, captured, dialect, options.limits);
  } catch (error) {
    return { rowType: "unknown", bindingTypes: query.bindings.map(() => "unknown"), diagnostics: [{ code: error instanceof Error && "code" in error ? String(error.code) : "BRAID_RENDER", message: error instanceof Error ? error.message : String(error), severity: "error", range: query.templateRange }], resultKind: "unknown" };
  }
  const snapshot = options.snapshot ?? emptySnapshot(dialect.id);
  const parsed = parseSql(rendered.text, { lexicalProfile: dialect.lexicalProfile });
  const semantic = resolveStatement(parsed, snapshot);
  const diagnostics: CompileDiagnostic[] = semantic.diagnostics.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message, severity: "error", range: { start: query.templateRange.start + diagnostic.start, end: query.templateRange.start + diagnostic.end } }));
  if (options.snapshot && snapshot.dialect !== dialect.id) diagnostics.push({ code: "BRAID_DIALECT_MISMATCH", message: `Snapshot dialect ${snapshot.dialect} cannot analyze ${dialect.id} SQL.`, severity: "error", range: query.templateRange });
  if (options.typePolicy && snapshot.metadata.typePolicyId && (snapshot.metadata.typePolicyId !== options.typePolicy.id || snapshot.metadata.typePolicyHash && snapshot.metadata.typePolicyHash !== options.typePolicy.hash)) diagnostics.push({ code: "BRAID_POLICY_MISMATCH", message: "Schema snapshot type policy does not match the compiler policy.", severity: "error", range: query.templateRange });
  if (!options.snapshot && semantic.statementKind !== "unknown" && /\b(?:FROM|UPDATE|INTO|JOIN|CALL)\b/u.test(rendered.text)) diagnostics.push({ code: "BRAID_SNAPSHOT_REQUIRED", message: "A schema snapshot is required for relation and routine analysis.", severity: "error", range: query.templateRange });
  const bindingTypes: (string | "unknown")[] = query.bindings.map(() => "unknown");
  for (const mapping of rendered.bindingMap ?? []) {
    if (mapping.interpolation === undefined) continue;
    const expectation = semantic.binds.find((bind) => bind.placeholder === mapping.placeholder);
    if (expectation) bindingTypes[mapping.interpolation] = expectation.type;
  }
  diagnostics.push(...contractDiagnostics(query, semantic));
  return { rowType: diagnostics.length || !provenSemanticRow(semantic) ? "unknown" : rowType(semantic), bindingTypes, diagnostics, resultKind: semantic.resultKind, semantic };
}

export function discoverQueries(sourceText: string, fileName: string, options: OverlayOptions): SourceAnalysisResult {
  const sourceFile = sourceFileFor(sourceText, fileName, options);
  const bindings = importBindings(sourceFile, options);
  const tagExport = options.tagExport ?? "sql";
  const queries: DiscoveredQuery[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  function visit(node: ts.Node): void {
    if (ts.isTaggedTemplateExpression(node)) {
      const expectedType = node.typeArguments?.length ? node.typeArguments.map((argument) => argument.getText(sourceFile)).join(", ") : undefined;
      const identity = tagIdentity(node.tag, bindings, tagExport, sourceFile, options, expectedType);
      if (identity.name && identity.moduleSpecifier) {
        const extracted = extractTemplate(node.template, sourceFile);
        try {
          const query: DiscoveredQuery = { tagName: identity.name, moduleSpecifier: identity.moduleSpecifier, range: range(node, sourceFile), templateRange: extracted.templateRange, strings: extracted.strings, bindings: extracted.bindings, ir: parseTemplate(createTemplateStrings(extracted.strings), dialectForModule(identity.moduleSpecifier, options).lexicalProfile, options.limits?.maxNestingDepth), ...(identity.expectedType ? { expectedType: identity.expectedType } : {}) };
          queries.push(query);
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "BRAID_TEMPLATE";
          diagnostics.push({ code, message: error instanceof Error ? error.message : String(error), severity: "error", range: range(node.template, sourceFile) });
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
  readonly resultKind?: "rows" | "command" | "call" | "unknown";
}

export interface VirtualTypeScriptOverlay {
  readonly sourceFileName: string;
  readonly sourceText: string;
  readonly virtualSourceText: string;
  readonly queryTypes: readonly OverlayQueryType[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

interface NameAllocator {
  fresh(base: string): string;
}

function createNameAllocator(sourceFile: ts.SourceFile): NameAllocator {
  const used = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return {
    fresh(base: string): string {
      let candidate = base;
      let suffix = 0;
      while (used.has(candidate)) {
        suffix += 1;
        candidate = `${base}_${suffix}`;
      }
      used.add(candidate);
      return candidate;
    },
  };
}

function expressionNodesFor(template: ts.TemplateLiteral): readonly ts.Expression[] {
  return ts.isTemplateExpression(template) ? template.templateSpans.map((span) => span.expression) : [];
}

function topLevelAwaitOrYield(node: ts.Expression): boolean {
  if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  let found = false;
  function visit(current: ts.Node): void {
    if (current !== node && ts.isFunctionLike(current)) return;
    if (ts.isAwaitExpression(current) || ts.isYieldExpression(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function queryTypeNode(factory: ts.NodeFactory, rowTypeText: string, resultKind: "rows" | "command" | "call" | "unknown"): ts.TypeNode {
  const rowType = typeNodeFromText(safeType(rowTypeText), "sqlbraid-inferred") ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  const kind = factory.createLiteralTypeNode(factory.createStringLiteral(resultKind));
  return factory.createImportTypeNode(factory.createLiteralTypeNode(factory.createStringLiteral("@sqlbraid/core")), undefined, factory.createIdentifier("Query"), [rowType, kind], false);
}

function unknownTypeNode(factory: ts.NodeFactory): ts.TypeNode {
  return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}

function elementAssignment(factory: ts.NodeFactory, valuesName: string, interpolation: number, expression: ts.Expression): ts.Statement {
  return factory.createExpressionStatement(factory.createBinaryExpression(factory.createElementAccessExpression(factory.createIdentifier(valuesName), factory.createNumericLiteral(interpolation)), factory.createToken(ts.SyntaxKind.EqualsToken), expression));
}

function expectCall(factory: ts.NodeFactory, helperName: string, expectedType: ts.TypeNode, expression: ts.Expression): ts.Expression {
  return factory.createCallExpression(factory.createIdentifier(helperName), [expectedType], [expression]);
}

function expectStatement(factory: ts.NodeFactory, helperName: string, expectedTypeText: string, expression: ts.Expression): ts.Statement | undefined {
  const expectedType = typeNodeFromText(expectedTypeText, "sqlbraid-expected");
  return expectedType ? factory.createExpressionStatement(expectCall(factory, helperName, expectedType, expression)) : undefined;
}

interface CaptureContext {
  readonly factory: ts.NodeFactory;
  readonly valuesName: string;
  readonly expressions: readonly ts.Expression[];
  readonly bindingTypes: readonly (string | "unknown")[];
  readonly expectationNames: ReadonlyMap<number, string>;
  readonly checkerMode: boolean;
  readonly readName?: string;
}

function expressionAt(context: CaptureContext, interpolation: number): ts.Expression {
  return context.expressions[interpolation] ?? context.factory.createIdentifier("undefined");
}

function readCall(context: CaptureContext, interpolation: number): ts.Expression {
  if (!context.readName) return expressionAt(context, interpolation);
  const thunk = context.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, expressionAt(context, interpolation));
  return context.factory.createCallExpression(context.factory.createIdentifier(context.readName), undefined, [context.factory.createNumericLiteral(interpolation), thunk]);
}

function captureStatements(nodes: readonly TemplateNode[], context: CaptureContext): readonly ts.Statement[] {
  const statements: ts.Statement[] = [];
  for (const node of nodes) {
    if (node.kind === "bind") {
      const expression = expressionAt(context, node.interpolation);
      statements.push(context.checkerMode ? elementAssignment(context.factory, context.valuesName, node.interpolation, expression) : context.factory.createExpressionStatement(readCall(context, node.interpolation)));
      if (context.checkerMode) {
        const expected = context.bindingTypes[node.interpolation];
        const helper = context.expectationNames.get(node.interpolation);
        if (expected && expected !== "unknown" && helper) {
          const check = expectStatement(context.factory, helper, expected, expression);
          if (check) statements.push(check);
        }
      }
      continue;
    }
    if (node.kind === "if") {
      const thenStatements = [...(context.checkerMode ? [elementAssignment(context.factory, context.valuesName, node.condition, context.factory.createTrue())] : []), ...captureStatements(node.children, context)];
      const elseStatements = context.checkerMode ? [elementAssignment(context.factory, context.valuesName, node.condition, context.factory.createFalse())] : [];
      statements.push(context.factory.createIfStatement(context.checkerMode ? expressionAt(context, node.condition) : context.factory.createCallExpression(context.factory.createPropertyAccessExpression(context.factory.createIdentifier("globalThis"), "Boolean"), undefined, [readCall(context, node.condition)]), context.factory.createBlock(thenStatements, true), context.factory.createBlock(elseStatements, true)));
      continue;
    }
    if (node.kind === "choose") {
      const choose = chooseStatement(node.whens, node.otherwise, 0, context);
      if (choose) statements.push(choose);
      continue;
    }
    if (node.kind === "trim") statements.push(...captureStatements(node.children, context));
  }
  return statements;
}

function chooseStatement(whens: readonly { readonly condition: number; readonly children: readonly TemplateNode[] }[], otherwise: readonly TemplateNode[] | undefined, index: number, context: CaptureContext): ts.Statement | undefined {
  if (index >= whens.length) return otherwise ? context.factory.createBlock(captureStatements(otherwise, context), true) : undefined;
  const when = whens[index];
  const thenStatements = [...(context.checkerMode ? [elementAssignment(context.factory, context.valuesName, when.condition, context.factory.createTrue())] : []), ...captureStatements(when.children, context)];
  const next = chooseStatement(whens, otherwise, index + 1, context);
  return context.factory.createIfStatement(context.checkerMode ? expressionAt(context, when.condition) : context.factory.createCallExpression(context.factory.createPropertyAccessExpression(context.factory.createIdentifier("globalThis"), "Boolean"), undefined, [readCall(context, when.condition)]), context.factory.createBlock(thenStatements, true), next);
}

function captureSetup(factory: ts.NodeFactory, valuesName: string, evaluatedName: string, readName: string): readonly ts.Statement[] {
  const evaluated = factory.createVariableStatement(undefined, factory.createVariableDeclarationList([factory.createVariableDeclaration(factory.createIdentifier(evaluatedName), undefined, undefined, factory.createNewExpression(factory.createPropertyAccessExpression(factory.createIdentifier("globalThis"), "Set"), undefined, []))], ts.NodeFlags.Const));
  const index = factory.createParameterDeclaration(undefined, undefined, factory.createIdentifier("index"), undefined, factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword), undefined);
  const thunk = factory.createParameterDeclaration(undefined, undefined, factory.createIdentifier("thunk"), undefined, factory.createFunctionTypeNode(undefined, [], factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)), undefined);
  const seen = factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier(evaluatedName), "has"), undefined, [factory.createIdentifier("index")]);
  const store = factory.createExpressionStatement(factory.createBinaryExpression(factory.createElementAccessExpression(factory.createIdentifier(valuesName), factory.createIdentifier("index")), factory.createToken(ts.SyntaxKind.EqualsToken), factory.createCallExpression(factory.createIdentifier("thunk"), undefined, [])));
  const mark = factory.createExpressionStatement(factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier(evaluatedName), "add"), undefined, [factory.createIdentifier("index")]));
  const read = factory.createVariableStatement(undefined, factory.createVariableDeclarationList([factory.createVariableDeclaration(factory.createIdentifier(readName), undefined, undefined, factory.createArrowFunction(undefined, undefined, [index, thunk], undefined, undefined, factory.createBlock([factory.createIfStatement(factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, seen), factory.createBlock([store, mark], true)), factory.createReturnStatement(factory.createElementAccessExpression(factory.createIdentifier(valuesName), factory.createIdentifier("index")))], true)))], ts.NodeFlags.Const));
  return [evaluated, read];
}

function stringsArray(factory: ts.NodeFactory, strings: readonly string[]): ts.ArrayLiteralExpression {
  return factory.createArrayLiteralExpression(strings.map((value) => factory.createStringLiteral(value)), false);
}

function taggedWithoutTypeArguments(factory: ts.NodeFactory, tag: ts.Expression, template: ts.TemplateLiteral): ts.TaggedTemplateExpression {
  const unwrapped = unwrapTag(tag);
  return factory.createTaggedTemplateExpression(unwrapped.expression, undefined, template);
}

function contractValue(factory: ts.NodeFactory, rowTypeText: string): ts.Expression {
  const inferred = typeNodeFromText(safeType(rowTypeText), "sqlbraid-contract-inferred") ?? unknownTypeNode(factory);
  return factory.createAsExpression(factory.createAsExpression(factory.createNull(), unknownTypeNode(factory)), inferred);
}

interface ExpectationOrigin {
  readonly helperName: string;
  readonly range: SourceRange;
  readonly interpolation: number;
}

interface ContractOrigin {
  readonly helperName: string;
  readonly range: SourceRange;
}

interface LoweredSource {
  readonly sourceText: string;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly origins: readonly SourceMapOrigin[];
  readonly expectations: readonly ExpectationOrigin[];
  readonly contracts: readonly ContractOrigin[];
  readonly transformer: ts.TransformerFactory<ts.SourceFile>;
}

function queryKey(rangeValue: SourceRange): string {
  return `${rangeValue.start}:${rangeValue.end}`;
}

function createExpectDeclaration(factory: ts.NodeFactory, helperName: string): ts.FunctionDeclaration {
  const typeParameter = factory.createTypeParameterDeclaration(undefined, factory.createIdentifier("T"), undefined, undefined);
  const parameter = factory.createParameterDeclaration(undefined, undefined, factory.createIdentifier("value"), undefined, factory.createTypeReferenceNode(factory.createIdentifier("T"), undefined), undefined);
  return factory.createFunctionDeclaration([factory.createModifier(ts.SyntaxKind.DeclareKeyword)], undefined, factory.createIdentifier(helperName), [typeParameter], [parameter], factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword), undefined);
}

interface LoweringPlan {
  readonly transformer: ts.TransformerFactory<ts.SourceFile>;
  readonly diagnostics: CompileDiagnostic[];
  readonly expectations: readonly ExpectationOrigin[];
  readonly contracts: readonly ContractOrigin[];
  readonly loweredNodes: ReadonlyMap<string, ts.Node>;
}

function withOriginal<T extends ts.Node>(node: T, original: ts.Node): T {
  return ts.setTextRange(ts.setOriginalNode(node, original), original);
}

function directivePrologueEnd(statements: readonly ts.Statement[]): number {
  let index = 0;
  while (index < statements.length) {
    const statement = statements[index];
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    index += 1;
  }
  return index;
}

function insertGeneratedStatements(sourceFile: ts.SourceFile, generated: readonly ts.Statement[]): ts.SourceFile {
  if (!generated.length) return sourceFile;
  const index = directivePrologueEnd(sourceFile.statements);
  return ts.factory.updateSourceFile(sourceFile, [...sourceFile.statements.slice(0, index), ...generated, ...sourceFile.statements.slice(index)]);
}

function createLoweringPlan(sourceFile: ts.SourceFile, discovered: SourceAnalysisResult, options: OverlayOptions, mode: "runtime" | "checker"): LoweringPlan {
  const factory = ts.factory;
  const allocator = createNameAllocator(sourceFile);
  const inferred = new Map<DiscoveredQuery, InferredQueryShape>();
  for (const query of discovered.queries) inferred.set(query, options.analyze?.(query) ?? defaultAnalyze(query, options));
  const queryByKey = new Map(discovered.queries.map((query) => [queryKey(query.range), query]));
  const expectationNames = new Map<string, string>();
  const expectationOrigins: ExpectationOrigin[] = [];
  const contractNames = new Map<string, string>();
  const contractOrigins: ContractOrigin[] = [];
  let captureName: string | undefined;
  const valuesNames = new Map<string, string>();
  const evaluatedNames = new Map<string, string>();
  const readNames = new Map<string, string>();
  for (const query of discovered.queries) {
    const shape = inferred.get(query);
    if (!shape) continue;
    if (hasGuard(query.ir.nodes)) {
      captureName ??= allocator.fresh("__sqlbraidCapture");
      const key = queryKey(query.range);
      valuesNames.set(key, allocator.fresh("__sqlbraidValues"));
      evaluatedNames.set(key, allocator.fresh("__sqlbraidEvaluated"));
      readNames.set(key, allocator.fresh("__sqlbraidRead"));
    }
    if (mode !== "checker") continue;
    for (const binding of query.bindings) {
      const expected = shape.bindingTypes?.[binding.interpolation] ?? "unknown";
      if (expected === "unknown") continue;
      const helperName = allocator.fresh("__sqlbraidExpect");
      expectationNames.set(`${queryKey(query.range)}:${binding.interpolation}`, helperName);
      expectationOrigins.push({ helperName, range: binding.range, interpolation: binding.interpolation });
    }
    if (query.expectedType) {
      const helperName = allocator.fresh("__sqlbraidContract");
      contractNames.set(queryKey(query.range), helperName);
      contractOrigins.push({ helperName, range: query.templateRange });
    }
  }
  const loweredNodes = new Map<string, ts.Node>();
  const diagnostics = [...discovered.diagnostics];
  for (const query of discovered.queries) {
    const shape = inferred.get(query);
    if (shape?.diagnostics) diagnostics.push(...shape.diagnostics);
    if (query.expectedType && (!shape || safeType(shape.rowType) === "unknown")) diagnostics.push({ code: "BRAID_CONTRACT_UNPROVEN", message: "The expected sql<T> contract cannot be verified from the available SQL evidence.", severity: "error", range: query.templateRange });
    if (mode === "checker" && shape) for (const binding of query.bindings) {
      const expected = shape.bindingTypes?.[binding.interpolation] ?? "unknown";
      if (expected !== "unknown" && !typeNodeFromText(expected, "sqlbraid-bind-expected")) diagnostics.push({ code: "BRAID_BIND_UNPROVEN", message: `The expected bind type is not a valid TypeScript type: ${expected}.`, severity: "error", range: binding.range });
    }
  }
  const prefix: ts.Statement[] = [];
  if (mode === "checker") {
    const helperNames = [...expectationOrigins.map((origin) => origin.helperName), ...contractOrigins.map((origin) => origin.helperName)];
    prefix.push(...helperNames.map((name) => createExpectDeclaration(factory, name)));
  }
  if (captureName) {
    prefix.push(factory.createImportDeclaration(undefined, factory.createImportClause(false, undefined, factory.createNamedImports([factory.createImportSpecifier(false, factory.createIdentifier("capture"), factory.createIdentifier(captureName))])), factory.createStringLiteral("@sqlbraid/template"), undefined));
  }
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    function visit(node: ts.Node): ts.VisitResult<ts.Node> {
      const originalKey = ts.isTaggedTemplateExpression(node) ? queryKey({ start: node.getStart(), end: node.getEnd() }) : undefined;
      const updated = ts.visitEachChild(node, visit, context);
      if (!ts.isTaggedTemplateExpression(updated) || !originalKey) return updated;
      const query = queryByKey.get(originalKey);
      if (!query) return updated;
      const shape = inferred.get(query) ?? { rowType: "unknown", bindingTypes: query.bindings.map(() => "unknown" as const), resultKind: "unknown" as const };
      const expressions = expressionNodesFor(updated.template);
      if (hasGuard(query.ir.nodes) && expressions.some(topLevelAwaitOrYield)) {
        diagnostics.push({ code: "BRAID_ASYNC_CONTEXT", message: "Guarded templates cannot be lowered in an await/yield expression context.", severity: "error", range: query.templateRange });
        loweredNodes.set(originalKey, updated);
        return updated;
      }
      const tag = unwrapTag(updated.tag).expression;
      const key = queryKey(query.range);
      const baseQuery = taggedWithoutTypeArguments(factory, tag, updated.template);
      const resultKind = shape.resultKind ?? "rows";
      const assertion = withOriginal(factory.createAsExpression(baseQuery, queryTypeNode(factory, shape.rowType, resultKind)), node);
      let replacement: ts.Expression = assertion;
      if (hasGuard(query.ir.nodes)) {
        const valuesName = valuesNames.get(key) ?? allocator.fresh("__sqlbraidValues");
        const bindingTypeMap = shape.bindingTypes ?? query.bindings.map(() => "unknown" as const);
        const localExpectations = new Map<number, string>();
        for (const binding of query.bindings) {
          const helper = expectationNames.get(`${key}:${binding.interpolation}`);
          if (helper) localExpectations.set(binding.interpolation, helper);
        }
        const captureContext: CaptureContext = { factory, valuesName, expressions, bindingTypes: bindingTypeMap, expectationNames: localExpectations, checkerMode: mode === "checker", ...(mode === "runtime" ? { readName: readNames.get(key) } : {}) };
        const body = mode === "runtime"
          ? [...captureSetup(factory, valuesName, evaluatedNames.get(key) ?? allocator.fresh("__sqlbraidEvaluated"), readNames.get(key) ?? allocator.fresh("__sqlbraidRead")), ...captureStatements(query.ir.nodes, captureContext)]
          : captureStatements(query.ir.nodes, captureContext);
        const callback = factory.createArrowFunction(undefined, undefined, [factory.createParameterDeclaration(undefined, undefined, factory.createIdentifier(valuesName), undefined, undefined, undefined)], undefined, undefined, factory.createBlock(body, true));
        const captureCall = withOriginal(factory.createCallExpression(factory.createIdentifier(captureName ?? "__sqlbraidCapture"), undefined, [tag, stringsArray(factory, query.strings), callback]), node);
        replacement = withOriginal(factory.createAsExpression(captureCall, queryTypeNode(factory, shape.rowType, resultKind)), node);
      }
      const contractName = contractNames.get(key);
      if (mode === "checker" && contractName && query.expectedType) {
        const expectedType = updated.typeArguments?.[0] ?? typeNodeFromText(query.expectedType, "sqlbraid-contract-expected");
        if (expectedType) replacement = withOriginal(factory.createParenthesizedExpression(factory.createCommaListExpression([expectCall(factory, contractName, expectedType, contractValue(factory, shape.rowType)), replacement])), node);
      }
      if (mode === "checker" && !hasGuard(query.ir.nodes)) {
        const checks: ts.Expression[] = [];
        for (const binding of query.bindings) {
          const expected = shape.bindingTypes?.[binding.interpolation] ?? "unknown";
          const helper = expectationNames.get(`${key}:${binding.interpolation}`);
          const expression = expressions[binding.interpolation];
          if (expected !== "unknown" && helper && expression) {
            const expectedType = typeNodeFromText(expected, "sqlbraid-bind-expected");
            if (expectedType) checks.push(expectCall(factory, helper, expectedType, expression));
          }
        }
        if (checks.length) replacement = withOriginal(factory.createParenthesizedExpression(factory.createCommaListExpression([...checks, replacement])), node);
      }
      loweredNodes.set(originalKey, replacement);
      return replacement;
    }
    return (root) => {
      if (ts.sys.resolvePath(root.fileName) !== ts.sys.resolvePath(sourceFile.fileName)) return root;
      return insertGeneratedStatements(ts.visitNode(root, visit) as ts.SourceFile, prefix);
    };
  };
  return { transformer, diagnostics, expectations: expectationOrigins, contracts: contractOrigins, loweredNodes };
}

function lowerSourceFile(sourceFile: ts.SourceFile, discovered: SourceAnalysisResult, options: OverlayOptions, mode: "runtime" | "checker"): LoweredSource {
  const plan = createLoweringPlan(sourceFile, discovered, options, mode);
  const transformed = ts.transform(sourceFile, [plan.transformer]);
  const transformedFile = transformed.transformed[0];
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const output = printer.printFile(transformedFile);
  const origins: SourceMapOrigin[] = [];
  let searchStart = 0;
  for (const query of [...discovered.queries].sort((left, right) => left.range.start - right.range.start)) {
    const node = plan.loweredNodes.get(queryKey(query.range));
    if (!node) continue;
    const text = printer.printNode(ts.EmitHint.Expression, node, transformedFile);
    const generatedStart = output.indexOf(text, searchStart);
    if (generatedStart < 0) continue;
    origins.push({ generatedStart, generatedEnd: generatedStart + text.length, sourceStart: query.range.start, sourceEnd: query.range.end });
    searchStart = generatedStart + text.length;
  }
  for (const origin of [...plan.expectations.map((value) => ({ helperName: value.helperName, range: value.range })), ...plan.contracts.map((value) => ({ helperName: value.helperName, range: value.range }))]) {
    let search = 0;
    const needle = `${origin.helperName}<`;
    while (search < output.length) {
      const generatedStart = output.indexOf(needle, search);
      if (generatedStart < 0) break;
      const generatedEnd = output.indexOf(";", generatedStart);
      origins.push({ generatedStart, generatedEnd: generatedEnd < 0 ? output.length : generatedEnd + 1, sourceStart: origin.range.start, sourceEnd: origin.range.end });
      search = generatedEnd < 0 ? output.length : generatedEnd + 1;
    }
  }
  transformed.dispose();
  return { sourceText: output, diagnostics: plan.diagnostics, origins, expectations: plan.expectations, contracts: plan.contracts, transformer: plan.transformer };
}

export function createVirtualOverlay(sourceText: string, fileName: string, options: OverlayOptions): VirtualTypeScriptOverlay {
  const sourceFile = sourceFileFor(sourceText, fileName, options);
  const discovered = discoverQueries(sourceText, fileName, { ...options, sourceFile });
  const queryTypes: OverlayQueryType[] = [];
  const diagnostics = [...discovered.diagnostics];
  for (const query of discovered.queries) {
    const inferred = options.analyze?.(query) ?? defaultAnalyze(query, options);
    queryTypes.push({ range: query.range, rowType: inferred.rowType, bindingTypes: inferred.bindingTypes ?? query.bindings.map(() => "unknown" as const), ...(inferred.resultKind ? { resultKind: inferred.resultKind } : {}) });
    if (inferred.diagnostics) diagnostics.push(...inferred.diagnostics);
  }
  const transformed = lowerSourceFile(sourceFile, discovered, options, "runtime");
  diagnostics.push(...transformed.diagnostics);
  return { sourceFileName: fileName, sourceText, virtualSourceText: transformed.sourceText, queryTypes, diagnostics };
}

export interface TransformedSource {
  readonly sourceText: string;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly origins?: readonly SourceMapOrigin[];
}

export function transformSource(sourceText: string, fileName: string, options: OverlayOptions): TransformedSource {
  const sourceFile = sourceFileFor(sourceText, fileName, options);
  const discovered = discoverQueries(sourceText, fileName, { ...options, sourceFile });
  const transformed = lowerSourceFile(sourceFile, discovered, options, "runtime");
  return { sourceText: transformed.sourceText, diagnostics: transformed.diagnostics, origins: transformed.origins };
}

function virtualSourceFile(name: string, text: string, languageVersion: ts.ScriptTarget, original?: ts.SourceFile, impliedNodeFormat?: ts.ModuleKind.ESNext | ts.ModuleKind.CommonJS): ts.SourceFile {
  const sourceFile = ts.createSourceFile(name, text, languageVersion, true, original ? sourceFileScriptKind(original) : scriptKindForFileName(name));
  if (original?.impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = original.impliedNodeFormat;
  else if (impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = impliedNodeFormat;
  return sourceFile;
}

function virtualHost(compilerOptions: ts.CompilerOptions, virtualFiles: ReadonlyMap<string, string>, originalFiles: ReadonlyMap<string, ts.SourceFile> = new Map()): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  return {
    ...defaultHost,
    getSourceFile(name, languageVersion: ts.ScriptTarget) {
      const text = virtualFiles.get(ts.sys.resolvePath(name));
      if (text === undefined) return defaultHost.getSourceFile(name, languageVersion);
      return virtualSourceFile(name, text, languageVersion, originalFiles.get(ts.sys.resolvePath(name)), impliedNodeFormatForFileName(name, compilerOptions));
    },
    readFile(name) {
      return virtualFiles.get(ts.sys.resolvePath(name)) ?? defaultHost.readFile(name);
    },
    fileExists(name) {
      return virtualFiles.has(ts.sys.resolvePath(name)) || defaultHost.fileExists(name);
    },
  };
}

function sourceHost(compilerOptions: ts.CompilerOptions, fileName: string, sourceText: string): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const canonical = ts.sys.resolvePath(fileName);
  return {
    ...defaultHost,
    getSourceFile(name, languageVersion: ts.ScriptTarget) {
      return ts.sys.resolvePath(name) === canonical ? virtualSourceFile(name, sourceText, languageVersion, undefined, impliedNodeFormatForFileName(name, compilerOptions)) : defaultHost.getSourceFile(name, languageVersion);
    },
    readFile(name) {
      return ts.sys.resolvePath(name) === canonical ? sourceText : defaultHost.readFile(name);
    },
    fileExists(name) {
      return ts.sys.resolvePath(name) === canonical || defaultHost.fileExists(name);
    },
  };
}

function sourceFileInProgram(program: ts.Program, fileName: string): ts.SourceFile | undefined {
  const canonical = ts.sys.resolvePath(fileName);
  return program.getSourceFiles().find((sourceFile) => ts.sys.resolvePath(sourceFile.fileName) === canonical);
}

function mapGeneratedRange(record: FileRecord, start: number, end: number): SourceRange {
  const origin = record.lowered.origins.filter((candidate) => start >= candidate.generatedStart && start <= candidate.generatedEnd).sort((left, right) => (left.generatedEnd - left.generatedStart) - (right.generatedEnd - right.generatedStart))[0];
  if (origin) {
    const query = record.discovered.queries.find((candidate) => candidate.range.start === origin.sourceStart && candidate.range.end === origin.sourceEnd);
    if (query) {
      const generatedQuery = record.lowered.sourceText.slice(origin.generatedStart, origin.generatedEnd);
      for (const binding of query.bindings) {
        const bindingOffset = generatedQuery.indexOf(binding.expression);
        if (bindingOffset >= 0 && start >= origin.generatedStart + bindingOffset && start <= origin.generatedStart + bindingOffset + binding.expression.length) return binding.range;
      }
    }
    return { start: origin.sourceStart, end: origin.sourceEnd };
  }
  const snippet = record.lowered.sourceText.slice(start, end);
  if (snippet) {
    const sourceStart = record.sourceText.indexOf(snippet);
    if (sourceStart >= 0) return { start: sourceStart, end: sourceStart + snippet.length };
  }
  const nearest = record.discovered.queries.reduce<{ readonly distance: number; readonly query?: DiscoveredQuery }>((best, query) => {
    const distance = Math.abs(query.range.start - start);
    return distance < best.distance ? { distance, query } : best;
  }, { distance: Number.POSITIVE_INFINITY });
  return nearest.query?.templateRange ?? { start: 0, end: Math.min(1, record.sourceText.length) };
}

interface FileRecord {
  readonly fileName: string;
  readonly sourceText: string;
  readonly discovered: SourceAnalysisResult;
  readonly lowered: LoweredSource;
}

function addDiagnostic(output: CompileDiagnostic[], seen: Set<string>, diagnostic: CompileDiagnostic): void {
  const key = `${diagnostic.code}:${diagnostic.range.start}:${diagnostic.range.end}:${diagnostic.message}`;
  if (seen.has(key)) return;
  seen.add(key);
  output.push(diagnostic);
}

function contractHasUnexpectedKeys(checker: ts.TypeChecker, actual: ts.Type, expected: ts.Type): boolean {
  if (!expected.isUnion() && checker.getPropertiesOfType(checker.getApparentType(expected)).length === 0) return false;
  const candidates = expected.isUnion() ? expected.types : [expected];
  const actualNames = checker.getPropertiesOfType(checker.getApparentType(actual)).map((property) => property.name);
  return !candidates.some((candidate) => {
    if (!checker.isTypeAssignableTo(actual, candidate)) return false;
    const expectedNames = new Set(checker.getPropertiesOfType(checker.getApparentType(candidate)).map((property) => property.name));
    return actualNames.every((name) => expectedNames.has(name));
  });
}

function helperCall(sourceFile: ts.SourceFile, helperName: string): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === helperName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function checkVirtualRecords(records: readonly FileRecord[], virtualProgram: ts.Program): readonly CompileDiagnostic[] {
  const checker = virtualProgram.getTypeChecker();
  const diagnostics: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  for (const record of records) for (const diagnostic of record.lowered.diagnostics) addDiagnostic(diagnostics, seen, diagnostic);
  for (const diagnostic of ts.getPreEmitDiagnostics(virtualProgram)) {
    if (!diagnostic.file) {
      addDiagnostic(diagnostics, seen, { code: `TS${diagnostic.code}`, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), severity: "error", range: { start: 0, end: 0 } });
      continue;
    }
    const record = records.find((candidate) => ts.sys.resolvePath(candidate.fileName) === ts.sys.resolvePath(diagnostic.file?.fileName ?? ""));
    if (!record) continue;
    const start = diagnostic.start ?? 0;
    const end = start + (diagnostic.length ?? 1);
    const generatedFile = virtualProgram.getSourceFile(diagnostic.file.fileName);
    const helperRanges = [...record.lowered.expectations.map((origin) => origin.helperName), ...record.lowered.contracts.map((origin) => origin.helperName)].flatMap((helperName) => {
      const call = generatedFile ? helperCall(generatedFile, helperName) : undefined;
      return call ? [{ start: call.getStart(generatedFile), end: call.getEnd() }] : [];
    });
    if ((diagnostic.code === 2322 || diagnostic.code === 2345) && helperRanges.some((rangeValue) => start >= rangeValue.start && start <= rangeValue.end)) continue;
    addDiagnostic(diagnostics, seen, { code: `TS${diagnostic.code}`, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), severity: "error", range: mapGeneratedRange(record, start, end) });
  }
  for (const record of records) {
    const sourceFile = sourceFileInProgram(virtualProgram, record.fileName);
    if (!sourceFile) continue;
    for (const origin of record.lowered.expectations) {
      const call = helperCall(sourceFile, origin.helperName);
      if (!call || !call.typeArguments?.[0] || !call.arguments[0]) continue;
      const actual = checker.getTypeAtLocation(call.arguments[0]);
      const expected = checker.getTypeFromTypeNode(call.typeArguments[0]);
      if (!checker.isTypeAssignableTo(actual, expected)) {
        addDiagnostic(diagnostics, seen, { code: "BRAID_BIND_TYPE", message: `Binding ${origin.interpolation} expects ${checker.typeToString(expected)}, received ${checker.typeToString(actual)}.`, severity: "error", range: origin.range });
      }
    }
    for (const origin of record.lowered.contracts) {
      const query = record.discovered.queries.find((candidate) => candidate.templateRange.start === origin.range.start);
      if (!query?.expectedType) continue;
      const call = helperCall(sourceFile, origin.helperName);
      if (!call || !call.typeArguments?.[0] || !call.arguments[0]) continue;
      const actual = checker.getTypeAtLocation(call.arguments[0]);
      const expected = checker.getTypeFromTypeNode(call.typeArguments[0]);
      if (!checker.isTypeAssignableTo(actual, expected)) addDiagnostic(diagnostics, seen, { code: "BRAID_CONTRACT_TYPE", message: `The inferred SQL row type ${checker.typeToString(actual)} is not assignable to ${checker.typeToString(expected)}.`, severity: "error", range: origin.range });
      else if (contractHasUnexpectedKeys(checker, actual, expected)) addDiagnostic(diagnostics, seen, { code: "BRAID_CONTRACT_KEYS", message: `The inferred SQL row type ${checker.typeToString(actual)} has fields outside the contract ${checker.typeToString(expected)}.`, severity: "error", range: origin.range });
    }
  }
  return diagnostics;
}

function compilerOptionsFor(options: TypeScriptCheckOptions): ts.CompilerOptions {
  return { ...defaultCompilerOptions(), ...options.compilerOptions };
}

export function checkSource(sourceText: string, fileName: string, options: TypeScriptCheckOptions): readonly CompileDiagnostic[] {
  const compilerOptions = compilerOptionsFor(options);
  const originalProgram = ts.createProgram([fileName], compilerOptions, sourceHost(compilerOptions, fileName, sourceText));
  const originalSourceFile = sourceFileInProgram(originalProgram, fileName) ?? sourceFileFor(sourceText, fileName, { ...options, compilerOptions });
  const fileOptions = { ...options, compilerOptions, sourceFile: originalSourceFile, typeChecker: originalProgram.getTypeChecker() };
  const discovered = discoverQueries(sourceText, fileName, fileOptions);
  const lowered = lowerSourceFile(originalSourceFile, discovered, fileOptions, "checker");
  const records: FileRecord[] = [{ fileName, sourceText, discovered, lowered }];
  const virtualFiles = new Map([[ts.sys.resolvePath(fileName), lowered.sourceText]]);
  const originalFiles = new Map([[ts.sys.resolvePath(fileName), originalSourceFile]]);
  const virtualProgram = ts.createProgram([fileName], compilerOptions, virtualHost(compilerOptions, virtualFiles, originalFiles));
  return checkVirtualRecords(records, virtualProgram);
}

function readProject(projectFile: string, compilerOptionsOverride?: ts.CompilerOptions): { readonly compilerOptions: ts.CompilerOptions; readonly fileNames: readonly string[] } {
  const normalizedProjectFile = ts.sys.resolvePath(projectFile);
  const config = ts.readConfigFile(normalizedProjectFile, ts.sys.readFile);
  if (config.error) throw new Error(`TS${config.error.code}: ${ts.flattenDiagnosticMessageText(config.error.messageText, " ")}`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(normalizedProjectFile), compilerOptionsOverride, normalizedProjectFile);
  if (parsed.errors.length) throw new Error(parsed.errors.map((diagnostic) => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`).join("\n"));
  return { compilerOptions: parsed.options, fileNames: parsed.fileNames };
}

export function createProjectContext(projectFile: string, options: Pick<TypeScriptCheckOptions, "compilerOptions"> = {}): TypeScriptProjectContext {
  const parsed = readProject(projectFile, options.compilerOptions);
  const compilerOptions = { ...parsed.compilerOptions, ...options.compilerOptions };
  const program = ts.createProgram(parsed.fileNames, compilerOptions);
  return { projectFile: ts.sys.resolvePath(projectFile), compilerOptions, fileNames: parsed.fileNames, program, checker: program.getTypeChecker() };
}

export function checkProject(projectFile: string, options: TypeScriptCheckOptions = {}): readonly CompileDiagnostic[] {
  try {
    const context = createProjectContext(projectFile, options);
    const records: FileRecord[] = [];
    const virtualFiles = new Map<string, string>();
    const originalFiles = new Map<string, ts.SourceFile>();
    for (const fileName of context.fileNames) {
      const sourceFile = sourceFileInProgram(context.program, fileName);
      const sourceText = sourceFile?.text ?? ts.sys.readFile(fileName);
      if (sourceText === undefined || !sourceFile) continue;
      const fileOptions = { ...options, compilerOptions: context.compilerOptions, sourceFile, typeChecker: context.checker };
      const discovered = discoverQueries(sourceText, fileName, fileOptions);
      const lowered = lowerSourceFile(sourceFile, discovered, fileOptions, "checker");
      records.push({ fileName, sourceText, discovered, lowered });
      virtualFiles.set(ts.sys.resolvePath(fileName), lowered.sourceText);
      originalFiles.set(ts.sys.resolvePath(fileName), sourceFile);
    }
    const virtualProgram = ts.createProgram(context.fileNames, context.compilerOptions, virtualHost(context.compilerOptions, virtualFiles, originalFiles));
    return checkVirtualRecords(records, virtualProgram);
  } catch (error) {
    return [{ code: "BRAID_PROJECT_CONFIG", message: error instanceof Error ? error.message : String(error), severity: "error", range: { start: 0, end: 0 } }];
  }
}

function emitCompilerOptions(options: OverlayOptions): ts.CompilerOptions {
  const provided = options.compilerOptions ?? {};
  const module = provided.module ?? ts.ModuleKind.NodeNext;
  const compilerOptions: ts.CompilerOptions = {
    ...defaultCompilerOptions(),
    target: provided.target ?? ts.ScriptTarget.ES2022,
    module,
    moduleResolution: provided.moduleResolution ?? (module === ts.ModuleKind.Node16 || module === ts.ModuleKind.NodeNext ? ts.ModuleResolutionKind.NodeNext : ts.ModuleResolutionKind.Node10),
    sourceMap: provided.inlineSourceMap ? false : provided.sourceMap ?? true,
    ...provided,
    noEmit: false,
  };
  if (compilerOptions.inlineSourceMap) compilerOptions.sourceMap = false;
  return compilerOptions;
}

export function emitSource(sourceText: string, fileName: string, options: OverlayOptions): { readonly outputText: string; readonly sourceMapText?: string; readonly diagnostics: readonly CompileDiagnostic[] } {
  const compilerOptions = emitCompilerOptions(options);
  const originalProgram = ts.createProgram([fileName], compilerOptions, sourceHost(compilerOptions, fileName, sourceText));
  const originalSourceFile = sourceFileInProgram(originalProgram, fileName) ?? sourceFileFor(sourceText, fileName, { ...options, compilerOptions });
  const fileOptions = { ...options, compilerOptions, sourceFile: originalSourceFile };
  const discovered = discoverQueries(sourceText, fileName, fileOptions);
  const transformed = lowerSourceFile(originalSourceFile, discovered, fileOptions, "runtime");
  let outputText = "";
  let sourceMapText: string | undefined;
  const emitted = originalProgram.emit(undefined, (outputFileName, text) => {
    if (outputFileName.endsWith(".map")) sourceMapText = text;
    else if (!outputFileName.endsWith(".d.ts")) outputText = text;
  }, undefined, false, { before: [transformed.transformer] });
  const diagnostics = [...transformed.diagnostics, ...(emitted.diagnostics ?? []).map((diagnostic) => {
    const start = diagnostic.start ?? 0;
    const end = start + (diagnostic.length ?? 1);
    return { code: `TS${diagnostic.code}`, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), severity: "error" as const, range: { start, end } };
  })];
  if (sourceMapText && transformed.origins) {
    try {
      const sourceMap = JSON.parse(sourceMapText) as Record<string, unknown>;
      sourceMap.x_sqlbraid_origins = transformed.origins;
      sourceMapText = JSON.stringify(sourceMap);
    } catch {
      sourceMapText = sourceMapText;
    }
  }
  return { outputText, ...(sourceMapText ? { sourceMapText } : {}), diagnostics };
}

export function sourcePosition(sourceText: string, offset: number): { readonly line: number; readonly character: number } {
  const safeOffset = Math.max(0, Math.min(offset, sourceText.length));
  const prefix = sourceText.slice(0, safeOffset);
  const lines = prefix.split(/\r\n|\r|\n/u);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}
