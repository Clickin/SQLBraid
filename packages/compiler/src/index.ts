import ts from "typescript";
import { dirname } from "node:path";
import { parseTemplate, postgresDialect } from "@sqlbraid/template";
import type { Dialect, QueryResultKind, TemplateIr, TemplateNode } from "@sqlbraid/core";

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
  readonly declaredRowType?: string;
  readonly declaredResultKind: QueryResultKind;
}

export interface CompileDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly range: SourceRange;
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
  readonly limits?: { readonly maxNestingDepth?: number };
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

function explicitResultKind(expression: ts.Expression): "rows" | "command" | "call" | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  return expression.name.text === "rows" || expression.name.text === "command" || expression.name.text === "call" ? expression.name.text : undefined;
}

function importedTagModule(expression: ts.Expression, bindings: ImportBindings, tagExport: string): string | undefined {
  if (ts.isIdentifier(expression)) return bindings.named.get(expression.text) ?? bindings.defaults.get(expression.text);
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (expression.name.text === tagExport && ts.isIdentifier(expression.expression)) return bindings.namespaces.get(expression.expression.text);
  if (explicitResultKind(expression)) return importedTagModule(expression.expression, bindings, tagExport);
  return undefined;
}

function tagRoot(expression: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression) && explicitResultKind(expression)) return tagRoot(expression.expression);
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) return expression.expression;
  return undefined;
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

function tagIdentity(expression: ts.Expression, bindings: ImportBindings, tagExport: string, sourceFile: ts.SourceFile, options: OverlayOptions): { readonly name?: string; readonly moduleSpecifier?: string; readonly declaredResultKind: QueryResultKind } {
  const kind = explicitResultKind(expression);
  const root = tagRoot(expression);
  const moduleSpecifier = root && !isShadowed(root) ? importedTagModule(expression, bindings, tagExport) : undefined;
  const checkedModule = moduleSpecifier ?? (kind && root ? checkerTagModule(root, sourceFile, options) : undefined) ?? checkerTagModule(expression, sourceFile, options);
  return { ...(checkedModule ? { name: expression.getText(sourceFile), moduleSpecifier: checkedModule } : {}), declaredResultKind: kind ?? "unknown" };
}

interface ExtractedTemplate {
  readonly strings: readonly string[];
  readonly bindings: readonly BindingSite[];
  readonly templateRange: SourceRange;
}

function extractTemplate(node: ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression, sourceFile: ts.SourceFile): ExtractedTemplate {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { strings: [node.text], bindings: [], templateRange: range(node, sourceFile) };
  const strings: string[] = [node.head.text];
  const bindings: BindingSite[] = [];
  for (const span of node.templateSpans) {
    bindings.push({ interpolation: bindings.length, range: range(span.expression, sourceFile), expression: span.expression.getText(sourceFile) });
    strings.push(span.literal.text);
  }
  return { strings, bindings, templateRange: range(node, sourceFile) };
}

function hasGuard(nodes: readonly TemplateNode[]): boolean {
  return nodes.some((node) => node.kind === "if" || node.kind === "choose" || node.kind === "trim" && hasGuard(node.children));
}

