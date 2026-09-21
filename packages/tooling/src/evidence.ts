import ts from "typescript";
import type { CodegenResult } from "@sqlbraid/codegen";
import type { RelationSnapshot } from "@sqlbraid/metadata";
import type { Location, LanguageServiceOptions, ToolingTarget } from "./types.js";
import type { GeneratedIndex, MetadataIndex, Range } from "./analysis-types.js";
import { evidenceKey, metadataEvidence, sourceRange, location } from "./lexical.js";

export function targetForRelation(
  relation: RelationSnapshot,
  options: LanguageServiceOptions,
): { readonly target: ToolingTarget; readonly model: NonNullable<CodegenResult["models"]>[number] } | undefined {
  const matches = (options.targets ?? []).flatMap((target) => {
    const model = target.generation?.models.find((candidate) => candidate.relationIdentity === relation.identity);
    return model ? [{ target, model }] : [];
  });
  if (!matches.length) return undefined;
  const keys = new Set(matches.map(({ model }) => evidenceKey(model)));
  return keys.size === 1 ? matches[0] : undefined;
}
export function generatedIndexes(options: LanguageServiceOptions): readonly GeneratedIndex[] {
  const indexes: GeneratedIndex[] = [];
  for (const target of options.targets ?? []) {
    if (
      !target.outFile ||
      !target.generatedSource ||
      !target.generation ||
      target.generatedSource !== target.generation.source
    )
      continue;
    const file = ts.createSourceFile(
      target.outFile,
      target.generatedSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declarations = new Map<string, Range>();
    const properties = new Map<string, Range>();
    function visit(node: ts.Node): void {
      if (ts.isInterfaceDeclaration(node) && node.name) {
        declarations.set(node.name.text, sourceRange(node.name.getStart(file), node.name.getEnd()));
        for (const member of node.members)
          if (ts.isPropertySignature(member) && member.name) {
            const name = ts.isStringLiteral(member.name) || ts.isIdentifier(member.name) ? member.name.text : undefined;
            if (name)
              properties.set(
                `${node.name.text}\0${name}`,
                sourceRange(member.name.getStart(file), member.name.getEnd()),
              );
          }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    indexes.push({ target, declarations, properties });
  }
  return indexes;
}
function metadataObjectProperty(
  object: ts.ObjectLiteralExpression,
  key: string,
  file: ts.SourceFile,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(file)) === key,
  );
}
function jsonObjectIdentity(object: ts.ObjectLiteralExpression, file: ts.SourceFile): string | undefined {
  const identity = metadataObjectProperty(object, "identity", file)?.initializer;
  return identity && ts.isStringLiteral(identity) ? identity.text : undefined;
}
export function metadataIndex(target: ToolingTarget): MetadataIndex | undefined {
  if (!target.metadataPath || !target.metadataSource) return undefined;
  const file = ts.parseJsonText(target.metadataPath, target.metadataSource);
  const root =
    file.statements[0] &&
    ts.isExpressionStatement(file.statements[0]) &&
    ts.isObjectLiteralExpression(file.statements[0].expression)
      ? file.statements[0].expression
      : undefined;
  if (!root) return undefined;
  const relations = new Map<string, { readonly range: Range; readonly columns: ReadonlyMap<string, Range> }>();
  const relationContainer = metadataObjectProperty(root, "relations", file)?.initializer;
  if (relationContainer && ts.isObjectLiteralExpression(relationContainer))
    for (const property of relationContainer.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue;
      const identity = jsonObjectIdentity(property.initializer, file);
      if (!identity) continue;
      const columns = new Map<string, Range>();
      const columnContainer = metadataObjectProperty(property.initializer, "columns", file)?.initializer;
      if (columnContainer && ts.isArrayLiteralExpression(columnContainer))
        for (const item of columnContainer.elements)
          if (ts.isObjectLiteralExpression(item)) {
            const nameNode = metadataObjectProperty(item, "name", file)?.initializer;
            const name = nameNode && ts.isStringLiteral(nameNode) ? nameNode.text : undefined;
            if (name) columns.set(name, sourceRange(item.getStart(file), item.getEnd()));
          }
      relations.set(identity, {
        range: sourceRange(property.initializer.getStart(file), property.initializer.getEnd()),
        columns,
      });
    }
  const routines = new Map<string, Range>();
  const routineContainer = metadataObjectProperty(root, "routines", file)?.initializer;
  if (routineContainer && ts.isObjectLiteralExpression(routineContainer))
    for (const property of routineContainer.properties)
      if (ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer))
        for (const item of property.initializer.elements)
          if (ts.isObjectLiteralExpression(item)) {
            const identity = jsonObjectIdentity(item, file);
            if (identity) routines.set(identity, sourceRange(item.getStart(file), item.getEnd()));
          }
  return { target, relations, routines };
}
export function metadataRange(
  indexes: readonly MetadataIndex[],
  target: ToolingTarget,
  identity: string,
  column?: string,
  routine = false,
): Location | undefined {
  const index = indexes.find((candidate) => candidate.target === target);
  if (!index || !target.metadataPath || !target.metadataSource) return undefined;
  const entry = routine ? undefined : index.relations.get(identity);
  const range = routine ? index.routines.get(identity) : column ? entry?.columns.get(column) : entry?.range;
  return range ? location(target.metadataPath, target.metadataSource, range) : undefined;
}
export function generatedLocation(
  relation: RelationSnapshot,
  column: string | undefined,
  options: LanguageServiceOptions,
  indexes: readonly GeneratedIndex[],
): Location | undefined {
  const linked = targetForRelation(relation, options);
  if (!linked) return undefined;
  const candidates = (options.targets ?? []).flatMap((target) => {
    const model = target.generation?.models.find((candidate) => candidate.relationIdentity === relation.identity);
    const index = indexes.find((candidate) => candidate.target === target);
    return model && index ? [{ target, model, index }] : [];
  });
  if (candidates.length !== 1) return undefined;
  const current = candidates[0];
  if (!current) return undefined;
  const index = current.index;
  const name = column ? linked.model.rowName : linked.model.rowName;
  const range = column ? index.properties.get(`${name}\0${column}`) : index.declarations.get(name);
  return range && current.target.outFile
    ? location(current.target.outFile, current.target.generatedSource ?? "", range)
    : undefined;
}
export function targetMetadataLocation(
  relation: RelationSnapshot,
  column: string | undefined,
  options: LanguageServiceOptions,
  indexes: readonly MetadataIndex[],
): Location | undefined {
  for (const evidence of metadataEvidence(options))
    if (evidence.target) {
      const found = metadataRange(indexes, evidence.target, relation.identity, column);
      if (found) return found;
    }
  return undefined;
}
