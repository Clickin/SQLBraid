import ts from "typescript";
import { dirname } from "node:path";
import { GenMapping, addSegment, setSourceContent, toEncodedMap } from "@jridgewell/gen-mapping";
import { parseTemplate, postgresDialect } from "@sqlbraid/template";
import {
  AUTHORING_MODULE_CATALOG,
  type Dialect,
  type QueryResultKind,
  type TemplateIr,
  type TemplateNode,
} from "@sqlbraid/core";

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
  readonly rawStrings: readonly string[];
  readonly bindings: readonly BindingSite[];
  readonly ir: TemplateIr;
  readonly mappedRow: boolean;
  readonly resultSchemaExpression?: string;
  readonly resultSchemaRange?: SourceRange;
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

export interface DetailedCheckResult {
  readonly braidDiagnostics: readonly CompileDiagnostic[];
  readonly nativeTypeScriptDiagnostics: readonly CompileDiagnostic[];
  readonly overlayTypeScriptDiagnostics: readonly CompileDiagnostic[];
  readonly overlayOnlyDiagnostics: readonly CompileDiagnostic[];
}

export interface TypeScriptProjectContext {
  readonly projectFile: string;
  readonly compilerOptions: ts.CompilerOptions;
  readonly fileNames: readonly string[];
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
}

export interface TypeScriptSourceContext {
  readonly compilerOptions: ts.CompilerOptions;
  readonly program: ts.Program;
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
}

export interface SourceMapOrigin {
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface SourceMap {
  readonly version: 3;
  readonly file?: string | null;
  readonly sources: readonly (string | null)[];
  readonly sourcesContent?: readonly (string | null)[];
  readonly names: readonly string[];
  readonly mappings: string;
  readonly x_sqlbraid_origins?: readonly SourceMapOrigin[];
}

export interface TransformSourceOptions extends OverlayOptions {}

export interface TransformSourceResult {
  readonly code: string;
  readonly map: SourceMap | null;
  readonly diagnostics: readonly CompileDiagnostic[];
}

function range(node: ts.Node, sourceFile: ts.SourceFile): SourceRange {
  return { start: node.getStart(sourceFile), end: node.getEnd() };
}

function createTemplateStrings(values: readonly string[], rawValues: readonly string[] = values): TemplateStringsArray {
  if (values.length !== rawValues.length)
    throw new TypeError("Template cooked/raw segments must have matching lengths.");
  const strings = [...values] as string[] & { raw?: readonly string[] };
  const raw = Object.freeze([...rawValues]);
  Object.defineProperty(strings, "raw", { value: raw });
  return Object.freeze(strings) as unknown as TemplateStringsArray;
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
  return (
    (sourceFile as ts.SourceFile & { readonly scriptKind?: ts.ScriptKind }).scriptKind ??
    scriptKindForFileName(sourceFile.fileName)
  );
}

function impliedNodeFormatForFileName(
  fileName: string,
  compilerOptions: ts.CompilerOptions,
): ts.ModuleKind.ESNext | ts.ModuleKind.CommonJS | undefined {
  if (compilerOptions.module !== ts.ModuleKind.Node16 && compilerOptions.module !== ts.ModuleKind.NodeNext)
    return undefined;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".mts") || lower.endsWith(".mjs")) return ts.ModuleKind.ESNext;
  if (lower.endsWith(".cts") || lower.endsWith(".cjs")) return ts.ModuleKind.CommonJS;
  return undefined;
}

function sourceFileFor(sourceText: string, fileName: string, options: OverlayOptions): ts.SourceFile {
  const original =
    options.sourceFile && ts.sys.resolvePath(options.sourceFile.fileName) === ts.sys.resolvePath(fileName)
      ? options.sourceFile
      : undefined;
  if (original?.text === sourceText) return original;
  const languageVersion = original?.languageVersion ?? options.compilerOptions?.target ?? ts.ScriptTarget.Latest;
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    languageVersion,
    true,
    original ? sourceFileScriptKind(original) : scriptKindForFileName(fileName),
  );
  if (original?.impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = original.impliedNodeFormat;
  else {
    const impliedNodeFormat = impliedNodeFormatForFileName(
      fileName,
      options.compilerOptions ?? defaultCompilerOptions(),
    );
    if (impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = impliedNodeFormat;
  }
  return sourceFile;
}

function configuredModules(options: OverlayOptions): readonly string[] {
  return (
    options.moduleSpecifiers ??
    (options.moduleSpecifier
      ? [options.moduleSpecifier]
      : AUTHORING_MODULE_CATALOG.map(({ moduleSpecifier }) => moduleSpecifier))
  );
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
  };
}

function dialectForModule(moduleSpecifier: string | undefined, options: OverlayOptions): Dialect {
  if (options.dialect) return options.dialect;
  const dialectId = AUTHORING_MODULE_CATALOG.find((entry) => entry.moduleSpecifier === moduleSpecifier)?.dialectId;
  if (dialectId === "oracle")
    return {
      id: "oracle",
      quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
      lexicalProfile: {
        lineCommentPrefixes: ["--"],
        supportsNestedBlockComments: false,
        supportsDollarQuotes: false,
        backslashEscapes: false,
        supportsOracleQQuotes: true,
      },
    };
  if (dialectId === "mssql")
    return {
      id: "mssql",
      quoteIdentifier: (identifier) => `[${identifier.replaceAll("]", "]]")}]`,
      lexicalProfile: {
        lineCommentPrefixes: ["--"],
        supportsNestedBlockComments: true,
        supportsDollarQuotes: false,
        supportsBracketIdentifiers: true,
        backslashEscapes: false,
      },
    };
  if (dialectId === "mysql" || dialectId === "mariadb")
    return {
      id: dialectId,
      quoteIdentifier: (identifier) => `\`${identifier.replaceAll("`", "``")}\``,
      lexicalProfile: {
        lineCommentPrefixes: ["--", "#"],
        doubleDashRequiresWhitespace: true,
        supportsNestedBlockComments: false,
        supportsDollarQuotes: false,
        supportsBacktickIdentifiers: true,
        backslashEscapes: true,
      },
    };
  if (dialectId === "sqlite")
    return {
      id: "sqlite",
      quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
      lexicalProfile: {
        lineCommentPrefixes: ["--"],
        lineCommentTerminators: "\n",
        supportsNestedBlockComments: false,
        supportsDollarQuotes: false,
        supportsBacktickIdentifiers: true,
        supportsBracketIdentifiers: true,
        backslashEscapes: false,
      },
    };
  return postgresDialect;
}

interface LexicalScope {
  readonly parent?: LexicalScope;
  readonly bindings: Map<string, ts.Identifier>;
  readonly variableScope: boolean;
}

function lexicalBindingOwner(sourceFile: ts.SourceFile): (identifier: ts.Identifier) => ts.Identifier | undefined {
  const scopes = new Map<ts.Node, LexicalScope>();
  const root: LexicalScope = { bindings: new Map(), variableScope: true };
  scopes.set(sourceFile, root);
  function bind(name: ts.BindingName, scope: LexicalScope): void {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, name);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name, scope);
  }
  function visit(node: ts.Node, scope: LexicalScope): void {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
      node.name
    )
      bind(node.name, scope);
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) bind(node.name, scope);
    if (ts.isFunctionLike(node)) {
      const parameters: LexicalScope = { parent: scope, bindings: new Map(), variableScope: true };
      scopes.set(node, parameters);
      if (ts.isFunctionExpression(node) && node.name) bind(node.name, parameters);
      // Defaults see parameters and the enclosing scope, never declarations in the body.
      ts.forEachChild(node, (child) => {
        const owner = ts.isParameter(child) || ("body" in node && child === node.body) ? parameters : scope;
        scopes.set(child, owner);
        visit(child, owner);
      });
      return;
    }
    if (
      ts.isBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isClassLike(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isModuleBlock(node)
    ) {
      scope = {
        parent: scope,
        bindings: new Map(),
        variableScope:
          ts.isModuleBlock(node) ||
          (ts.isBlock(node) && (ts.isFunctionLike(node.parent) || ts.isClassStaticBlockDeclaration(node.parent))),
      };
      scopes.set(node, scope);
      if (ts.isClassLike(node) && node.name) bind(node.name, scope);
    }
    if (ts.isVariableDeclaration(node)) {
      let owner = scope;
      if (ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped))
        while (!owner.variableScope && owner.parent) owner = owner.parent;
      bind(node.name, owner);
    } else if (ts.isParameter(node)) bind(node.name, scope);
    else if (ts.isImportClause(node) && !node.isTypeOnly && node.name) bind(node.name, scope);
    else if (ts.isNamespaceImport(node) && !node.parent.isTypeOnly) bind(node.name, scope);
    else if (ts.isImportSpecifier(node) && !node.isTypeOnly && !node.parent.parent.isTypeOnly) bind(node.name, scope);
    else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) bind(node.name, scope);
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(sourceFile, root);
  return (identifier) => {
    let node: ts.Node | undefined = identifier;
    while (node && !scopes.has(node)) node = node.parent;
    for (let scope = node && scopes.get(node); scope; scope = scope.parent) {
      const binding = scope.bindings.get(identifier.text);
      if (binding) return binding;
    }
    return undefined;
  };
}

