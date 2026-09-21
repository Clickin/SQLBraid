import ts from "typescript";
import { AUTHORING_MODULE_CATALOG, type TemplateIr, type TemplateNode } from "@sqlbraid/core";
import { hasGuard, mappedRowsCall, range } from "./discovery.js";
import type {
  CompileDiagnostic,
  DiscoveredQuery,
  SourceAnalysisResult,
  SourceRange,
  SourceMapOrigin,
} from "./types.js";

function typeArgumentsOf(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  const aliasTypeArguments = (type as ts.Type & { readonly aliasTypeArguments?: readonly ts.Type[] })
    .aliasTypeArguments;
  if (aliasTypeArguments?.length) return aliasTypeArguments;
  if ((type.flags & ts.TypeFlags.Object) !== 0) return checker.getTypeArguments(type as ts.TypeReference);
  return [];
}

export function mappedRowType(node: ts.TaggedTemplateExpression, checker: ts.TypeChecker): string | undefined {
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

export function queryNodeFor(
  sourceFile: ts.SourceFile,
  target: DiscoveredQuery,
): ts.TaggedTemplateExpression | undefined {
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

export function hasMappedRowsTag(sourceFile: ts.SourceFile): boolean {
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

export interface LoweredSource {
  readonly sourceText: string;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly origins: readonly SourceMapOrigin[];
  readonly mappingOrigins: readonly SourceMapOrigin[];
  readonly transformer: ts.TransformerFactory<ts.SourceFile>;
}

export function queryKey(rangeValue: SourceRange): string {
  return `${rangeValue.start}:${rangeValue.end}`;
}

export interface LoweringPlan {
  readonly transformer: ts.TransformerFactory<ts.SourceFile>;
  readonly diagnostics: CompileDiagnostic[];
  readonly loweredNodes: ReadonlyMap<string, ts.Node>;
  readonly prefix: readonly ts.Statement[];
}

function withOriginal<T extends ts.Node>(node: T, original: ts.Node): T {
  return ts.setTextRange(ts.setOriginalNode(node, original), original);
}

export function directivePrologueEnd(statements: readonly ts.Statement[]): number {
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

export function createLoweringPlan(
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

function tokens(node: ts.Node): readonly ts.Node[] {
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

export function lowerSourceFile(
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
      .toSorted((left, right) => right.value.length - left.value.length || left.index - right.index);
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
  for (const query of discovered.queries.toSorted((left, right) => left.range.start - right.range.start)) {
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
  for (const statement of sourceFile.statements) {
    const transformedStatement = transformedFile.statements.find(
      (candidate) => ts.getOriginalNode(candidate) === statement,
    );
    if (!transformedStatement) continue;
    const statementText = printer.printNode(ts.EmitHint.Unspecified, transformedStatement, transformedFile);
    const generatedStart = output.indexOf(statementText, statementSearchStart);
    if (generatedStart < 0) continue;
    statementSearchStart = generatedStart + statementText.length;
    const sourceTokens = tokens(statement);
    const generatedTokens = tokens(transformedStatement);
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
