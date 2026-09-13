import { createHash } from "node:crypto";
import type { TypePolicy, TypeMapping } from "@sqlbraid/core";
import {
  hashSnapshot,
  validateSnapshot,
  type ColumnSnapshot,
  type MetadataSnapshot,
  type RelationSnapshot,
} from "@sqlbraid/metadata";

export interface CodegenOptions {
  readonly typePolicy: TypePolicy;
}

export interface CodegenDiagnostic {
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly relation?: string;
  readonly column?: string;
  readonly databaseType?: string;
}

export interface GeneratedRelationModel {
  readonly relationIdentity: string;
  readonly modelName: string;
  readonly rowName: string;
  readonly insertName?: string;
  readonly updateName?: string;
}

export interface CodegenResult {
  readonly source: string;
  readonly models: readonly GeneratedRelationModel[];
  readonly diagnostics: readonly CodegenDiagnostic[];
  readonly metadataHash: string;
  readonly typePolicyId: string;
  readonly typePolicyHash: string;
}

interface NamedRelation {
  readonly relation: RelationSnapshot;
  readonly modelName: string;
  readonly rowName: string;
  readonly insertName?: string;
  readonly updateName?: string;
}

interface ResolvedType {
  readonly type: string;
  readonly mapping?: TypeMapping;
}

const READABLE_RELATION_KINDS = new Set<RelationSnapshot["kind"]>([
  "table",
  "view",
  "materialized",
  "foreign",
  "virtual",
]);

const IDENTIFIER_PART = /^\p{ID_Continue}$/u;
const IDENTIFIER_START = /^\p{ID_Start}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeDatabaseType(value: string): string {
  return value.toLowerCase();
}

function validateTypePolicy(policy: unknown): asserts policy is TypePolicy {
  if (!isRecord(policy)) throw new TypeError("Codegen TypePolicy must be an object.");
  for (const field of ["id", "hash"] as const) {
    if (typeof policy[field] !== "string" || policy[field].length === 0) {
      throw new TypeError(`Codegen TypePolicy ${field} must be a non-empty string.`);
    }
  }
  if (!Array.isArray(policy.mappings)) throw new TypeError("Codegen TypePolicy mappings must be an array.");
  for (const [index, mapping] of policy.mappings.entries()) {
    if (!isRecord(mapping)) throw new TypeError(`Codegen TypePolicy mapping ${index} must be an object.`);
    for (const field of ["databaseType", "inputType", "outputType"] as const) {
      if (typeof mapping[field] !== "string" || mapping[field].length === 0) {
        throw new TypeError(`Codegen TypePolicy mapping ${index}.${field} must be a non-empty string.`);
      }
    }
    if (typeof mapping.nullable !== "boolean") {
      throw new TypeError(`Codegen TypePolicy mapping ${index}.nullable must be boolean.`);
    }
  }
}

function indexTypePolicy(policy: TypePolicy, diagnostics: CodegenDiagnostic[]): ReadonlyMap<string, TypeMapping | undefined> {
  const grouped = new Map<string, TypeMapping[]>();
  for (const mapping of policy.mappings) {
    const normalized = normalizeDatabaseType(mapping.databaseType);
    const group = grouped.get(normalized);
    if (group) group.push(mapping);
    else grouped.set(normalized, [mapping]);
  }

  const entries = new Map<string, TypeMapping | undefined>();
  for (const [normalized, mappings] of grouped) {
    const first = mappings[0]!;
    const conflicting = mappings.some(
      (mapping) => mapping.inputType !== first.inputType || mapping.outputType !== first.outputType,
    );
    entries.set(normalized, conflicting ? undefined : first);
    if (conflicting) {
      const keys = mappings.map((mapping) => mapping.databaseType).sort(compareStrings);
      diagnostics.push({
        code: "CODEGEN_AMBIGUOUS_TYPE_MAPPING",
        severity: "error",
        message: `TypePolicy mappings ${keys.map((key) => JSON.stringify(key)).join(", ")} normalize to ${JSON.stringify(normalized)} with conflicting input/output representations.`,
        databaseType: normalized,
      });
    }
  }
  return entries;
}