interface ImportedBinding {
  readonly name: ts.Identifier;
  readonly moduleSpecifier: string;
}

interface ImportBindings {
  readonly named: ReadonlyMap<string, ImportedBinding>;
  readonly namespaces: ReadonlyMap<string, ImportedBinding>;
  readonly defaults: ReadonlyMap<string, ImportedBinding>;
  readonly owner: (identifier: ts.Identifier) => ts.Identifier | undefined;
}

function importBindings(sourceFile: ts.SourceFile, options: OverlayOptions): ImportBindings {
  const named = new Map<string, ImportedBinding>();
  const namespaces = new Map<string, ImportedBinding>();
  const defaults = new Map<string, ImportedBinding>();
  const tagExport = options.tagExport ?? "sql";
  const modules = new Set(configuredModules(options));
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !modules.has(statement.moduleSpecifier.text)
    )
      continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (clause.name && tagExport === "default")
      defaults.set(clause.name.text, { name: clause.name, moduleSpecifier });
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, { name: bindings.name, moduleSpecifier });
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === tagExport) named.set(element.name.text, { name: element.name, moduleSpecifier });
    }
  }
  return {
    named,
    namespaces,
    defaults,
    owner: lexicalBindingOwner(sourceFile),
  };
}

function explicitResultKind(expression: ts.Expression): "rows" | "command" | "call" | undefined {
  if (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "call"
  )
    return "call";
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  return expression.name.text === "rows" || expression.name.text === "command" || expression.name.text === "call"
    ? expression.name.text
    : undefined;
}

function mappedRowsCall(expression: ts.Expression): ts.CallExpression | undefined {
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) return undefined;
  return ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "rows"
    ? expression
    : undefined;
}

function tagExpression(expression: ts.Expression): ts.Expression {
  return mappedRowsCall(expression)?.expression ?? expression;
}

function importedTagModule(expression: ts.Expression, bindings: ImportBindings, tagExport: string): string | undefined {
  if (ts.isIdentifier(expression)) {
    const binding = bindings.named.get(expression.text) ?? bindings.defaults.get(expression.text);
    return binding && bindings.owner(expression) === binding.name ? binding.moduleSpecifier : undefined;
  }
  if (ts.isCallExpression(expression) && explicitResultKind(expression) === "call")
    return importedTagModule(expression.expression, bindings, tagExport);
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (expression.name.text === tagExport && ts.isIdentifier(expression.expression)) {
    const binding = bindings.namespaces.get(expression.expression.text);
    return binding && bindings.owner(expression.expression) === binding.name ? binding.moduleSpecifier : undefined;
  }
  if (explicitResultKind(expression)) return importedTagModule(expression.expression, bindings, tagExport);
  return undefined;
}

function tagOwner(expression: ts.Expression): ts.Expression {
  expression = tagExpression(expression);
  if (ts.isCallExpression(expression) && explicitResultKind(expression) === "call")
    return tagOwner(expression.expression);
  if (ts.isPropertyAccessExpression(expression) && explicitResultKind(expression))
    return tagOwner(expression.expression);
  return expression;
}

function resolvedModulePath(
  moduleSpecifier: string,
  sourceFile: ts.SourceFile,
  options: OverlayOptions,
): string | undefined {
  return ts.resolveModuleName(
    moduleSpecifier,
    sourceFile.fileName,
    options.compilerOptions ?? defaultCompilerOptions(),
    ts.sys,
  ).resolvedModule?.resolvedFileName;
}

function checkerTagModule(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  options: OverlayOptions,
  checker: ts.TypeChecker,
  bindings: ImportBindings,
): string | undefined {
  const modules = configuredModules(options);
  const tagExport = options.tagExport ?? "sql";
  const visited = new Set<ts.Symbol>();
  function unalias(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  }
  function exportedTag(moduleSpecifier: ts.Expression, name: string): string | undefined {
    if (!ts.isStringLiteral(moduleSpecifier)) return undefined;
    if (name === tagExport && modules.includes(moduleSpecifier.text)) return moduleSpecifier.text;
    const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier);
    const exported = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === name);
    return exported && symbolTag(exported);
  }
  function symbolTag(symbol: ts.Symbol): string | undefined {
    if (visited.has(symbol)) return undefined;
    visited.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isImportSpecifier(declaration)) {
        const clause = declaration.parent.parent;
        if (declaration.isTypeOnly || clause.isTypeOnly) return undefined;
        return exportedTag(clause.parent.moduleSpecifier, (declaration.propertyName ?? declaration.name).text);
      }
      if (ts.isImportClause(declaration)) {
        if (declaration.isTypeOnly) return undefined;
        return exportedTag(declaration.parent.moduleSpecifier, "default");
      }
      if (ts.isExportSpecifier(declaration)) {
        const owner = declaration.parent.parent;
        if (declaration.isTypeOnly || owner.isTypeOnly) return undefined;
        if (owner.moduleSpecifier)
          return exportedTag(owner.moduleSpecifier, (declaration.propertyName ?? declaration.name).text);
        const local = checker.getExportSpecifierLocalTargetSymbol(declaration);
        return local && symbolTag(local);
      }
    }
    const target = unalias(symbol);
    if (target !== symbol) return symbolTag(target);
    for (const moduleSpecifier of modules) {
      const resolved = resolvedModulePath(moduleSpecifier, sourceFile, options);
      if (!resolved) continue;
      const declaration = symbol.declarations?.find(
        (entry) => ts.sys.resolvePath(entry.getSourceFile().fileName) === ts.sys.resolvePath(resolved),
      );
      if (!declaration) continue;
      const moduleSymbol = checker.getSymbolAtLocation(declaration.getSourceFile());
      const exported =
        moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((entry) => entry.name === tagExport);
      if (exported && unalias(exported) === symbol) return moduleSpecifier;
    }
    return undefined;
  }
  const owner = tagOwner(expression);
  if (ts.isIdentifier(owner)) {
    const declaration = bindings.owner(owner);
    if (
      !declaration ||
      (!ts.isImportSpecifier(declaration.parent) && !ts.isImportClause(declaration.parent))
    )
      return undefined;
    const symbol = declaration && checker.getSymbolAtLocation(declaration);
    return symbol && symbolTag(symbol);
  }
  if (ts.isPropertyAccessExpression(owner) && ts.isIdentifier(owner.expression)) {
    const binding = bindings.owner(owner.expression);
    if (!binding || !ts.isNamespaceImport(binding.parent)) return undefined;
    const namespace = binding && checker.getSymbolAtLocation(binding);
    for (const declaration of namespace?.declarations ?? []) {
      if (!ts.isNamespaceImport(declaration) || declaration.parent.isTypeOnly) continue;
      return exportedTag(declaration.parent.parent.moduleSpecifier, owner.name.text);
    }
  }
  return undefined;
}

