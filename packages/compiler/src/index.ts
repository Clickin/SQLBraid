import ts from "typescript";
import { parseSql, resolveStatement, type SemanticResult } from "@sqlbraid/ast";
import { parseTemplate, renderTemplateIr, postgresDialect } from "@sqlbraid/template";
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
}

export interface TypeScriptCheckOptions extends OverlayOptions {
  readonly compilerOptions?: ts.CompilerOptions;
}

function range(node: ts.Node, sourceFile: ts.SourceFile): SourceRange {
  return { start: node.getStart(sourceFile), end: node.getEnd() };
}

function createTemplateStrings(values: readonly string[]): TemplateStringsArray {
  const strings = [...values] as string[] & { raw?: readonly string[] };
  strings.raw = [...values];
  return strings as unknown as TemplateStringsArray;
}

function configuredModules(options: OverlayOptions): readonly string[] {
  return options.moduleSpecifiers ?? (options.moduleSpecifier ? [options.moduleSpecifier] : ["@sqlbraid/template"]);
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
    if (ts.isNamespaceImport(bindings)) { namespaces.set(bindings.name.text, statement.moduleSpecifier.text); continue; }
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
      const statements = current.statements;
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text) return true;
        if (ts.isClassDeclaration(statement) && statement.name?.text === identifier.text) return true;
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === identifier.text) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function unwrapTag(tag: ts.LeftHandSideExpression): { readonly expression: ts.Expression; readonly expectedType?: string } {
  if (ts.isCallExpression(tag)) {
    const expression = tag.expression;
    const expectedType = tag.typeArguments?.length ? tag.typeArguments.map((argument) => argument.getText()).join(", ") : undefined;
    return { expression, expectedType };
  }
  return { expression: tag };
}