function policyTypeCandidates(
  metadata: MetadataSnapshot,
  column: ColumnSnapshot,
  relation: RelationSnapshot,
): readonly string[] {
  const candidates = [column.type];
  const evidence = Object.hasOwn(metadata.types, column.type) ? metadata.types[column.type] : undefined;
  if (evidence?.name) candidates.push(evidence.name);

  // SQLite's STRICT tables accept INT as an alias for INTEGER. This is the
  // only declaration alias needed by the first-party policy.
  if (metadata.dialect.toLowerCase() === "sqlite" && relation.strict === true) {
    for (const candidate of [...candidates]) {
      if (normalizeDatabaseType(candidate) === "int") candidates.push("INTEGER");
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = normalizeDatabaseType(candidate);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function resolveType(
  metadata: MetadataSnapshot,
  policy: ReadonlyMap<string, TypeMapping | undefined>,
  relation: RelationSnapshot,
  column: ColumnSnapshot,
  diagnostics: CodegenDiagnostic[],
): ResolvedType {
  const isSqlite = metadata.dialect.toLowerCase() === "sqlite";
  if (isSqlite && relation.strict !== true) {
    diagnostics.push({
      code: "CODEGEN_SQLITE_DYNAMIC_TYPE",
      severity: "warning",
      message: "SQLite non-STRICT columns retain unknown types because declared affinity is not sufficient evidence.",
      relation: relation.identity,
      column: column.name,
      databaseType: column.type,
    });
    return { type: "unknown" };
  }

  for (const candidate of policyTypeCandidates(metadata, column, relation)) {
    const key = normalizeDatabaseType(candidate);
    if (!policy.has(key)) continue;
    const mapping = policy.get(key);
    return mapping ? { type: mapping.outputType, mapping } : { type: "unknown" };
  }

  diagnostics.push({
    code: "CODEGEN_UNKNOWN_DATABASE_TYPE",
    severity: "warning",
    message: `No TypePolicy mapping matches database type ${JSON.stringify(column.type)}.`,
    relation: relation.identity,
    column: column.name,
    databaseType: column.type,
  });
  return { type: "unknown" };
}

function withNullability(type: string, nullable: boolean): string {
  return nullable ? `(${type}) | null` : type;
}

function jsonStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/gu, (character) =>
    character === "\u2028" ? "\\u2028" : "\\u2029",
  );
}

function renderProperty(column: ColumnSnapshot, type: string, optional: boolean): string {
  return `  ${jsonStringLiteral(column.name)}${optional ? "?" : ""}: ${withNullability(type, column.nullable)};`;
}

function renderInterface(name: string, properties: readonly string[]): string {
  if (properties.length === 0) return `export interface ${name} {\n}\n`;
  return `export interface ${name} {\n${properties.join("\n")}\n}\n`;
}

function relationStem(value: string): string {
  let result = "";
  let wordStart = true;
  for (const character of value) {
    if (character === "_" || !IDENTIFIER_PART.test(character)) {
      wordStart = true;
      continue;
    }
    result += wordStart ? character.toUpperCase() : character;
    wordStart = false;
  }
  if (result.length === 0) result = "Relation";
  const first = [...result][0];
  if (!first || !IDENTIFIER_START.test(first)) result = `_${result}`;
  return result;
}

function stableDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function groupByName(relations: readonly NamedRelation[]): Map<string, NamedRelation[]> {
  const groups = new Map<string, NamedRelation[]>();
  for (const relation of relations) {
    const group = groups.get(relation.modelName);
    if (group) group.push(relation);
    else groups.set(relation.modelName, [relation]);
  }
  return groups;
}

function disambiguateRelations(
  relations: readonly RelationSnapshot[],
  diagnostics: CodegenDiagnostic[],
): readonly NamedRelation[] {
  const bases = relations.map((relation) => ({
    relation,
    base: relationStem(relation.name),
    namespace: relation.namespace ? relationStem(relation.namespace) : "",
  }));
  const initialGroups = new Map<string, typeof bases>();
  for (const entry of bases) {
    const group = initialGroups.get(entry.base);
    if (group) group.push(entry);
    else initialGroups.set(entry.base, [entry]);
  }

  const candidates = bases.map((entry) => {
    const colliding = (initialGroups.get(entry.base)?.length ?? 0) > 1;
    return {
      relation: entry.relation,
      modelName: colliding && entry.namespace ? `${entry.namespace}${entry.base}` : entry.base,
    };
  });

  // Namespace prefixes can collide with an otherwise unrelated base (for
  // example, namespace "a" + "foo" and relation "aFoo"). Resolve that closure
  // before assigning the Row/Insert/Update suffixes.
  let named = candidates;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const groups = groupByName(named.map((entry) => ({ ...entry, rowName: "", relation: entry.relation })));
    const collisions = [...groups.entries()].filter(([, group]) => group.length > 1);
    if (collisions.length === 0) break;
    for (const [, group] of collisions) {
      for (const entry of group) {
        diagnostics.push({
          code: "CODEGEN_RELATION_NAME_COLLISION",
          severity: "warning",
          message: `Relation export name ${JSON.stringify(entry.modelName)} collides; a deterministic identity suffix was added.`,
          relation: entry.relation.identity,
        });
      }
    }
    named = named.map((entry) => {
      const group = groups.get(entry.modelName);
      if (!group || group.length < 2) return entry;
      return { ...entry, modelName: `${entry.modelName}_${stableDigest(entry.relation.identity).slice(0, 12)}` };
    });
  }

  const finalGroups = groupByName(named.map((entry) => ({ ...entry, rowName: "", relation: entry.relation })));
  if ([...finalGroups.values()].some((group) => group.length > 1)) {
    throw new Error("CODEGEN_RELATION_NAME_COLLISION: Identity suffixes could not resolve exported model names.");
  }

  return named
    .map((entry) => ({
      relation: entry.relation,
      modelName: entry.modelName,
      rowName: `${entry.modelName}Row`,
      ...(entry.relation.kind === "table"
        ? { insertName: `${entry.modelName}Insert`, updateName: `${entry.modelName}Update` }
        : {}),
    }))
    .sort((left, right) => compareStrings(left.relation.identity, right.relation.identity));
}