function tagIdentity(
  expression: ts.Expression,
  bindings: ImportBindings,
  tagExport: string,
  sourceFile: ts.SourceFile,
  options: OverlayOptions,
): { readonly name?: string; readonly moduleSpecifier?: string; readonly declaredResultKind: QueryResultKind } {
  const tag = tagExpression(expression);
  const kind = explicitResultKind(tag);
  const checkedModule =
    importedTagModule(tag, bindings, tagExport) ??
    (options.typeChecker ? checkerTagModule(expression, sourceFile, options, options.typeChecker, bindings) : undefined);
  return {
    ...(checkedModule ? { name: expression.getText(sourceFile), moduleSpecifier: checkedModule } : {}),
    declaredResultKind: kind ?? "unknown",
  };
}

interface ExtractedTemplate {
  readonly strings: readonly string[];
  readonly rawStrings: readonly string[];
  readonly bindings: readonly BindingSite[];
  readonly templateRange: SourceRange;
}

function extractTemplate(
  node: ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
  sourceFile: ts.SourceFile,
): ExtractedTemplate {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return {
      strings: [node.text],
      rawStrings: [sourceFile.text.slice(node.getStart(sourceFile) + 1, node.end - 1)],
      bindings: [],
      templateRange: range(node, sourceFile),
    };
  }
  const strings: string[] = [node.head.text];
  const rawStrings: string[] = [sourceFile.text.slice(node.head.getStart(sourceFile) + 1, node.head.end - 2)];
  const bindings: BindingSite[] = [];
  for (const [index, span] of node.templateSpans.entries()) {
    bindings.push({
      interpolation: bindings.length,
      range: range(span.expression, sourceFile),
      expression: span.expression.getText(sourceFile),
    });
    strings.push(span.literal.text);
    rawStrings.push(
      sourceFile.text.slice(
        span.literal.getStart(sourceFile) + 1,
        span.literal.end - (index === node.templateSpans.length - 1 ? 1 : 2),
      ),
    );
  }
  return { strings, rawStrings, bindings, templateRange: range(node, sourceFile) };
}

function hasGuard(nodes: readonly TemplateNode[]): boolean {
  return nodes.some(
    (node) => node.kind === "if" || node.kind === "choose" || (node.kind === "trim" && hasGuard(node.children)),
  );
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
      const declaredRowType =
        identity.declaredResultKind === "unknown" ? undefined : node.typeArguments?.[0]?.getText(sourceFile);
      if (identity.name && identity.moduleSpecifier) {
        const extracted = extractTemplate(node.template, sourceFile);
        const schemaCall = mappedRowsCall(node.tag);
        const resultSchema = schemaCall?.arguments[0];
        try {
          const query: DiscoveredQuery = {
            tagName: identity.name,
            moduleSpecifier: identity.moduleSpecifier,
            range: range(node, sourceFile),
            templateRange: extracted.templateRange,
            strings: extracted.strings,
            rawStrings: extracted.rawStrings,
            bindings: extracted.bindings,
            ir: parseTemplate(
              createTemplateStrings(extracted.strings, extracted.rawStrings),
              dialectForModule(identity.moduleSpecifier, options).lexicalProfile,
              options.limits?.maxNestingDepth,
            ),
            mappedRow: identity.declaredResultKind === "rows" && resultSchema !== undefined,
            ...(resultSchema
              ? {
                  resultSchemaExpression: resultSchema.getText(sourceFile),
                  resultSchemaRange: range(resultSchema, sourceFile),
                }
              : {}),
            ...(declaredRowType ? { declaredRowType } : {}),
            declaredResultKind: identity.declaredResultKind,
          };
          queries.push(query);
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "BRAID_TEMPLATE";
          diagnostics.push({
            code,
            message: error instanceof Error ? error.message : String(error),
            severity: "error",
            range: range(node.template, sourceFile),
          });
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

function typeArgumentsOf(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  const aliasTypeArguments = (type as ts.Type & { readonly aliasTypeArguments?: readonly ts.Type[] })
    .aliasTypeArguments;
  if (aliasTypeArguments?.length) return aliasTypeArguments;
  if ((type.flags & ts.TypeFlags.Object) !== 0) return checker.getTypeArguments(type as ts.TypeReference);
  return [];
}

function mappedRowType(node: ts.TaggedTemplateExpression, checker: ts.TypeChecker): string | undefined {
  const candidates: ts.Type[] = [checker.getTypeAtLocation(node)];
  const tagType = checker.getTypeAtLocation(node.tag);
  const signature = checker.getSignaturesOfType(tagType, ts.SignatureKind.Call)[0];
  if (signature) candidates.push(checker.getReturnTypeOfSignature(signature));
  for (const candidate of candidates) {
    const argumentsOfType = typeArgumentsOf(candidate, checker);
    if (argumentsOfType.length === 1)
      return checker.typeToString(argumentsOfType[0], node, ts.TypeFormatFlags.NoTruncation);
    if (argumentsOfType.length < 2) continue;
    const first = checker.typeToString(argumentsOfType[0], node, ts.TypeFormatFlags.NoTruncation);
    const second = checker.typeToString(argumentsOfType[1], node, ts.TypeFormatFlags.NoTruncation);
    if (second === '"rows"') return first;
    if (first === '"rows"') return second;
  }
  return undefined;
}

function queryNodeFor(sourceFile: ts.SourceFile, target: DiscoveredQuery): ts.TaggedTemplateExpression | undefined {
  let found: ts.TaggedTemplateExpression | undefined;
  function visit(node: ts.Node): void {
    if (found || !ts.isTaggedTemplateExpression(node)) {
      if (!found) ts.forEachChild(node, visit);
      return;
    }
    if (queryKey(range(node, sourceFile)) === queryKey(target.range)) found = node;
  }
  visit(sourceFile);
  return found;
}

function hasMappedRowsTag(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isTaggedTemplateExpression(node) && mappedRowsCall(node.tag)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
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

function elementAssignment(
  factory: ts.NodeFactory,
  valuesName: string,
  interpolation: number,
  expression: ts.Expression,
): ts.Statement {
  return factory.createExpressionStatement(
    factory.createBinaryExpression(
      factory.createElementAccessExpression(
        factory.createIdentifier(valuesName),
        factory.createNumericLiteral(interpolation),
      ),
      factory.createToken(ts.SyntaxKind.EqualsToken),
      expression,
    ),
  );
}

interface CaptureContext {
  readonly factory: ts.NodeFactory;
  readonly valuesName: string;
  readonly expressions: readonly ts.Expression[];
  readonly checkerMode: boolean;
  readonly readName?: string;
  readonly assertConditionName?: string;
}

function expressionAt(context: CaptureContext, interpolation: number): ts.Expression {
  return context.expressions[interpolation] ?? context.factory.createIdentifier("undefined");
}

function readCall(context: CaptureContext, interpolation: number): ts.Expression {
  if (!context.readName) return expressionAt(context, interpolation);
  const thunk = context.factory.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    expressionAt(context, interpolation),
  );
  return context.factory.createCallExpression(context.factory.createIdentifier(context.readName), undefined, [
    context.factory.createNumericLiteral(interpolation),
    thunk,
  ]);
}

function conditionExpression(context: CaptureContext, interpolation: number): ts.Expression {
  if (context.checkerMode) return expressionAt(context, interpolation);
  return context.factory.createCallExpression(
    context.factory.createIdentifier(context.assertConditionName ?? "__sqlbraidAssertCondition"),
    undefined,
    [readCall(context, interpolation)],
  );
}

function captureStatements(nodes: readonly TemplateNode[], context: CaptureContext): readonly ts.Statement[] {
  const statements: ts.Statement[] = [];
  for (const node of nodes) {
    if (node.kind === "bind") {
      const expression = expressionAt(context, node.interpolation);
      statements.push(
        context.checkerMode
          ? elementAssignment(context.factory, context.valuesName, node.interpolation, expression)
          : context.factory.createExpressionStatement(readCall(context, node.interpolation)),
      );
      continue;
    }
    if (node.kind === "if") {
      const thenStatements = [
        ...(context.checkerMode
          ? [elementAssignment(context.factory, context.valuesName, node.condition, context.factory.createTrue())]
          : []),
        ...captureStatements(node.children, context),
      ];
      const elseStatements = context.checkerMode
        ? [elementAssignment(context.factory, context.valuesName, node.condition, context.factory.createFalse())]
        : [];
      statements.push(
        context.factory.createIfStatement(
          conditionExpression(context, node.condition),
          context.factory.createBlock(thenStatements, true),
          context.factory.createBlock(elseStatements, true),
        ),
      );
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

function chooseStatement(
  whens: readonly { readonly condition: number; readonly children: readonly TemplateNode[] }[],
  otherwise: readonly TemplateNode[] | undefined,
  index: number,
  context: CaptureContext,
): ts.Statement | undefined {
  if (index >= whens.length)
    return otherwise ? context.factory.createBlock(captureStatements(otherwise, context), true) : undefined;
  const when = whens[index];
  const thenStatements = [
    ...(context.checkerMode
      ? [elementAssignment(context.factory, context.valuesName, when.condition, context.factory.createTrue())]
      : []),
    ...captureStatements(when.children, context),
  ];
  const next = chooseStatement(whens, otherwise, index + 1, context);
  return context.factory.createIfStatement(
    conditionExpression(context, when.condition),
    context.factory.createBlock(thenStatements, true),
    next,
  );
}

function captureSetup(
  factory: ts.NodeFactory,
  valuesName: string,
  evaluatedName: string,
  readName: string,
): readonly ts.Statement[] {
  const evaluated = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          factory.createIdentifier(evaluatedName),
          undefined,
          undefined,
          factory.createNewExpression(
            factory.createPropertyAccessExpression(factory.createIdentifier("globalThis"), "Set"),
            undefined,
            [],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
  // Runtime lowering also feeds Vite's JavaScript loader. Keep generated helpers
  // executable JavaScript; TypeScript checking uses the separate checker overlay.
  const index = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createIdentifier("index"),
    undefined,
    undefined,
    undefined,
  );
  const thunk = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createIdentifier("thunk"),
    undefined,
    undefined,
    undefined,
  );
  const seen = factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier(evaluatedName), "has"),
    undefined,
    [factory.createIdentifier("index")],
  );
  const store = factory.createExpressionStatement(
    factory.createBinaryExpression(
      factory.createElementAccessExpression(factory.createIdentifier(valuesName), factory.createIdentifier("index")),
      factory.createToken(ts.SyntaxKind.EqualsToken),
      factory.createCallExpression(factory.createIdentifier("thunk"), undefined, []),
    ),
  );
  const mark = factory.createExpressionStatement(
    factory.createCallExpression(
      factory.createPropertyAccessExpression(factory.createIdentifier(evaluatedName), "add"),
      undefined,
      [factory.createIdentifier("index")],
    ),
  );
  const read = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          factory.createIdentifier(readName),
          undefined,
          undefined,
          factory.createArrowFunction(
            undefined,
            undefined,
            [index, thunk],
            undefined,
            undefined,
            factory.createBlock(
              [
                factory.createIfStatement(
                  factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, seen),
                  factory.createBlock([store, mark], true),
                ),
                factory.createReturnStatement(
                  factory.createElementAccessExpression(
                    factory.createIdentifier(valuesName),
                    factory.createIdentifier("index"),
                  ),
                ),
              ],
              true,
            ),
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
  return [evaluated, read];
}

function stringsArray(
  factory: ts.NodeFactory,
  strings: readonly string[],
  rawStrings: readonly string[],
): ts.Expression {
  const cooked = factory.createArrayLiteralExpression(
    strings.map((value) => factory.createStringLiteral(value)),
    false,
  );
  const raw = factory.createArrayLiteralExpression(
    rawStrings.map((value) => factory.createStringLiteral(value)),
    false,
  );
  const frozenRaw = factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier("Object"), "freeze"),
    undefined,
    [raw],
  );
  const withRaw = factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier("Object"), "defineProperty"),
    undefined,
    [
      cooked,
      factory.createStringLiteral("raw"),
      factory.createObjectLiteralExpression(
        [factory.createPropertyAssignment(factory.createIdentifier("value"), frozenRaw)],
        false,
      ),
    ],
  );
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier("Object"), "freeze"),
    undefined,
    [withRaw],
  );
}

