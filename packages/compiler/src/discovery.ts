import ts from "typescript";
import { parseTemplate, postgresDialect } from "@sqlbraid/template";
import { AUTHORING_MODULE_CATALOG, type Dialect, type QueryResultKind, type TemplateNode } from "@sqlbraid/core";
import type {
  BindingSite,
  CompileDiagnostic,
  DiscoveredQuery,
  OverlayOptions,
  SourceAnalysisResult,
  SourceRange,
  TypeScriptCheckOptions,
} from "./types.js";

export function range(node: ts.Node, sourceFile: ts.SourceFile): SourceRange {
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

export function scriptKindForFileName(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return ts.ScriptKind.JS;
  if (lower.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

export function sourceFileScriptKind(sourceFile: ts.SourceFile): ts.ScriptKind {
  return (
    (sourceFile as ts.SourceFile & { readonly scriptKind?: ts.ScriptKind }).scriptKind ??
    scriptKindForFileName(sourceFile.fileName)
  );
}

export function impliedNodeFormatForFileName(
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

export function sourceFileFor(sourceText: string, fileName: string, options: OverlayOptions): ts.SourceFile {
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

export function defaultCompilerOptions(): ts.CompilerOptions {
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

function bind(name: ts.BindingName, scope: LexicalScope): void {
  if (ts.isIdentifier(name)) scope.bindings.set(name.text, name);
  else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name, scope);
}

function lexicalBindingOwner(sourceFile: ts.SourceFile): (identifier: ts.Identifier) => ts.Identifier | undefined {
  const scopes = new Map<ts.Node, LexicalScope>();
  const root: LexicalScope = { bindings: new Map(), variableScope: true };
  scopes.set(sourceFile, root);
  function visit(node: ts.Node, scope: LexicalScope): void {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name)
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
    if (clause.name && tagExport === "default") defaults.set(clause.name.text, { name: clause.name, moduleSpecifier });
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

export function mappedRowsCall(expression: ts.Expression): ts.CallExpression | undefined {
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
    if (!declaration || (!ts.isImportSpecifier(declaration.parent) && !ts.isImportClause(declaration.parent)))
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
    (options.typeChecker
      ? checkerTagModule(expression, sourceFile, options, options.typeChecker, bindings)
      : undefined);
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

export function hasGuard(nodes: readonly TemplateNode[]): boolean {
  return nodes.some(
    (node) => node.kind === "if" || node.kind === "choose" || (node.kind === "trim" && hasGuard(node.children)),
  );
}

/** Discover supported SQLBraid tags and parse their templates without executing application expressions. */
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

export function compilerOptionsFor(options: TypeScriptCheckOptions): ts.CompilerOptions {
  return { ...defaultCompilerOptions(), ...options.compilerOptions };
}