function safeComment(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function renderRelation(
  relation: RelationSnapshot,
  names: NamedRelation,
  metadata: MetadataSnapshot,
  policy: ReadonlyMap<string, TypeMapping | undefined>,
  diagnostics: CodegenDiagnostic[],
): string {
  const columns = [...relation.columns].sort(
    (left, right) => left.ordinal - right.ordinal || compareStrings(left.name, right.name),
  );
  const resolved = new Map<string, ResolvedType>();
  for (const column of columns) resolved.set(column.name, resolveType(metadata, policy, relation, column, diagnostics));

  const rowProperties = columns.map((column) =>
    renderProperty(column, resolved.get(column.name)?.type ?? "unknown", false),
  );
  const blocks = [renderInterface(names.rowName, rowProperties)];

  if (relation.kind === "table") {
    const insertProperties = columns
      .filter((column) => column.insertable !== false && column.generated !== true)
      .map((column) => {
        const mapping = resolved.get(column.name)?.mapping;
        return renderProperty(column, mapping?.inputType ?? "unknown", column.identity === true || column.defaultExpression !== undefined || column.nullable);
      });
    const updateProperties = columns
      .filter((column) => column.updatable !== false && column.generated !== true)
      .map((column) => {
        const mapping = resolved.get(column.name)?.mapping;
        return renderProperty(column, mapping?.inputType ?? "unknown", true);
      });
    blocks.push(renderInterface(names.insertName ?? `${names.modelName}Insert`, insertProperties));
    blocks.push(renderInterface(names.updateName ?? `${names.modelName}Update`, updateProperties));
  }
  return blocks.join("\n");
}

function diagnosticSort(left: CodegenDiagnostic, right: CodegenDiagnostic): number {
  return compareStrings(
    [
      left.code,
      left.relation ?? "",
      left.column ?? "",
      left.databaseType ?? "",
      left.message,
    ].join("\u0000"),
    [
      right.code,
      right.relation ?? "",
      right.column ?? "",
      right.databaseType ?? "",
      right.message,
    ].join("\u0000"),
  );
}

export function generateModels(
  metadata: MetadataSnapshot,
  options: CodegenOptions,
): CodegenResult {
  validateSnapshot(metadata);
  const policy = options?.typePolicy;
  validateTypePolicy(policy);
  const diagnostics: CodegenDiagnostic[] = [];
  const policyIndex = indexTypePolicy(policy, diagnostics);
  const metadataHash = hashSnapshot(metadata);

  const allRelations = Object.values(metadata.relations)
    .sort((left, right) => compareStrings(left.identity, right.identity));
  for (const relation of allRelations) {
    if (relation.kind === "unknown") {
      diagnostics.push({
        code: "CODEGEN_UNKNOWN_RELATION_KIND",
        severity: "warning",
        message: "Relation kind is unknown; only columns with evidence can receive a read model.",
        relation: relation.identity,
      });
    }
  }
  const relations = allRelations.filter(
    (relation) => READABLE_RELATION_KINDS.has(relation.kind) || (relation.kind === "unknown" && relation.columns.length > 0),
  );
  const namedRelations = disambiguateRelations(relations, diagnostics);
  const blocks = namedRelations.map((named) => renderRelation(named.relation, named, metadata, policyIndex, diagnostics));
  const source = [
    "// Generated by @sqlbraid/codegen. Do not edit.",
    `// Metadata: ${safeComment(metadataHash)}`,
    `// TypePolicy: ${safeComment(policy.id)} (${safeComment(policy.hash)})`,
    "",
    blocks.join("\n"),
  ].join("\n");
  const models = namedRelations.map(({ relation, modelName, rowName, insertName, updateName }) => ({
    relationIdentity: relation.identity,
    modelName,
    rowName,
    ...(insertName ? { insertName } : {}),
    ...(updateName ? { updateName } : {}),
  }));
  return {
    source: source.endsWith("\n") ? source : `${source}\n`,
    models,
    diagnostics: diagnostics.sort(diagnosticSort),
    metadataHash,
    typePolicyId: policy.id,
    typePolicyHash: policy.hash,
  };
}