function sourceRangeExpression(factory: ts.NodeFactory, value: SourceRange): ts.ObjectLiteralExpression {
  return factory.createObjectLiteralExpression(
    [
      factory.createPropertyAssignment(factory.createIdentifier("start"), factory.createNumericLiteral(value.start)),
      factory.createPropertyAssignment(factory.createIdentifier("end"), factory.createNumericLiteral(value.end)),
    ],
    false,
  );
}

function templateNodeArray(factory: ts.NodeFactory, nodes: readonly TemplateNode[]): ts.ArrayLiteralExpression {
  return factory.createArrayLiteralExpression(
    nodes.map((node) => templateNodeExpression(factory, node)),
    false,
  );
}

function templateNodeExpression(factory: ts.NodeFactory, node: TemplateNode): ts.ObjectLiteralExpression {
  switch (node.kind) {
    case "text":
      return factory.createObjectLiteralExpression(
        [
          factory.createPropertyAssignment(factory.createIdentifier("kind"), factory.createStringLiteral(node.kind)),
          factory.createPropertyAssignment(factory.createIdentifier("text"), factory.createStringLiteral(node.text)),
          factory.createPropertyAssignment(
            factory.createIdentifier("range"),
            sourceRangeExpression(factory, node.range),
          ),
        ],
        false,
      );
    case "bind":
      return factory.createObjectLiteralExpression(
        [
          factory.createPropertyAssignment(factory.createIdentifier("kind"), factory.createStringLiteral(node.kind)),
          factory.createPropertyAssignment(
            factory.createIdentifier("interpolation"),
            factory.createNumericLiteral(node.interpolation),
          ),
          factory.createPropertyAssignment(
            factory.createIdentifier("range"),
            sourceRangeExpression(factory, node.range),
          ),
        ],
        false,
      );
    case "if":
      return factory.createObjectLiteralExpression(
        [
          factory.createPropertyAssignment(factory.createIdentifier("kind"), factory.createStringLiteral(node.kind)),
          factory.createPropertyAssignment(
            factory.createIdentifier("condition"),
            factory.createNumericLiteral(node.condition),
          ),
          factory.createPropertyAssignment(
            factory.createIdentifier("children"),
            templateNodeArray(factory, node.children),
          ),
          factory.createPropertyAssignment(
            factory.createIdentifier("range"),
            sourceRangeExpression(factory, node.range),
          ),
        ],
        false,
      );
    case "choose": {
      const properties = [
        factory.createPropertyAssignment(factory.createIdentifier("kind"), factory.createStringLiteral(node.kind)),
        factory.createPropertyAssignment(
          factory.createIdentifier("whens"),
          factory.createArrayLiteralExpression(
            node.whens.map((when) =>
              factory.createObjectLiteralExpression(
                [
                  factory.createPropertyAssignment(
                    factory.createIdentifier("condition"),
                    factory.createNumericLiteral(when.condition),
                  ),
                  factory.createPropertyAssignment(
                    factory.createIdentifier("children"),
                    templateNodeArray(factory, when.children),
                  ),
                  factory.createPropertyAssignment(
                    factory.createIdentifier("range"),
                    sourceRangeExpression(factory, when.range),
                  ),
                ],
                false,
              ),
            ),
            false,
          ),
        ),
      ];
      if (node.otherwise !== undefined)
        properties.push(
          factory.createPropertyAssignment(
            factory.createIdentifier("otherwise"),
            templateNodeArray(factory, node.otherwise),
          ),
        );
      properties.push(
        factory.createPropertyAssignment(factory.createIdentifier("range"), sourceRangeExpression(factory, node.range)),
      );
      return factory.createObjectLiteralExpression(properties, false);
    }
    case "trim":
      return factory.createObjectLiteralExpression(
        [
          factory.createPropertyAssignment(factory.createIdentifier("kind"), factory.createStringLiteral(node.kind)),
          factory.createPropertyAssignment(
            factory.createIdentifier("attributes"),
            factory.createObjectLiteralExpression(
              [
                factory.createPropertyAssignment(
                  factory.createIdentifier("prefix"),
                  factory.createStringLiteral(node.attributes.prefix),
                ),
                factory.createPropertyAssignment(
                  factory.createIdentifier("prefixOverrides"),
                  factory.createArrayLiteralExpression(
                    node.attributes.prefixOverrides.map((value) => factory.createStringLiteral(value)),
                    false,
                  ),
                ),
                factory.createPropertyAssignment(
                  factory.createIdentifier("suffix"),
                  factory.createStringLiteral(node.attributes.suffix),
                ),
                factory.createPropertyAssignment(
                  factory.createIdentifier("suffixOverrides"),
                  factory.createArrayLiteralExpression(
                    node.attributes.suffixOverrides.map((value) => factory.createStringLiteral(value)),
                    false,
                  ),
                ),
              ],
              false,
            ),
          ),
          factory.createPropertyAssignment(
            factory.createIdentifier("children"),
            templateNodeArray(factory, node.children),
          ),
          factory.createPropertyAssignment(
            factory.createIdentifier("range"),
            sourceRangeExpression(factory, node.range),
          ),
        ],
        false,
      );
    default:
      throw new Error(`Unsupported source template node: ${node.kind}`);
  }
}