export function discoverQueries(sourceText: string, fileName: string, options: OverlayOptions): SourceAnalysisResult {
  const sourceFile = sourceFileFor(sourceText, fileName, options);
  const bindings = importBindings(sourceFile, options);
  const tagExport = options.tagExport ?? "sql";
  const queries: DiscoveredQuery[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  function visit(node: ts.Node): void {
    if (ts.isTaggedTemplateExpression(node)) {
      const identity = tagIdentity(node.tag, bindings, tagExport, sourceFile, options);
      const declaredRowType = identity.declaredResultKind === "unknown" ? undefined : node.typeArguments?.[0]?.getText(sourceFile);
      if (identity.name && identity.moduleSpecifier) {
        const extracted = extractTemplate(node.template, sourceFile);
        try {
          const query: DiscoveredQuery = { tagName: identity.name, moduleSpecifier: identity.moduleSpecifier, range: range(node, sourceFile), templateRange: extracted.templateRange, strings: extracted.strings, bindings: extracted.bindings, ir: parseTemplate(createTemplateStrings(extracted.strings), dialectForModule(identity.moduleSpecifier, options).lexicalProfile, options.limits?.maxNestingDepth), ...(declaredRowType ? { declaredRowType } : {}), declaredResultKind: identity.declaredResultKind };
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
  readonly resultKind: QueryResultKind;
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

function elementAssignment(factory: ts.NodeFactory, valuesName: string, interpolation: number, expression: ts.Expression): ts.Statement {
  return factory.createExpressionStatement(factory.createBinaryExpression(factory.createElementAccessExpression(factory.createIdentifier(valuesName), factory.createNumericLiteral(interpolation)), factory.createToken(ts.SyntaxKind.EqualsToken), expression));
}

interface CaptureContext {
  readonly factory: ts.NodeFactory;
  readonly valuesName: string;
  readonly expressions: readonly ts.Expression[];
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

interface LoweredSource {
  readonly sourceText: string;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly origins: readonly SourceMapOrigin[];
  readonly transformer: ts.TransformerFactory<ts.SourceFile>;
}

function queryKey(rangeValue: SourceRange): string {
  return `${rangeValue.start}:${rangeValue.end}`;
}

interface LoweringPlan {
  readonly transformer: ts.TransformerFactory<ts.SourceFile>;
  readonly diagnostics: CompileDiagnostic[];
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

function createLoweringPlan(sourceFile: ts.SourceFile, discovered: SourceAnalysisResult, mode: "runtime" | "checker"): LoweringPlan {
  const factory = ts.factory;
  const allocator = createNameAllocator(sourceFile);
  const queryByKey = new Map(discovered.queries.map((query) => [queryKey(query.range), query]));
  let captureName: string | undefined;
  const valuesNames = new Map<string, string>();
  const evaluatedNames = new Map<string, string>();
  const readNames = new Map<string, string>();
  for (const query of discovered.queries) {
    if (hasGuard(query.ir.nodes)) {
      captureName ??= allocator.fresh("__sqlbraidCapture");
      const key = queryKey(query.range);
      valuesNames.set(key, allocator.fresh("__sqlbraidValues"));
      evaluatedNames.set(key, allocator.fresh("__sqlbraidEvaluated"));
      readNames.set(key, allocator.fresh("__sqlbraidRead"));
    }
  }
  const loweredNodes = new Map<string, ts.Node>();
  const diagnostics = [...discovered.diagnostics];
  const prefix: ts.Statement[] = [];
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
      if (!hasGuard(query.ir.nodes)) {
        loweredNodes.set(originalKey, updated);
        return updated;
      }
      const expressions = expressionNodesFor(updated.template);
      if (expressions.some(topLevelAwaitOrYield)) {
        diagnostics.push({ code: "BRAID_ASYNC_CONTEXT", message: "Guarded templates cannot be lowered in an await/yield expression context.", severity: "error", range: query.templateRange });
        loweredNodes.set(originalKey, updated);
        return updated;
      }
      const key = queryKey(query.range);
      const valuesName = valuesNames.get(key) ?? allocator.fresh("__sqlbraidValues");
      const captureContext: CaptureContext = { factory, valuesName, expressions, checkerMode: mode === "checker", ...(mode === "runtime" ? { readName: readNames.get(key) } : {}) };
      const body = mode === "runtime"
        ? [...captureSetup(factory, valuesName, evaluatedNames.get(key) ?? allocator.fresh("__sqlbraidEvaluated"), readNames.get(key) ?? allocator.fresh("__sqlbraidRead")), ...captureStatements(query.ir.nodes, captureContext)]
        : captureStatements(query.ir.nodes, captureContext);
      const callback = factory.createArrowFunction(undefined, undefined, [factory.createParameterDeclaration(undefined, undefined, factory.createIdentifier(valuesName), undefined, undefined, undefined)], undefined, undefined, factory.createBlock(body, true));
      const typeArguments = updated.typeArguments ?? (query.declaredResultKind === "command"
        ? [factory.createImportTypeNode(factory.createLiteralTypeNode(factory.createStringLiteral("@sqlbraid/core")), undefined, factory.createIdentifier("CommandResult"), undefined, false)]
        : undefined);
      const tag = typeArguments ? factory.createExpressionWithTypeArguments(updated.tag, typeArguments) : updated.tag;
      const replacement = withOriginal(factory.createCallExpression(factory.createIdentifier(captureName ?? "__sqlbraidCapture"), undefined, [tag, stringsArray(factory, query.strings), callback]), node);
      loweredNodes.set(originalKey, replacement);
      return replacement;
    }
    return (root) => {
      if (ts.sys.resolvePath(root.fileName) !== ts.sys.resolvePath(sourceFile.fileName)) return root;
      return insertGeneratedStatements(ts.visitNode(root, visit) as ts.SourceFile, prefix);
    };
  };
  return { transformer, diagnostics, loweredNodes };
}

function lowerSourceFile(sourceFile: ts.SourceFile, discovered: SourceAnalysisResult, mode: "runtime" | "checker"): LoweredSource {
  const plan = createLoweringPlan(sourceFile, discovered, mode);
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
  transformed.dispose();
  return { sourceText: output, diagnostics: plan.diagnostics, origins, transformer: plan.transformer };
}

export function createVirtualOverlay(sourceText: string, fileName: string, options: OverlayOptions): VirtualTypeScriptOverlay {
  const sourceFile = sourceFileFor(sourceText, fileName, options);
  const discovered = discoverQueries(sourceText, fileName, { ...options, sourceFile });
  const queryTypes: OverlayQueryType[] = discovered.queries.map((query) => ({
    range: query.range,
    rowType: query.declaredRowType ?? (query.declaredResultKind === "command" ? 'import("@sqlbraid/core").CommandResult' : "unknown"),
    resultKind: query.declaredResultKind,
  }));
  const transformed = lowerSourceFile(sourceFile, discovered, "runtime");
  return { sourceFileName: fileName, sourceText, virtualSourceText: transformed.sourceText, queryTypes, diagnostics: transformed.diagnostics };
}

export interface TransformedSource {
  readonly sourceText: string;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly origins?: readonly SourceMapOrigin[];
}

export function transformSource(sourceText: string, fileName: string, options: OverlayOptions): TransformedSource {
  const sourceFile = sourceFileFor(sourceText, fileName, options);
  const discovered = discoverQueries(sourceText, fileName, { ...options, sourceFile });
  const transformed = lowerSourceFile(sourceFile, discovered, "runtime");
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

function checkVirtualRecords(records: readonly FileRecord[], virtualProgram: ts.Program): readonly CompileDiagnostic[] {
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
    addDiagnostic(diagnostics, seen, { code: `TS${diagnostic.code}`, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), severity: "error", range: mapGeneratedRange(record, start, end) });
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
  const lowered = lowerSourceFile(originalSourceFile, discovered, "checker");
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
      const lowered = lowerSourceFile(sourceFile, discovered, "checker");
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
  const fileOptions = { ...options, compilerOptions, sourceFile: originalSourceFile, typeChecker: originalProgram.getTypeChecker() };
  const discovered = discoverQueries(sourceText, fileName, fileOptions);
  const transformed = lowerSourceFile(originalSourceFile, discovered, "runtime");
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