function tagIdentity(tag: ts.LeftHandSideExpression, bindings: ImportBindings, tagExport: string, expectedType?: string): { readonly name?: string; readonly moduleSpecifier?: string; readonly expectedType?: string } {
  const unwrapped = unwrapTag(tag);
  const contract = expectedType ?? unwrapped.expectedType;
  const expression = unwrapped.expression;
  if (ts.isIdentifier(expression)) {
    if (isShadowed(expression)) return { expectedType: contract };
    const moduleSpecifier = bindings.named.get(expression.text);
    if (moduleSpecifier) return { name: expression.text, moduleSpecifier, expectedType: contract };
    const defaultModule = bindings.defaults.get(expression.text);
    if (defaultModule) return { name: expression.text, moduleSpecifier: defaultModule, expectedType: contract };
    return { expectedType: contract };
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.name.text === tagExport && bindings.namespaces.has(expression.expression.text) && !isShadowed(expression.expression)) return { name: expression.getText(), moduleSpecifier: bindings.namespaces.get(expression.expression.text), expectedType: contract };
  return { expectedType: contract };
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

function emptySnapshot(dialect: string): SchemaSnapshot {
  return { formatVersion: 1, dialect, dialectVersion: "unknown", server: {}, namespaces: {}, types: {}, relations: {}, routines: {}, metadata: { completeness: "unknown" } };
}

function safeType(value: string | undefined): string {
  if (!value || value === "unknown" || value.length > 10_000) return "unknown";
  if (!/^[A-Za-z0-9_$\s{}:;,|<>()?\.\[\]"'\-]+$/u.test(value)) return "unknown";
  return value;
}

function rowType(semantic: SemanticResult): string {
  if (semantic.columns === "unknown") return "unknown";
  const fields = semantic.columns.map((column) => `${JSON.stringify(column.name)}: ${safeType(column.type)}${column.nullable ? " | null" : ""}`);
  return `{ ${fields.join("; ")} }`;
}

interface ContractField {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
}

function contractFields(text: string): readonly ContractField[] | undefined {
  const source = ts.createSourceFile("contract.ts", `type Contract = ${text};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(ts.isTypeAliasDeclaration);
  if (!declaration || !ts.isTypeLiteralNode(declaration.type)) return undefined;
  return declaration.type.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) return [];
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
    return name ? [{ name, type: member.type.getText(source), optional: Boolean(member.questionToken) }] : [];
  });
}

function contractDiagnostics(query: DiscoveredQuery, inferred: SemanticResult): readonly CompileDiagnostic[] {
  if (!query.expectedType) return [];
  const fields = contractFields(query.expectedType);
  if (!fields || inferred.columns === "unknown") return [{ code: "BRAID_CONTRACT_UNPROVEN", message: "The expected sql<T> contract cannot be verified from the available SQL evidence.", severity: "error", range: query.templateRange }];
  const diagnostics: CompileDiagnostic[] = [];
  const inferredNames = new Set(inferred.columns.map((column) => column.name));
  const expectedNames = new Set(fields.map((field) => field.name));
  for (const field of fields) if (!inferredNames.has(field.name)) diagnostics.push({ code: "BRAID_CONTRACT_KEYS", message: `Expected result field is missing: ${field.name}.`, severity: "error", range: query.templateRange });
  for (const column of inferred.columns) if (!expectedNames.has(column.name)) diagnostics.push({ code: "BRAID_CONTRACT_KEYS", message: `SQL result field is not in the expected contract: ${column.name}.`, severity: "error", range: query.templateRange });
  for (const field of fields) {
    const column = inferred.columns.find((candidate) => candidate.name === field.name);
    if (!column) continue;
    const expected = field.type.replace(/\s+/gu, "");
    const actual = `${column.type}${column.nullable ? "|null" : ""}`.replace(/\s+/gu, "");
    if (expected !== "unknown" && expected !== actual && !(expected.includes("|null") && expected.replace("|null", "") === column.type)) diagnostics.push({ code: "BRAID_CONTRACT_TYPE", message: `Expected ${field.name}: ${field.type}; SQL infers ${actual}.`, severity: "error", range: query.templateRange });
    if (!field.optional && column.nullable && !expected.includes("null")) diagnostics.push({ code: "BRAID_CONTRACT_NULLABILITY", message: `Expected result field may be null: ${field.name}.`, severity: "error", range: query.templateRange });
  }
  return diagnostics;
}

function conditionIndexes(nodes: readonly TemplateNode[], output = new Set<number>()): Set<number> {
  for (const node of nodes) {
    if (node.kind === "if") { output.add(node.condition); conditionIndexes(node.children, output); }
    else if (node.kind === "choose") { for (const when of node.whens) { output.add(when.condition); conditionIndexes(when.children, output); } if (node.otherwise) conditionIndexes(node.otherwise, output); }
    else if (node.kind === "trim") conditionIndexes(node.children, output);
  }
  return output;
}

function hasGuard(nodes: readonly TemplateNode[]): boolean {
  return conditionIndexes(nodes).size > 0;
}

function guardedBindings(nodes: readonly TemplateNode[], output = new Set<number>(), guarded = false): Set<number> {
  for (const node of nodes) {
    if (node.kind === "bind") { if (guarded) output.add(node.interpolation); continue; }
    if (node.kind === "if") guardedBindings(node.children, output, true);
    else if (node.kind === "choose") { for (const when of node.whens) guardedBindings(when.children, output, true); if (node.otherwise) guardedBindings(node.otherwise, output, true); }
    else if (node.kind === "trim") guardedBindings(node.children, output, guarded);
  }
  return output;
}

function maxInterpolation(query: DiscoveredQuery): number {
  return query.bindings.reduce((maximum, binding) => Math.max(maximum, binding.interpolation), -1);
}

function defaultAnalyze(query: DiscoveredQuery, options: OverlayOptions): InferredQueryShape {
  const dialect = dialectForModule(query.moduleSpecifier, options);
  const captured = new Array(Math.max(0, maxInterpolation(query) + 1)).fill(null) as unknown[];
  for (const index of conditionIndexes(query.ir.nodes)) captured[index] = true;
  let rendered;
  try { rendered = renderTemplateIr(query.ir, captured, dialect, options.limits); }
  catch (error) {
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
  return { rowType: diagnostics.length ? "unknown" : rowType(semantic), bindingTypes, diagnostics, resultKind: semantic.resultKind, semantic };
}

export function discoverQueries(sourceText: string, fileName: string, options: OverlayOptions): SourceAnalysisResult {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = importBindings(sourceFile, options);
  const tagExport = options.tagExport ?? "sql";
  const queries: DiscoveredQuery[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  function visit(node: ts.Node): void {
    if (ts.isTaggedTemplateExpression(node)) {
      const expectedType = node.typeArguments?.length ? node.typeArguments.map((argument) => argument.getText(sourceFile)).join(", ") : undefined;
      const identity = tagIdentity(node.tag, bindings, tagExport, expectedType);
      if (identity.name && identity.moduleSpecifier) {
        const extracted = extractTemplate(node.template, sourceFile);
        try {
          queries.push({ tagName: identity.name, moduleSpecifier: identity.moduleSpecifier, range: range(node, sourceFile), templateRange: extracted.templateRange, strings: extracted.strings, bindings: extracted.bindings, ir: parseTemplate(createTemplateStrings(extracted.strings), dialectForModule(identity.moduleSpecifier, options).lexicalProfile, options.limits?.maxNestingDepth), ...(identity.expectedType ? { expectedType: identity.expectedType } : {}) });
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

export function createVirtualOverlay(sourceText: string, fileName: string, options: OverlayOptions): VirtualTypeScriptOverlay {
  const discovered = discoverQueries(sourceText, fileName, options);
  const queryTypes: OverlayQueryType[] = [];
  const diagnostics = [...discovered.diagnostics];
  for (const query of discovered.queries) {
    const inferred = options.analyze?.(query) ?? defaultAnalyze(query, options);
    queryTypes.push({ range: query.range, rowType: inferred.rowType, bindingTypes: inferred.bindingTypes ?? query.bindings.map(() => "unknown" as const), ...(inferred.resultKind ? { resultKind: inferred.resultKind } : {}) });
    if (inferred.diagnostics) diagnostics.push(...inferred.diagnostics);
  }
  const transformed = transformSource(sourceText, fileName, options);
  diagnostics.push(...transformed.diagnostics);
  return { sourceFileName: fileName, sourceText, virtualSourceText: transformed.sourceText, queryTypes, diagnostics };
}

function nodeHasAwaitOrYield(node: ts.Node): boolean {
  let found = false;
  function visit(current: ts.Node): void {
    if (ts.isAwaitExpression(current) || ts.isYieldExpression(current)) { found = true; return; }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function typeAlias(): string {
  return "import type { Query as __SQLBraidQuery } from \"@sqlbraid/core\";\n";
}

function expressionFor(query: DiscoveredQuery, interpolation: number): string {
  return query.bindings.find((binding) => binding.interpolation === interpolation)?.expression ?? "undefined";
}

function emitCapture(nodes: readonly TemplateNode[], query: DiscoveredQuery, indent = "  "): string {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.kind === "bind") lines.push(`${indent}values[${node.interpolation}] = (${expressionFor(query, node.interpolation)});`);
    else if (node.kind === "if") {
      lines.push(`${indent}if (${expressionFor(query, node.condition)}) {`);
      lines.push(`${indent}  values[${node.condition}] = true;`);
      lines.push(emitCapture(node.children, query, `${indent}  `));
      lines.push(`${indent}} else {`);
      lines.push(`${indent}  values[${node.condition}] = false;`);
      lines.push(`${indent}}`);
    } else if (node.kind === "choose") {
      node.whens.forEach((when, index) => {
        const prefix = index === 0 ? `${indent}if` : `${indent}else if`;
        lines.push(`${prefix} (${expressionFor(query, when.condition)}) {`);
        lines.push(`${indent}  values[${when.condition}] = true;`);
        lines.push(emitCapture(when.children, query, `${indent}  `));
        lines.push(`${indent}}`);
      });
      if (node.otherwise) {
        lines.push(`${indent}else {`);
        lines.push(emitCapture(node.otherwise, query, `${indent}  `));
        lines.push(`${indent}}`);
      }
    } else if (node.kind === "trim") lines.push(emitCapture(node.children, query, indent));
  }
  return lines.filter(Boolean).join("\n");
}

function templateReplacement(sourceText: string, query: DiscoveredQuery, inferred: InferredQueryShape): string {
  const original = sourceText.slice(query.range.start, query.range.end);
  const tagEnd = sourceText.indexOf("`", query.range.start);
  const rawTagText = tagEnd >= 0 ? sourceText.slice(query.range.start, tagEnd) : "sql";
  const tagText = rawTagText.replace(/<[^<>]*>$/u, "");
  const row = safeType(inferred.rowType) === "unknown" ? "unknown" : inferred.rowType;
  const kind = inferred.resultKind ?? "rows";
  const assertion = ` as __SQLBraidQuery<${row}, "${kind}">`;
  if (!hasGuard(query.ir.nodes)) return `${original}${assertion}`;
  const strings = JSON.stringify(query.strings);
  const captureBody = emitCapture(query.ir.nodes, query);
  return `__sqlbraidCapture(${tagText}, ${strings}, (values) => {\n${captureBody}\n})${assertion}`;
}

export interface TransformedSource {
  readonly sourceText: string;
  readonly diagnostics: readonly CompileDiagnostic[];
}

export function transformSource(sourceText: string, fileName: string, options: OverlayOptions): TransformedSource {
  const discovered = discoverQueries(sourceText, fileName, options);
  const diagnostics = [...discovered.diagnostics];
  const replacements: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  let needsGuardedImport = false;
  for (const query of discovered.queries) {
    const inferred = options.analyze?.(query) ?? defaultAnalyze(query, options);
    if (nodeHasAwaitOrYield(ts.createSourceFile(`${fileName}.expr.ts`, query.bindings.map((binding) => binding.expression).join(";"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))) {
      diagnostics.push({ code: "BRAID_ASYNC_CONTEXT", message: "Guarded templates cannot be lowered in an await/yield expression context.", severity: "error", range: query.templateRange });
      continue;
    }
    if (hasGuard(query.ir.nodes)) needsGuardedImport = true;
    replacements.push({ start: query.range.start, end: query.range.end, text: templateReplacement(sourceText, query, inferred) });
  }
  let output = sourceText;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`;
  if (replacements.length) {
    const prefix = `${typeAlias()}${needsGuardedImport ? "import { capture as __sqlbraidCapture } from \"@sqlbraid/template\";\n" : ""}`;
    if (output.startsWith("#!")) {
      const lineEnd = output.indexOf("\n");
      const shebang = lineEnd < 0 ? output : output.slice(0, lineEnd + 1);
      output = lineEnd < 0 ? `${shebang}\n${prefix}` : `${shebang}${prefix}${output.slice(lineEnd + 1)}`;
    } else output = `${prefix}${output}`;
  }
  return { sourceText: output, diagnostics };
}

export function checkSource(sourceText: string, fileName: string, options: TypeScriptCheckOptions): readonly CompileDiagnostic[] {
  const overlay = createVirtualOverlay(sourceText, fileName, options);
  const transformed = transformSource(sourceText, fileName, options);
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true, allowJs: false, ...options.compilerOptions };
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const canonicalFile = ts.sys.resolvePath(fileName);
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, languageVersion) {
      if (ts.sys.resolvePath(name) === canonicalFile) return ts.createSourceFile(name, transformed.sourceText, languageVersion, true, ts.ScriptKind.TS);
      return defaultHost.getSourceFile(name, languageVersion);
    },
    readFile(name) { return ts.sys.resolvePath(name) === canonicalFile ? transformed.sourceText : defaultHost.readFile(name); },
    fileExists(name) { return ts.sys.resolvePath(name) === canonicalFile || defaultHost.fileExists(name); },
  };
  const program = ts.createProgram([fileName], compilerOptions, host);
  const originalHost: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, languageVersion) {
      if (ts.sys.resolvePath(name) === canonicalFile) return ts.createSourceFile(name, sourceText, languageVersion, true, ts.ScriptKind.TS);
      return defaultHost.getSourceFile(name, languageVersion);
    },
    readFile(name) { return ts.sys.resolvePath(name) === canonicalFile ? sourceText : defaultHost.readFile(name); },
    fileExists(name) { return ts.sys.resolvePath(name) === canonicalFile || defaultHost.fileExists(name); },
  };
  const originalProgram = ts.createProgram([fileName], compilerOptions, originalHost);
  const originalSourceFile = originalProgram.getSourceFile(fileName);
  const originalChecker = originalProgram.getTypeChecker();
  const tsDiagnostics = ts.getPreEmitDiagnostics(program);
  const diagnostics: CompileDiagnostic[] = [];
  const seenDiagnostics = new Set<string>();
  const addDiagnostic = (diagnostic: CompileDiagnostic): void => {
    const key = `${diagnostic.code}:${diagnostic.range.start}:${diagnostic.range.end}:${diagnostic.message}`;
    if (seenDiagnostics.has(key)) return;
    seenDiagnostics.add(key);
    diagnostics.push(diagnostic);
  };
  for (const diagnostic of overlay.diagnostics) addDiagnostic(diagnostic);
  for (const diagnostic of tsDiagnostics) {
    const start = diagnostic.start ?? 0;
    const end = start + (diagnostic.length ?? 1);
    addDiagnostic({ code: `TS${diagnostic.code}`, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), severity: "error", range: { start, end } });
  }
  if (originalSourceFile) for (const query of overlayQueryEntries(sourceText, fileName, options)) {
    const inferred = options.analyze?.(query) ?? defaultAnalyze(query, options);
    const guarded = guardedBindings(query.ir.nodes);
    for (const binding of query.bindings) {
      const expected = inferred.bindingTypes?.[binding.interpolation] ?? "unknown";
      if (expected === "unknown") continue;
      const expressionNode = findNode(originalSourceFile, binding.range);
      if (!expressionNode) continue;
      const actual = originalChecker.typeToString(originalChecker.getTypeAtLocation(expressionNode));
      if (actual === "any" || actual === "unknown") continue;
      if ((!guarded.has(binding.interpolation) && /\b(?:null|undefined)\b/u.test(actual) && !/\b(?:null|undefined)\b/u.test(expected)) || !typeCompatible(actual, expected)) addDiagnostic({ code: "BRAID_BIND_TYPE", message: `Binding ${binding.interpolation} expects ${expected}, received ${actual}.`, severity: "error", range: binding.range });
    }
  }
  return diagnostics;
}

export function checkProject(projectFile: string, options: TypeScriptCheckOptions = {}): readonly CompileDiagnostic[] {
  const config = ts.readConfigFile(projectFile, ts.sys.readFile);
  if (config.error) return [{ code: `TS${config.error.code}`, message: ts.flattenDiagnosticMessageText(config.error.messageText, " "), severity: "error", range: { start: 0, end: 0 } }];
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ts.sys.getCurrentDirectory(), undefined, projectFile);
  const diagnostics: CompileDiagnostic[] = parsed.errors.map((diagnostic) => ({ code: `TS${diagnostic.code}`, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), severity: "error", range: { start: 0, end: 0 } }));
  const compilerOptions = { ...parsed.options, ...options.compilerOptions };
  for (const fileName of parsed.fileNames) {
    const sourceText = ts.sys.readFile(fileName);
    if (sourceText === undefined) continue;
    diagnostics.push(...checkSource(sourceText, fileName, { ...options, compilerOptions }));
  }
  return diagnostics;
}

function overlayQueryEntries(sourceText: string, fileName: string, options: OverlayOptions): readonly DiscoveredQuery[] {
  return discoverQueries(sourceText, fileName, options).queries;
}

function findNode(sourceFile: ts.SourceFile, target: SourceRange): ts.Node | undefined {
  let found: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (node.getStart(sourceFile) === target.start && node.getEnd() === target.end) { found = node; return; }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function typeCompatible(actual: string, expected: string): boolean {
  const expectedParts = expected.split("|").map((part) => part.trim()).filter((part) => part && part !== "null" && part !== "undefined");
  if (!expectedParts.length) return true;
  return expectedParts.some((part) => actual === part || actual.includes(part) || part === "unknown");
}

export function emitSource(sourceText: string, fileName: string, options: OverlayOptions): { readonly outputText: string; readonly sourceMapText?: string; readonly diagnostics: readonly CompileDiagnostic[] } {
  const transformed = transformSource(sourceText, fileName, options);
  const emitted = ts.transpileModule(transformed.sourceText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, sourceMap: true }, fileName, reportDiagnostics: true });
  const diagnostics = [...transformed.diagnostics, ...(emitted.diagnostics ?? []).map((diagnostic) => ({ code: `TS${diagnostic.code}`, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), severity: "error" as const, range: { start: diagnostic.start ?? 0, end: (diagnostic.start ?? 0) + (diagnostic.length ?? 1) } }))];
  return { outputText: emitted.outputText, ...(emitted.sourceMapText ? { sourceMapText: emitted.sourceMapText } : {}), diagnostics };
}

export function sourcePosition(sourceText: string, offset: number): { readonly line: number; readonly character: number } {
  const safeOffset = Math.max(0, Math.min(offset, sourceText.length));
  const prefix = sourceText.slice(0, safeOffset);
  const lines = prefix.split(/\r\n|\r|\n/u);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}