function templateIrExpression(factory: ts.NodeFactory, ir: TemplateIr): ts.ObjectLiteralExpression {
  return factory.createObjectLiteralExpression(
    [
      factory.createPropertyAssignment(factory.createIdentifier("version"), factory.createNumericLiteral(ir.version)),
      factory.createPropertyAssignment(factory.createIdentifier("nodes"), templateNodeArray(factory, ir.nodes)),
      factory.createPropertyAssignment(
        factory.createIdentifier("sourceLength"),
        factory.createNumericLiteral(ir.sourceLength),
      ),
      ...(ir.rawNodes === undefined
        ? []
        : [
            factory.createPropertyAssignment(
              factory.createIdentifier("rawNodes"),
              templateNodeArray(factory, ir.rawNodes),
            ),
          ]),
    ],
    false,
  );
}

interface LoweredSource {
  readonly sourceText: string;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly origins: readonly SourceMapOrigin[];
  readonly mappingOrigins: readonly SourceMapOrigin[];
  readonly transformer: ts.TransformerFactory<ts.SourceFile>;
}

function queryKey(rangeValue: SourceRange): string {
  return `${rangeValue.start}:${rangeValue.end}`;
}

interface LoweringPlan {
  readonly transformer: ts.TransformerFactory<ts.SourceFile>;
  readonly diagnostics: CompileDiagnostic[];
  readonly loweredNodes: ReadonlyMap<string, ts.Node>;
  readonly prefix: readonly ts.Statement[];
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
  return ts.factory.updateSourceFile(sourceFile, [
    ...sourceFile.statements.slice(0, index),
    ...generated,
    ...sourceFile.statements.slice(index),
  ]);
}

function createLoweringPlan(
  sourceFile: ts.SourceFile,
  discovered: SourceAnalysisResult,
  mode: "runtime" | "checker",
): LoweringPlan {
  const factory = ts.factory;
  const allocator = createNameAllocator(sourceFile);
  const queryByKey = new Map(discovered.queries.map((query) => [queryKey(query.range), query]));
  let captureName: string | undefined;
  let assertConditionName: string | undefined;
  const valuesNames = new Map<string, string>();
  const evaluatedNames = new Map<string, string>();
  const readNames = new Map<string, string>();
  for (const query of discovered.queries) {
    if (hasGuard(query.ir.nodes)) {
      captureName ??= allocator.fresh("__sqlbraidCapture");
      if (mode === "runtime") assertConditionName ??= allocator.fresh("__sqlbraidAssertCondition");
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
    const imports = [
      factory.createImportSpecifier(false, factory.createIdentifier("capture"), factory.createIdentifier(captureName)),
      ...(assertConditionName
        ? [
            factory.createImportSpecifier(
              false,
              factory.createIdentifier("assertDirectiveCondition"),
              factory.createIdentifier(assertConditionName),
            ),
          ]
        : []),
    ];
    const helperModule = discovered.queries.some(
      (query) =>
        AUTHORING_MODULE_CATALOG.find((entry) => entry.moduleSpecifier === query.moduleSpecifier)?.helperFamily ===
        "facade",
    )
      ? "sqlbraid/compiled"
      : "@sqlbraid/template";
    prefix.push(
      factory.createImportDeclaration(
        undefined,
        factory.createImportClause(false, undefined, factory.createNamedImports(imports)),
        factory.createStringLiteral(helperModule),
        undefined,
      ),
    );
  }
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    function visit(node: ts.Node): ts.VisitResult<ts.Node> {
      const originalKey = ts.isTaggedTemplateExpression(node)
        ? queryKey({ start: node.getStart(), end: node.getEnd() })
        : undefined;
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
        diagnostics.push({
          code: "BRAID_ASYNC_CONTEXT",
          message: "Guarded templates cannot be lowered in an await/yield expression context.",
          severity: "error",
          range: query.templateRange,
        });
        loweredNodes.set(originalKey, updated);
        return updated;
      }
      const key = queryKey(query.range);
      const valuesName = valuesNames.get(key) ?? allocator.fresh("__sqlbraidValues");
      const captureContext: CaptureContext = {
        factory,
        valuesName,
        expressions,
        checkerMode: mode === "checker",
        ...(mode === "runtime" ? { readName: readNames.get(key), assertConditionName } : {}),
      };
      const body =
        mode === "runtime"
          ? [
              ...captureSetup(
                factory,
                valuesName,
                evaluatedNames.get(key) ?? allocator.fresh("__sqlbraidEvaluated"),
                readNames.get(key) ?? allocator.fresh("__sqlbraidRead"),
              ),
              ...captureStatements(query.ir.nodes, captureContext),
            ]
          : captureStatements(query.ir.nodes, captureContext);
      const callback = factory.createArrowFunction(
        undefined,
        undefined,
        [
          factory.createParameterDeclaration(
            undefined,
            undefined,
            factory.createIdentifier(valuesName),
            undefined,
            undefined,
            undefined,
          ),
        ],
        undefined,
        undefined,
        factory.createBlock(body, true),
      );
      const typeArguments = updated.typeArguments;
      const captureTypes =
        query.declaredResultKind === "call" && typeArguments?.length === 1
          ? [typeArguments[0]!, factory.createLiteralTypeNode(factory.createStringLiteral("call"))]
          : undefined;
      const tag =
        typeArguments && !captureTypes
          ? factory.createExpressionWithTypeArguments(updated.tag, typeArguments)
          : updated.tag;
      const replacement = withOriginal(
        factory.createCallExpression(factory.createIdentifier(captureName ?? "__sqlbraidCapture"), captureTypes, [
          tag,
          stringsArray(factory, query.strings, query.rawStrings),
          callback,
          templateIrExpression(factory, query.ir),
        ]),
        node,
      );
      loweredNodes.set(originalKey, replacement);
      return replacement;
    }
    return (root) => {
      if (ts.sys.resolvePath(root.fileName) !== ts.sys.resolvePath(sourceFile.fileName)) return root;
      return insertGeneratedStatements(ts.visitNode(root, visit) as ts.SourceFile, prefix);
    };
  };
  return { transformer, diagnostics, loweredNodes, prefix };
}

