import type { ColumnSnapshot, RelationSnapshot, RoutineSnapshot } from "@sqlbraid/metadata";
import type { CompletionItem, HoverResult, LanguageServiceOptions, QuerySymbol, SignatureResult } from "./types.js";
import type { FileAnalysis, GeneratedIndex, LexicalQuery, Range } from "./analysis-types.js";
import { allRelations, allRoutines, boundedText, metadataEvidence, queryDialect } from "./lexical.js";
import { generatedLocation, targetForRelation } from "./evidence.js";

export function relationHover(relation: RelationSnapshot, range: Range, options: LanguageServiceOptions): HoverResult {
  const linked = targetForRelation(relation, options);
  const model = linked?.model;
  const evidence = metadataEvidence(options).find((item) =>
    Object.values(item.snapshot.relations).some((candidate) => candidate.identity === relation.identity),
  );
  const scope = evidence?.snapshot.metadata.completeness ?? "unknown";
  const lines = [`Relation ${relation.identity}`, `kind: ${relation.kind}`, `scope: ${scope}`];
  if (relation.namespace) lines.push(`namespace: ${relation.namespace}`);
  if (model)
    lines.push(
      `models: ${model.rowName}${model.insertName ? `, ${model.insertName}` : ""}${model.updateName ? `, ${model.updateName}` : ""}`,
    );
  if (linked?.target.generation)
    lines.push(
      `metadataHash: ${linked.target.generation.metadataHash}`,
      `optionsHash: ${linked.target.generation.optionsHash}`,
    );
  return { contents: boundedText(lines), range };
}
export function columnHover(
  owner: RelationSnapshot,
  column: ColumnSnapshot,
  range: Range,
  options: LanguageServiceOptions,
  indexes: readonly GeneratedIndex[],
): HoverResult {
  const lines = [`Column ${owner.identity}.${column.name}`, `type: ${column.type}`, `nullable: ${column.nullable}`];
  if (column.defaultExpression !== undefined) lines.push(`default: ${column.defaultExpression}`);
  if (column.generated !== undefined) lines.push(`generated: ${column.generated}`);
  if (column.identity !== undefined) lines.push(`identity: ${column.identity}`);
  if (column.insertable !== undefined) lines.push(`insertable: ${column.insertable}`);
  if (column.updatable !== undefined) lines.push(`updatable: ${column.updatable}`);
  const evidence = metadataEvidence(options).find((item) =>
    Object.values(item.snapshot.relations).some((candidate) => candidate.identity === owner.identity),
  );
  if (evidence?.snapshot.metadata.introspectionScope)
    lines.push(`introspectionScope: ${evidence.snapshot.metadata.introspectionScope}`);
  const linked = targetForRelation(owner, options);
  if (linked?.target.generation)
    lines.push(
      `metadataHash: ${linked.target.generation.metadataHash}`,
      `optionsHash: ${linked.target.generation.optionsHash}`,
    );
  if (linked) lines.push(`generated property: ${linked.model.rowName}.${column.name}`);
  const model = generatedLocation(owner, column.name, options, indexes);
  if (model) lines.push(`generated: ${model.uri}`);
  return { contents: boundedText(lines), range };
}
export function routineHover(routine: RoutineSnapshot, range: Range, options: LanguageServiceOptions): HoverResult {
  const complete = (routine as RoutineSnapshot & { readonly argumentsComplete?: boolean }).argumentsComplete === true;
  const args = routine.arguments.map((argument) => `${argument.name ?? "arg"}: ${argument.type}`).join(", ");
  const result = routine.result.kind === "scalar" ? routine.result.type : routine.result.kind;
  const knownArguments = complete ? args || "none" : args ? `${args} (incomplete)` : "unknown/incomplete";
  const lines = [
    `Routine ${routine.identity}`,
    `kind: ${routine.kind}`,
    `result: ${result}`,
    `known arguments: ${knownArguments}`,
    `argumentsComplete: ${complete}`,
  ];
  const evidence = metadataEvidence(options).find((item) =>
    Object.values(item.snapshot.routines)
      .flat()
      .some((candidate) => candidate.identity === routine.identity),
  );
  if (evidence?.target?.generation)
    lines.push(
      `metadataHash: ${evidence.target.generation.metadataHash}`,
      `optionsHash: ${evidence.target.generation.optionsHash}`,
    );
  return { contents: boundedText(lines), range };
}
export function queryHover(lexical: LexicalQuery, options: LanguageServiceOptions): HoverResult {
  const kind = lexical.query.declaredResultKind;
  const contract = lexical.query.declaredRowType ?? (kind === "command" ? "CommandResult" : "unknown");
  const type =
    kind === "rows"
      ? `RowQuery<${contract}>`
      : kind === "command"
        ? "CommandQuery"
        : kind === "call"
          ? `CallQuery<${contract}>`
          : `Query<${contract}>`;
  const dialect = queryDialect(lexical.query.moduleSpecifier, options);
  const lines = [type, `dialect: ${dialect}`, `binds: ${lexical.query.bindings.length}`];
  if (lexical.query.bindings.length)
    lines.push(`bindings: ${lexical.query.bindings.map((binding) => binding.expression).join(", ")}`);
  const target = options.targets?.length === 1 ? options.targets[0] : undefined;
  if (target?.name) lines.push(`target: ${target.name}`);
  if (target?.generation)
    lines.push(`metadataHash: ${target.generation.metadataHash}`, `optionsHash: ${target.generation.optionsHash}`);
  return { contents: boundedText(lines), range: lexical.query.range };
}
export function relationCandidates(options: LanguageServiceOptions): CompletionItem[] {
  return allRelations(options).map((relation) => ({ label: relation.name, kind: "relation", detail: relation.kind }));
}
export function columnCandidates(owner: RelationSnapshot): CompletionItem[] {
  return owner.columns.map((column) => ({ label: column.name, kind: "column", detail: column.type }));
}
export function routineCandidates(options: LanguageServiceOptions): CompletionItem[] {
  return allRoutines(options).map((routine) => ({ label: routine.name, kind: "routine", detail: routine.kind }));
}
export function routineSignature(routine: RoutineSnapshot, activeParameter: number): SignatureResult {
  const parameters = routine.arguments.map((argument) => `${argument.name ?? "arg"}: ${argument.type}`);
  return {
    label: `${routine.identity}(${parameters.join(", ")})`,
    parameters,
    activeParameter: Math.max(0, Math.min(activeParameter, Math.max(0, parameters.length - 1))),
  };
}
export function querySymbols(analysis: FileAnalysis): readonly QuerySymbol[] {
  return analysis.queries.map((lexical) => {
    const kind = lexical.query.declaredResultKind;
    const contract = lexical.query.declaredRowType;
    return {
      name: lexical.query.tagName,
      detail: `${kind}${contract ? `<${contract}>` : ""}`,
      range: lexical.query.range,
      selectionRange: lexical.query.templateRange,
    };
  });
}