function lowerSourceFile(
  sourceFile: ts.SourceFile,
  discovered: SourceAnalysisResult,
  mode: "runtime" | "checker",
): LoweredSource {
  const plan = createLoweringPlan(sourceFile, discovered, mode);
  const transformed = ts.transform(sourceFile, [plan.transformer]);
  const transformedFile = transformed.transformed[0];
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const output = printer.printFile(transformedFile);
  const origins: SourceMapOrigin[] = [];
  let searchStart = 0;
  function fallbackGeneratedRange(
    query: DiscoveredQuery,
  ): { readonly start: number; readonly end: number } | undefined {
    const candidateStrings = query.strings
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => value.length > 0)
      .sort((left, right) => right.value.length - left.value.length || left.index - right.index);
    for (const candidate of candidateStrings) {
      const needle = JSON.stringify(candidate.value);
      const staticStart = output.indexOf(needle, searchStart);
      if (staticStart < 0) continue;
      const arrayStart = output.lastIndexOf("[", staticStart);
      const captureStart = output.lastIndexOf("sqlbraidCapture", arrayStart);
      const callOpen = captureStart < 0 ? -1 : output.indexOf("(", captureStart);
      if (arrayStart < 0 || callOpen < 0 || callOpen < searchStart) continue;
      let generatedStart = callOpen - 1;
      while (generatedStart >= 0 && /[$\w]/u.test(output[generatedStart] ?? "")) generatedStart -= 1;
      generatedStart += 1;
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, output);
      scanner.setTextPos(callOpen);
      let depth = 0;
      let end: number | undefined;
      while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
        const token = scanner.getToken();
        if (token === ts.SyntaxKind.OpenParenToken) depth += 1;
        else if (token === ts.SyntaxKind.CloseParenToken) {
          depth -= 1;
          if (depth === 0) {
            end = scanner.getTextPos();
            break;
          }
        }
      }
      if (generatedStart >= 0 && end !== undefined) return { start: generatedStart, end };
    }
    return undefined;
  }
  for (const query of [...discovered.queries].sort((left, right) => left.range.start - right.range.start)) {
    const node = plan.loweredNodes.get(queryKey(query.range));
    if (!node) continue;
    const text = printer.printNode(ts.EmitHint.Expression, node, transformedFile);
    const exactStart = output.indexOf(text, searchStart);
    const fallback = exactStart < 0 ? fallbackGeneratedRange(query) : undefined;
    const generatedStart = exactStart >= 0 ? exactStart : fallback?.start;
    if (generatedStart === undefined) continue;
    const generatedEnd = exactStart >= 0 ? exactStart + text.length : fallback?.end;
    if (generatedEnd === undefined) continue;
    origins.push({ generatedStart, generatedEnd, sourceStart: query.range.start, sourceEnd: query.range.end });
    searchStart = generatedEnd;
  }
  const mappingOrigins = [...origins];
  let statementSearchStart = 0;
  function tokens(node: ts.Node, _source: ts.SourceFile): readonly ts.Node[] {
    const outputTokens: ts.Node[] = [];
    function visit(current: ts.Node): void {
      if (ts.isToken(current)) {
        outputTokens.push(current);
        return;
      }
      ts.forEachChild(current, visit);
    }
    visit(node);
    return outputTokens;
  }
  for (const statement of sourceFile.statements) {
    const transformedStatement = transformedFile.statements.find(
      (candidate) => ts.getOriginalNode(candidate) === statement,
    );
    if (!transformedStatement) continue;
    const statementText = printer.printNode(ts.EmitHint.Unspecified, transformedStatement, transformedFile);
    const generatedStart = output.indexOf(statementText, statementSearchStart);
    if (generatedStart < 0) continue;
    statementSearchStart = generatedStart + statementText.length;
    const sourceTokens = tokens(statement, sourceFile);
    const generatedTokens = tokens(transformedStatement, transformedFile);
    const count = Math.min(sourceTokens.length, generatedTokens.length);
    for (let index = 0; index < count; index += 1) {
      const sourceToken = sourceTokens[index];
      const generatedToken = generatedTokens[index];
      if (sourceToken.pos < 0 || sourceToken.end < 0 || generatedToken.pos < 0 || generatedToken.end < 0) continue;
      if (
        sourceToken.kind !== generatedToken.kind ||
        sourceToken.getText(sourceFile) !== generatedToken.getText(transformedFile)
      )
        continue;
      mappingOrigins.push({
        generatedStart:
          generatedStart + generatedToken.getStart(transformedFile) - transformedStatement.getStart(transformedFile),
        generatedEnd: generatedStart + generatedToken.getEnd() - transformedStatement.getStart(transformedFile),
        sourceStart: sourceToken.getStart(sourceFile),
        sourceEnd: sourceToken.getEnd(),
      });
    }
  }
  for (const origin of origins) {
    const query = discovered.queries.find(
      (candidate) => candidate.range.start === origin.sourceStart && candidate.range.end === origin.sourceEnd,
    );
    if (!query) continue;
    const generatedQuery = output.slice(origin.generatedStart, origin.generatedEnd);
    let bindingSearchOffset = Math.max(0, generatedQuery.indexOf("=> {"));
    for (const binding of query.bindings) {
      const bindingOffset = generatedQuery.indexOf(binding.expression, bindingSearchOffset);
      if (bindingOffset < 0) continue;
      mappingOrigins.push({
        generatedStart: origin.generatedStart + bindingOffset,
        generatedEnd: origin.generatedStart + bindingOffset + binding.expression.length,
        sourceStart: binding.range.start,
        sourceEnd: binding.range.end,
      });
      bindingSearchOffset = bindingOffset + Math.max(1, binding.expression.length);
    }
  }
  transformed.dispose();
  return { sourceText: output, diagnostics: plan.diagnostics, origins, mappingOrigins, transformer: plan.transformer };
}

export function createVirtualOverlay(
  sourceText: string,
  fileName: string,
  options: OverlayOptions,
): VirtualTypeScriptOverlay {
  const compilerOptions = compilerOptionsFor(options);
  let sourceFile = sourceFileFor(sourceText, fileName, options);
  let typeChecker = options.typeChecker;
  let discovered = discoverQueries(sourceText, fileName, {
    ...options,
    compilerOptions,
    sourceFile,
    ...(typeChecker ? { typeChecker } : {}),
  });
  if (!typeChecker && hasMappedRowsTag(sourceFile)) {
    const originalProgram = ts.createProgram(
      [fileName],
      compilerOptions,
      sourceHost(compilerOptions, fileName, sourceText),
    );
    sourceFile = sourceFileInProgram(originalProgram, fileName) ?? sourceFile;
    typeChecker = originalProgram.getTypeChecker();
    discovered = discoverQueries(sourceText, fileName, { ...options, compilerOptions, sourceFile, typeChecker });
  }
  const queryTypes: OverlayQueryType[] = discovered.queries.map((query) => {
    const node = queryNodeFor(sourceFile, query);
    return {
      range: query.range,
      rowType:
        query.declaredRowType ??
        (query.mappedRow && typeChecker && node
          ? (mappedRowType(node, typeChecker) ?? "unknown")
          : query.declaredResultKind === "command"
            ? 'import("@sqlbraid/core").CommandResult'
            : "unknown"),
      resultKind: query.declaredResultKind,
    };
  });
  const transformed = lowerSourceFile(sourceFile, discovered, "runtime");
  return {
    sourceFileName: fileName,
    sourceText,
    virtualSourceText: transformed.sourceText,
    queryTypes,
    diagnostics: transformed.diagnostics,
  };
}

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
    .sort((left, right) => left.generatedOffset - right.generatedOffset || left.sourceOffset - right.sourceOffset);
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
  const ordered = [...edits].sort(
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

function virtualSourceFile(
  name: string,
  text: string,
  languageVersion: ts.ScriptTarget,
  original?: ts.SourceFile,
  impliedNodeFormat?: ts.ModuleKind.ESNext | ts.ModuleKind.CommonJS,
): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    name,
    text,
    languageVersion,
    true,
    original ? sourceFileScriptKind(original) : scriptKindForFileName(name),
  );
  if (original?.impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = original.impliedNodeFormat;
  else if (impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = impliedNodeFormat;
  return sourceFile;
}

function virtualHost(
  compilerOptions: ts.CompilerOptions,
  virtualFiles: ReadonlyMap<string, string>,
  originalFiles: ReadonlyMap<string, ts.SourceFile> = new Map(),
): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  return {
    ...defaultHost,
    getSourceFile(name, languageVersion: ts.ScriptTarget) {
      const text = virtualFiles.get(ts.sys.resolvePath(name));
      if (text === undefined) return defaultHost.getSourceFile(name, languageVersion);
      return virtualSourceFile(
        name,
        text,
        languageVersion,
        originalFiles.get(ts.sys.resolvePath(name)),
        impliedNodeFormatForFileName(name, compilerOptions),
      );
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
      return ts.sys.resolvePath(name) === canonical
        ? virtualSourceFile(
            name,
            sourceText,
            languageVersion,
            undefined,
            impliedNodeFormatForFileName(name, compilerOptions),
          )
        : defaultHost.getSourceFile(name, languageVersion);
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

function mapGeneratedRange(record: FileRecord, start: number, _end: number): SourceRange {
  const origin = record.lowered.mappingOrigins
    .filter((candidate) => start >= candidate.generatedStart && start < candidate.generatedEnd)
    .sort((left, right) => left.generatedEnd - left.generatedStart - (right.generatedEnd - right.generatedStart))[0];
  const fallbackOrigin =
    origin ??
    record.lowered.origins.find((candidate) => start >= candidate.generatedStart && start < candidate.generatedEnd);
  if (fallbackOrigin) {
    const query = record.discovered.queries.find(
      (candidate) =>
        candidate.range.start === fallbackOrigin.sourceStart && candidate.range.end === fallbackOrigin.sourceEnd,
    );
    if (query) {
      const generatedQuery = record.lowered.sourceText.slice(
        fallbackOrigin.generatedStart,
        fallbackOrigin.generatedEnd,
      );
      const callbackStart = generatedQuery.indexOf("=> {");
      const searchStart = callbackStart >= 0 ? callbackStart : 0;
      const bindingOffsets = new Map<number, number>();
      for (const expression of new Set(query.bindings.map((binding) => binding.expression))) {
        const bindings = query.bindings
          .filter((binding) => binding.expression === expression)
          .sort((left, right) => left.interpolation - right.interpolation);
        let offset = searchStart;
        for (const binding of bindings) {
          let found = generatedQuery.indexOf(expression, offset);
          while (found >= 0) {
            const before = generatedQuery[found - 1];
            const after = generatedQuery[found + expression.length];
            const identifierExpression = /[$\w]/u.test(expression[0] ?? "") && /[$\w]/u.test(expression.at(-1) ?? "");
            if (!identifierExpression || (!/[$\w]/u.test(before ?? "") && !/[$\w]/u.test(after ?? ""))) break;
            found = generatedQuery.indexOf(expression, found + Math.max(1, expression.length));
          }
          if (found < 0) continue;
          bindingOffsets.set(binding.interpolation, found);
          offset = found + Math.max(1, expression.length);
        }
      }
      for (const binding of query.bindings) {
        const bindingOffset = bindingOffsets.get(binding.interpolation);
        if (
          bindingOffset !== undefined &&
          start >= fallbackOrigin.generatedStart + bindingOffset &&
          start <= fallbackOrigin.generatedStart + bindingOffset + binding.expression.length
        )
          return binding.range;
      }
      return { start: fallbackOrigin.sourceStart, end: fallbackOrigin.sourceEnd };
    }
    return { start: fallbackOrigin.sourceStart, end: fallbackOrigin.sourceEnd };
  }
  const nearest = record.discovered.queries.reduce<{ readonly distance: number; readonly query?: DiscoveredQuery }>(
    (best, query) => {
      const distance = Math.abs(query.range.start - start);
      return distance < best.distance ? { distance, query } : best;
    },
    { distance: Number.POSITIVE_INFINITY },
  );
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

function tsDiagnostic(diagnostic: ts.Diagnostic, rangeValue: SourceRange): CompileDiagnostic {
  return {
    code: `TS${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    severity: "error",
    range: rangeValue,
  };
}

function programDiagnostics(
  records: readonly FileRecord[],
  program: ts.Program,
  mapRange: (record: FileRecord, start: number, end: number) => SourceRange,
): readonly CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (!diagnostic.file) {
      addDiagnostic(diagnostics, seen, tsDiagnostic(diagnostic, { start: 0, end: 0 }));
      continue;
    }
    const record = records.find(
      (candidate) => ts.sys.resolvePath(candidate.fileName) === ts.sys.resolvePath(diagnostic.file?.fileName ?? ""),
    );
    if (!record) continue;
    const start = diagnostic.start ?? 0;
    const end = start + (diagnostic.length ?? 1);
    addDiagnostic(diagnostics, seen, tsDiagnostic(diagnostic, mapRange(record, start, end)));
  }
  return diagnostics;
}

function braidDiagnostics(records: readonly FileRecord[]): readonly CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  for (const record of records)
    for (const diagnostic of record.lowered.diagnostics) addDiagnostic(diagnostics, seen, diagnostic);
  return diagnostics;
}

function overlayDiagnostics(records: readonly FileRecord[], virtualProgram: ts.Program): readonly CompileDiagnostic[] {
  return programDiagnostics(records, virtualProgram, mapGeneratedRange);
}

function sameDiagnosticSource(left: CompileDiagnostic, right: CompileDiagnostic): boolean {
  if (left.code !== right.code || left.message !== right.message || left.severity !== right.severity) return false;
  if (left.range.start === right.range.start && left.range.end === right.range.end) return true;
  const leftContainsRight = left.range.start <= right.range.start && left.range.end >= right.range.end;
  const rightContainsLeft = right.range.start <= left.range.start && right.range.end >= left.range.end;
  return (
    (leftContainsRight || rightContainsLeft) &&
    (left.range.start === right.range.start || left.range.end === right.range.end)
  );
}

function overlayOnlyDiagnostics(
  overlay: readonly CompileDiagnostic[],
  native: readonly CompileDiagnostic[],
): readonly CompileDiagnostic[] {
  const unmatchedNative = [...native];
  const only: CompileDiagnostic[] = [];
  for (const diagnostic of overlay) {
    const match = unmatchedNative
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => sameDiagnosticSource(diagnostic, candidate))
      .sort((left, right) => {
        const leftWidth = left.candidate.range.end - left.candidate.range.start;
        const rightWidth = right.candidate.range.end - right.candidate.range.start;
        const diagnosticWidth = diagnostic.range.end - diagnostic.range.start;
        return (
          Math.abs(leftWidth - diagnosticWidth) - Math.abs(rightWidth - diagnosticWidth) ||
          left.candidate.range.start - right.candidate.range.start ||
          left.candidate.range.end - right.candidate.range.end
        );
      })[0];
    if (!match) {
      only.push(diagnostic);
      continue;
    }
    unmatchedNative.splice(match.index, 1);
  }
  return only;
}

function checkVirtualRecords(records: readonly FileRecord[], virtualProgram: ts.Program): readonly CompileDiagnostic[] {
  return [...braidDiagnostics(records), ...overlayDiagnostics(records, virtualProgram)];
}

function compilerOptionsFor(options: TypeScriptCheckOptions): ts.CompilerOptions {
  return { ...defaultCompilerOptions(), ...options.compilerOptions };
}

export function createSourceContext(
  sourceText: string,
  fileName: string,
  options: TypeScriptCheckOptions,
): TypeScriptSourceContext {
  const compilerOptions = compilerOptionsFor(options);
  const program = ts.createProgram([fileName], compilerOptions, sourceHost(compilerOptions, fileName, sourceText));
  const sourceFile =
    sourceFileInProgram(program, fileName) ?? sourceFileFor(sourceText, fileName, { ...options, compilerOptions });
  return { compilerOptions, program, sourceFile, checker: program.getTypeChecker() };
}

export function checkSource(
  sourceText: string,
  fileName: string,
  options: TypeScriptCheckOptions,
): readonly CompileDiagnostic[] {
  const context = createSourceContext(sourceText, fileName, options);
  const { compilerOptions, sourceFile: originalSourceFile } = context;
  const fileOptions = { ...options, compilerOptions, sourceFile: originalSourceFile, typeChecker: context.checker };
  const discovered = discoverQueries(sourceText, fileName, fileOptions);
  const lowered = lowerSourceFile(originalSourceFile, discovered, "checker");
  const records: FileRecord[] = [{ fileName, sourceText, discovered, lowered }];
  const virtualFiles = new Map([[ts.sys.resolvePath(fileName), lowered.sourceText]]);
  const originalFiles = new Map([[ts.sys.resolvePath(fileName), originalSourceFile]]);
  const virtualProgram = ts.createProgram(
    [fileName],
    compilerOptions,
    virtualHost(compilerOptions, virtualFiles, originalFiles),
  );
  return checkVirtualRecords(records, virtualProgram);
}

export function checkSourceDetailed(
  sourceText: string,
  fileName: string,
  options: TypeScriptCheckOptions,
): DetailedCheckResult {
  const context = createSourceContext(sourceText, fileName, options);
  const { compilerOptions, sourceFile: originalSourceFile } = context;
  const fileOptions = { ...options, compilerOptions, sourceFile: originalSourceFile, typeChecker: context.checker };
  const discovered = discoverQueries(sourceText, fileName, fileOptions);
  const lowered = lowerSourceFile(originalSourceFile, discovered, "checker");
  const records: FileRecord[] = [{ fileName, sourceText, discovered, lowered }];
  const virtualFiles = new Map([[ts.sys.resolvePath(fileName), lowered.sourceText]]);
  const originalFiles = new Map([[ts.sys.resolvePath(fileName), originalSourceFile]]);
  const virtualProgram = ts.createProgram(
    [fileName],
    compilerOptions,
    virtualHost(compilerOptions, virtualFiles, originalFiles),
  );
  const braid = braidDiagnostics(records);
  const native = programDiagnostics(records, context.program, (record, start, end) => {
    const boundedStart = Math.max(0, Math.min(record.sourceText.length, start));
    const boundedEnd = Math.max(boundedStart, Math.min(record.sourceText.length, end));
    return { start: boundedStart, end: boundedEnd };
  });
  const overlay = overlayDiagnostics(records, virtualProgram);
  return {
    braidDiagnostics: braid,
    nativeTypeScriptDiagnostics: native,
    overlayTypeScriptDiagnostics: overlay,
    overlayOnlyDiagnostics: overlayOnlyDiagnostics(overlay, native),
  };
}

function readProject(
  projectFile: string,
  compilerOptionsOverride?: ts.CompilerOptions,
): { readonly compilerOptions: ts.CompilerOptions; readonly fileNames: readonly string[] } {
  const normalizedProjectFile = ts.sys.resolvePath(projectFile);
  const config = ts.readConfigFile(normalizedProjectFile, ts.sys.readFile);
  if (config.error)
    throw new Error(`TS${config.error.code}: ${ts.flattenDiagnosticMessageText(config.error.messageText, " ")}`);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(normalizedProjectFile),
    compilerOptionsOverride,
    normalizedProjectFile,
  );
  if (parsed.errors.length)
    throw new Error(
      parsed.errors
        .map((diagnostic) => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`)
        .join("\n"),
    );
  return { compilerOptions: parsed.options, fileNames: parsed.fileNames };
}

export function createProjectContext(
  projectFile: string,
  options: Pick<TypeScriptCheckOptions, "compilerOptions"> = {},
): TypeScriptProjectContext {
  const parsed = readProject(projectFile, options.compilerOptions);
  const compilerOptions = { ...parsed.compilerOptions, ...options.compilerOptions };
  const program = ts.createProgram(parsed.fileNames, compilerOptions);
  return {
    projectFile: ts.sys.resolvePath(projectFile),
    compilerOptions,
    fileNames: parsed.fileNames,
    program,
    checker: program.getTypeChecker(),
  };
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
      const fileOptions = {
        ...options,
        compilerOptions: context.compilerOptions,
        sourceFile,
        typeChecker: context.checker,
      };
      const discovered = discoverQueries(sourceText, fileName, fileOptions);
      const lowered = lowerSourceFile(sourceFile, discovered, "checker");
      records.push({ fileName, sourceText, discovered, lowered });
      virtualFiles.set(ts.sys.resolvePath(fileName), lowered.sourceText);
      originalFiles.set(ts.sys.resolvePath(fileName), sourceFile);
    }
    const virtualProgram = ts.createProgram(
      context.fileNames,
      context.compilerOptions,
      virtualHost(context.compilerOptions, virtualFiles, originalFiles),
    );
    return checkVirtualRecords(records, virtualProgram);
  } catch (error) {
    return [
      {
        code: "BRAID_PROJECT_CONFIG",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        range: { start: 0, end: 0 },
      },
    ];
  }
}

function emitCompilerOptions(options: OverlayOptions): ts.CompilerOptions {
  const provided = options.compilerOptions ?? {};
  const module = provided.module ?? ts.ModuleKind.NodeNext;
  const compilerOptions: ts.CompilerOptions = {
    ...defaultCompilerOptions(),
    target: provided.target ?? ts.ScriptTarget.ES2022,
    module,
    moduleResolution:
      provided.moduleResolution ??
      (module === ts.ModuleKind.Node16 || module === ts.ModuleKind.NodeNext
        ? ts.ModuleResolutionKind.NodeNext
        : ts.ModuleResolutionKind.Node10),
    sourceMap: provided.inlineSourceMap ? false : (provided.sourceMap ?? true),
    ...provided,
    noEmit: false,
  };
  if (compilerOptions.inlineSourceMap) compilerOptions.sourceMap = false;
  return compilerOptions;
}

export function emitSource(
  sourceText: string,
  fileName: string,
  options: OverlayOptions,
): {
  readonly outputText: string;
  readonly sourceMapText?: string;
  readonly diagnostics: readonly CompileDiagnostic[];
} {
  const compilerOptions = emitCompilerOptions(options);
  const originalProgram = ts.createProgram(
    [fileName],
    compilerOptions,
    sourceHost(compilerOptions, fileName, sourceText),
  );
  const originalSourceFile =
    sourceFileInProgram(originalProgram, fileName) ??
    sourceFileFor(sourceText, fileName, { ...options, compilerOptions });
  const fileOptions = {
    ...options,
    compilerOptions,
    sourceFile: originalSourceFile,
    typeChecker: originalProgram.getTypeChecker(),
  };
  const discovered = discoverQueries(sourceText, fileName, fileOptions);
  const transformed = lowerSourceFile(originalSourceFile, discovered, "runtime");
  let outputText = "";
  let sourceMapText: string | undefined;
  const emitted = originalProgram.emit(
    undefined,
    (outputFileName, text) => {
      if (outputFileName.endsWith(".map")) sourceMapText = text;
      else if (!outputFileName.endsWith(".d.ts")) outputText = text;
    },
    undefined,
    false,
    { before: [transformed.transformer] },
  );
  const diagnostics = [
    ...transformed.diagnostics,
    ...(emitted.diagnostics ?? []).map((diagnostic) => {
      const start = diagnostic.start ?? 0;
      const end = start + (diagnostic.length ?? 1);
      return {
        code: `TS${diagnostic.code}`,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        severity: "error" as const,
        range: { start, end },
      };
    }),
  ];
  if (sourceMapText && transformed.origins) {
    try {
      const sourceMap = JSON.parse(sourceMapText) as Record<string, unknown>;
      sourceMap.x_sqlbraid_origins = transformed.origins;
      sourceMapText = JSON.stringify(sourceMap);
    } catch {}
  }
  return { outputText, ...(sourceMapText ? { sourceMapText } : {}), diagnostics };
}

export function sourcePosition(
  sourceText: string,
  offset: number,
): { readonly line: number; readonly character: number } {
  const safeOffset = Math.max(0, Math.min(offset, sourceText.length));
  const prefix = sourceText.slice(0, safeOffset);
  const lines = prefix.split(/\r\n|\r|\n/u);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}
