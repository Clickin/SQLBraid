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
  readonly typePolicy: Pick<TypePolicy, "id" | "hash" | "mappings">;
  readonly filters?: CodegenRelationFilter;
  readonly naming?: CodegenNamingOptions;
  readonly typeOverrides?: CodegenTypeOverrides;
}

export interface CodegenRelationFilter {
  readonly includeNamespaces?: readonly string[];
  readonly excludeNamespaces?: readonly string[];
  readonly includeRelations?: readonly string[];
  readonly excludeRelations?: readonly string[];
  readonly kinds?: readonly RelationSnapshot["kind"][];
}

export interface CodegenNamingOptions {
  readonly relations?: Readonly<Record<string, string>>;
  readonly suffixes?: {
    readonly row?: string;
    readonly insert?: string;
    readonly update?: string;
  };
}

export interface CodegenTypeOverride {
  readonly inputType?: string;
  readonly outputType?: string;
}

export interface CodegenTypeOverrides {
  readonly databaseTypes?: Readonly<Record<string, CodegenTypeOverride>>;
  readonly columns?: Readonly<Record<string, Readonly<Record<string, CodegenTypeOverride>>>>;
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
  readonly optionsHash: string;
}

interface NamedRelation {
  readonly relation: RelationSnapshot;
  readonly modelName: string;
  readonly rowName: string;
  readonly insertName?: string;
  readonly updateName?: string;
}

interface ResolvedType {
  readonly inputType?: string;
  readonly outputType?: string;
  readonly hasPolicyMapping: boolean;
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
const RESERVED_EXPORT_NAMES = new Set([
  "any", "as", "asserts", "bigint", "boolean", "break", "case", "catch", "class", "const", "continue",
  "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof", "interface",
  "keyof", "let", "module", "namespace", "never", "new", "null", "number", "object", "of", "package",
  "private", "protected", "public", "readonly", "require", "return", "set", "static", "string", "super",
  "switch", "symbol", "this", "throw", "true", "try", "type", "typeof", "undefined", "unique", "unknown",
  "var", "void", "while", "with", "yield",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeDatabaseType(value: string): string {
  return value.toLowerCase();
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported codegen option value: ${typeof value}`);
}

function validateTypePolicy(policy: unknown): asserts policy is CodegenOptions["typePolicy"] {
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

function validateStringList(value: unknown, field: string): asserts value is readonly string[] | undefined {
  if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
    throw new TypeError(`Codegen ${field} must be an array of strings.`);
  }
}

function validateOverride(value: unknown, field: string): asserts value is CodegenTypeOverride {
  if (!isRecord(value)) throw new TypeError(`Codegen ${field} must be an object.`);
  for (const key of ["inputType", "outputType"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0)) {
      throw new TypeError(`Codegen ${field}.${key} must be a non-empty string.`);
    }
  }
  if (value.inputType === undefined && value.outputType === undefined) {
    throw new TypeError(`Codegen ${field} must specify inputType or outputType.`);
  }
}

function validateOptions(options: unknown): asserts options is CodegenOptions {
  if (!isRecord(options)) throw new TypeError("Codegen options must be an object.");
  validateTypePolicy(options.typePolicy);
  const filters = options.filters;
  if (filters !== undefined) {
    if (!isRecord(filters)) throw new TypeError("Codegen filters must be an object.");
    for (const field of ["includeNamespaces", "excludeNamespaces", "includeRelations", "excludeRelations", "kinds"]) {
      validateStringList(filters[field], `filters.${field}`);
    }
    const kinds = filters.kinds as readonly string[] | undefined;
    if (kinds?.some((kind) => !["table", "view", "materialized", "foreign", "virtual", "unknown"].includes(kind))) {
      throw new TypeError("Codegen filters.kinds contains an invalid relation kind.");
    }
  }
  const naming = options.naming;
  if (naming !== undefined) {
    if (!isRecord(naming)) throw new TypeError("Codegen naming must be an object.");
    if (naming.relations !== undefined && (!isRecord(naming.relations) || Object.entries(naming.relations).some(([, name]) => typeof name !== "string"))) {
      throw new TypeError("Codegen naming.relations must be a string map.");
    }
    if (naming.suffixes !== undefined) {
      if (!isRecord(naming.suffixes)) throw new TypeError("Codegen naming.suffixes must be an object.");
      for (const field of ["row", "insert", "update"]) {
        if (naming.suffixes[field] !== undefined && (typeof naming.suffixes[field] !== "string" || naming.suffixes[field].length === 0)) {
          throw new TypeError(`Codegen naming.suffixes.${field} must be a non-empty string.`);
        }
      }
    }
  }
  const typeOverrides = options.typeOverrides;
  if (typeOverrides !== undefined) {
    if (!isRecord(typeOverrides)) throw new TypeError("Codegen typeOverrides must be an object.");
    if (typeOverrides.databaseTypes !== undefined) {
      if (!isRecord(typeOverrides.databaseTypes)) throw new TypeError("Codegen typeOverrides.databaseTypes must be an object.");
      for (const [key, value] of Object.entries(typeOverrides.databaseTypes)) validateOverride(value, `typeOverrides.databaseTypes[${JSON.stringify(key)}]`);
    }
    if (typeOverrides.columns !== undefined) {
      if (!isRecord(typeOverrides.columns)) throw new TypeError("Codegen typeOverrides.columns must be an object.");
      for (const [relation, columns] of Object.entries(typeOverrides.columns)) {
        if (!isRecord(columns)) throw new TypeError(`Codegen typeOverrides.columns[${JSON.stringify(relation)}] must be an object.`);
        for (const [column, value] of Object.entries(columns)) validateOverride(value, `typeOverrides.columns[${JSON.stringify(relation)}][${JSON.stringify(column)}]`);
      }
    }
  }
}

function indexTypePolicy(policy: CodegenOptions["typePolicy"], diagnostics: CodegenDiagnostic[]): ReadonlyMap<string, TypeMapping | undefined> {
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
  overrides: CodegenTypeOverrides | undefined,
  needsInput: boolean,
  diagnostics: CodegenDiagnostic[],
): ResolvedType {
  const isSqlite = metadata.dialect.toLowerCase() === "sqlite";
  const isDynamicSqlite = isSqlite && relation.strict !== true;
  if (isDynamicSqlite) {
    diagnostics.push({
      code: "CODEGEN_SQLITE_DYNAMIC_TYPE",
      severity: "warning",
      message: "SQLite non-STRICT declared affinity is insufficient for automatic TypePolicy mapping; unresolved override sides remain unknown.",
      relation: relation.identity,
      column: column.name,
      databaseType: column.type,
    });
  }

  const columnOverrides = overrides?.columns?.[relation.identity];
  const columnOverride = columnOverrides && Object.hasOwn(columnOverrides, column.name) ? columnOverrides[column.name] : undefined;
  const databaseOverrides = overrides?.databaseTypes;
  const databaseOverride = databaseOverrides && Object.hasOwn(databaseOverrides, column.type) ? databaseOverrides[column.type] : undefined;
  let mapping: TypeMapping | undefined;
  let hasPolicyMapping = false;
  if (!isDynamicSqlite) {
    for (const candidate of policyTypeCandidates(metadata, column, relation)) {
      const key = normalizeDatabaseType(candidate);
      if (!policy.has(key)) continue;
      mapping = policy.get(key);
      hasPolicyMapping = true;
      break;
    }
  }

  const inputType = columnOverride?.inputType ?? databaseOverride?.inputType ?? mapping?.inputType;
  const outputType = columnOverride?.outputType ?? databaseOverride?.outputType ?? mapping?.outputType;
  if (isDynamicSqlite && !inputType && !outputType) return { hasPolicyMapping: false };
  if (!inputType && !outputType && !hasPolicyMapping) {
    diagnostics.push({
      code: "CODEGEN_UNKNOWN_DATABASE_TYPE",
      severity: "warning",
      message: `No TypePolicy mapping or type override matches database type ${JSON.stringify(column.type)}.`,
      relation: relation.identity,
      column: column.name,
      databaseType: column.type,
    });
  } else {
    if (needsInput && !inputType) diagnostics.push({
      code: "CODEGEN_UNKNOWN_INPUT_TYPE",
      severity: "warning",
      message: `No input representation is available for database type ${JSON.stringify(column.type)}.`,
      relation: relation.identity,
      column: column.name,
      databaseType: column.type,
    });
    if (!outputType) diagnostics.push({
      code: "CODEGEN_UNKNOWN_OUTPUT_TYPE",
      severity: "warning",
      message: `No output representation is available for database type ${JSON.stringify(column.type)}.`,
      relation: relation.identity,
      column: column.name,
      databaseType: column.type,
    });
  }
  return { inputType, outputType, hasPolicyMapping };
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

function isValidExportIdentifier(value: string): boolean {
  if (value.length === 0 || RESERVED_EXPORT_NAMES.has(value)) return false;
  const characters = [...value];
  const first = characters[0];
  if (!first || !IDENTIFIER_START.test(first)) return false;
  return characters.slice(1).every((character) => IDENTIFIER_PART.test(character));
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

function selectedRelations(metadata: MetadataSnapshot, filters: CodegenRelationFilter | undefined, diagnostics: CodegenDiagnostic[]): readonly RelationSnapshot[] {
  const allRelations = Object.values(metadata.relations).sort((left, right) => compareStrings(left.identity, right.identity));
  const includeRelations = filters?.includeRelations;
  for (const identity of includeRelations ?? []) {
    if (!allRelations.some((relation) => relation.identity === identity)) {
      diagnostics.push({
        code: "CODEGEN_FILTER_RELATION_NOT_FOUND",
        severity: "warning",
        message: `Included relation ${JSON.stringify(identity)} was not found in metadata.`,
        relation: identity,
      });
    }
  }
  return allRelations.filter((relation) => {
    const namespace = relation.namespace;
    if (includeRelations && includeRelations.length > 0 && !includeRelations.includes(relation.identity)) return false;
    if (filters?.excludeRelations?.includes(relation.identity)) return false;
    if (filters?.includeNamespaces && filters.includeNamespaces.length > 0 && (namespace === undefined || !filters.includeNamespaces.includes(namespace))) return false;
    if (namespace !== undefined && filters?.excludeNamespaces?.includes(namespace)) return false;
    if (filters?.kinds && filters.kinds.length > 0 && !filters.kinds.includes(relation.kind)) return false;
    return true;
  });
}

function nameRelations(
  relations: readonly RelationSnapshot[],
  naming: CodegenNamingOptions | undefined,
  allRelations: readonly RelationSnapshot[],
  diagnostics: CodegenDiagnostic[],
): readonly NamedRelation[] {
  const explicit = naming?.relations ?? {};
  for (const identity of Object.keys(explicit)) {
    if (!allRelations.some((relation) => relation.identity === identity)) {
      diagnostics.push({
        code: "CODEGEN_NAMING_RELATION_NOT_FOUND",
        severity: "warning",
        message: `Naming override relation ${JSON.stringify(identity)} was not found in metadata.`,
        relation: identity,
      });
    }
  }
  const defaultNamed = disambiguateRelations(relations, diagnostics);
  const named = defaultNamed.map((entry) => {
    const requested = Object.hasOwn(explicit, entry.relation.identity) ? explicit[entry.relation.identity] : undefined;
    if (requested === undefined) return entry;
    if (!isValidExportIdentifier(requested)) {
      diagnostics.push({
        code: "CODEGEN_INVALID_MODEL_NAME",
        severity: "error",
        message: `Explicit model name ${JSON.stringify(requested)} is not a valid exported TypeScript identifier.`,
        relation: entry.relation.identity,
      });
      return entry;
    }
    return { ...entry, modelName: requested };
  });
  const modelGroups = groupByName(named);
  for (const [modelName, group] of modelGroups) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) =>
      Number(explicit[right.relation.identity] !== undefined) - Number(explicit[left.relation.identity] !== undefined)
      || compareStrings(left.relation.identity, right.relation.identity));
    diagnostics.push({
      code: "CODEGEN_MODEL_NAME_COLLISION",
      severity: "error",
      message: `Model name ${JSON.stringify(modelName)} is used by multiple relations: ${group.map((entry) => entry.relation.identity).sort(compareStrings).join(", ")}.`,
      relation: ordered[0]?.relation.identity,
    });
    for (const entry of ordered.slice(1)) {
      const index = named.indexOf(entry);
      if (index >= 0) named[index] = { ...entry, modelName: `${entry.modelName}_${stableDigest(entry.relation.identity).slice(0, 12)}` };
    }
  }
  const suffixes = naming?.suffixes;
  const finalNames = named.map((entry) => {
    const rowName = `${entry.modelName}${suffixes?.row ?? "Row"}`;
    const insertName = `${entry.modelName}${suffixes?.insert ?? "Insert"}`;
    const updateName = `${entry.modelName}${suffixes?.update ?? "Update"}`;
    if (!isValidExportIdentifier(rowName) || (entry.relation.kind === "table" && (!isValidExportIdentifier(insertName) || !isValidExportIdentifier(updateName)))) {
      diagnostics.push({
        code: "CODEGEN_INVALID_MODEL_NAME",
        severity: "error",
        message: `Generated model name for ${JSON.stringify(entry.relation.identity)} is not a valid exported TypeScript identifier.`,
        relation: entry.relation.identity,
      });
      return {
        ...entry,
        rowName: `${entry.modelName}Row`,
        ...(entry.relation.kind === "table" ? { insertName: `${entry.modelName}Insert`, updateName: `${entry.modelName}Update` } : {}),
      };
    }
    return {
      ...entry,
      rowName,
      ...(entry.relation.kind === "table" ? { insertName, updateName } : {}),
    };
  });
  const declarationOwners = new Map<string, { readonly relationIdentity: string; readonly kind: string }>();
  return finalNames.map((entry) => {
    const claim = (candidate: string, kind: string): string => {
      const owner = declarationOwners.get(candidate);
      if (!owner) {
        declarationOwners.set(candidate, { relationIdentity: entry.relation.identity, kind });
        return candidate;
      }
      diagnostics.push({
        code: "CODEGEN_MODEL_NAME_COLLISION",
        severity: "error",
        message: `Exported declaration name ${JSON.stringify(candidate)} for ${JSON.stringify(entry.relation.identity)} ${kind} collides with ${JSON.stringify(owner.relationIdentity)} ${owner.kind}; a deterministic identity suffix was added.`,
        relation: entry.relation.identity,
      });
      const identitySuffix = stableDigest(`${entry.relation.identity}\u0000${kind}`).slice(0, 12);
      let disambiguated = `${candidate}_${identitySuffix}`;
      let attempt = 2;
      while (declarationOwners.has(disambiguated)) {
        disambiguated = `${candidate}_${identitySuffix}_${attempt}`;
        attempt += 1;
      }
      declarationOwners.set(disambiguated, { relationIdentity: entry.relation.identity, kind });
      return disambiguated;
    };
    return {
      ...entry,
      rowName: claim(entry.rowName, "row"),
      ...(entry.insertName !== undefined ? { insertName: claim(entry.insertName, "insert") } : {}),
      ...(entry.updateName !== undefined ? { updateName: claim(entry.updateName, "update") } : {}),
    };
  });
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
  overrides: CodegenTypeOverrides | undefined,
  diagnostics: CodegenDiagnostic[],
): string {
  const columns = [...relation.columns].sort(
    (left, right) => left.ordinal - right.ordinal || compareStrings(left.name, right.name),
  );
  const resolved = new Map<string, ResolvedType>();
  for (const column of columns) {
    const needsInput = relation.kind === "table"
      && column.generated !== true
      && (column.insertable !== false || column.updatable !== false);
    resolved.set(column.name, resolveType(metadata, policy, relation, column, overrides, needsInput, diagnostics));
  }

  const rowProperties = columns.map((column) =>
    renderProperty(column, resolved.get(column.name)?.outputType ?? "unknown", false),
  );
  const blocks = [renderInterface(names.rowName, rowProperties)];

  if (relation.kind === "table") {
    const insertProperties = columns
      .filter((column) => column.insertable !== false && column.generated !== true)
      .map((column) => {
        const mapping = resolved.get(column.name);
        return renderProperty(column, mapping?.inputType ?? "unknown", column.identity === true || column.defaultExpression !== undefined || column.nullable);
      });
    const updateProperties = columns
      .filter((column) => column.updatable !== false && column.generated !== true)
      .map((column) => {
        const mapping = resolved.get(column.name);
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
  validateOptions(options);
  const policy = options.typePolicy;
  const diagnostics: CodegenDiagnostic[] = [];
  const policyIndex = indexTypePolicy(policy, diagnostics);
  const metadataHash = hashSnapshot(metadata);
  const allRelations = Object.values(metadata.relations).sort((left, right) => compareStrings(left.identity, right.identity));
  const filteredRelations = selectedRelations(metadata, options.filters, diagnostics);
  for (const relation of filteredRelations) {
    if (relation.kind === "unknown") {
      diagnostics.push({
        code: "CODEGEN_UNKNOWN_RELATION_KIND",
        severity: "warning",
        message: "Relation kind is unknown; only columns with evidence can receive a read model.",
        relation: relation.identity,
      });
    }
  }
  const relations = filteredRelations.filter(
    (relation) => READABLE_RELATION_KINDS.has(relation.kind) || (relation.kind === "unknown" && relation.columns.length > 0),
  );
  const typeOverrides = options.typeOverrides;
  for (const [identity, columns] of Object.entries(typeOverrides?.columns ?? {})) {
    const relation = allRelations.find((candidate) => candidate.identity === identity);
    if (!relation) {
      diagnostics.push({
        code: "CODEGEN_TYPE_RELATION_NOT_FOUND",
        severity: "warning",
        message: `Type override relation ${JSON.stringify(identity)} was not found in metadata.`,
        relation: identity,
      });
      continue;
    }
    for (const column of Object.keys(columns)) {
      if (!relation.columns.some((candidate) => candidate.name === column)) diagnostics.push({
        code: "CODEGEN_TYPE_COLUMN_NOT_FOUND",
        severity: "warning",
        message: `Type override column ${JSON.stringify(column)} was not found on relation ${JSON.stringify(identity)}.`,
        relation: identity,
        column,
      });
    }
  }
  for (const databaseType of Object.keys(typeOverrides?.databaseTypes ?? {})) {
    if (!allRelations.some((relation) => relation.columns.some((column) => column.type === databaseType))) {
      diagnostics.push({
        code: "CODEGEN_DATABASE_TYPE_OVERRIDE_UNUSED",
        severity: "warning",
        message: `Database type override ${JSON.stringify(databaseType)} did not match any metadata column type.`,
        databaseType,
      });
    }
  }
  const namedRelations = nameRelations(relations, options.naming, allRelations, diagnostics);
  const blocks = namedRelations.map((named) => renderRelation(named.relation, named, metadata, policyIndex, typeOverrides, diagnostics));
  const generationOptions = {
    filters: options.filters,
    naming: options.naming,
    typeOverrides,
  };
  const optionsHash = stableDigest(canonicalValue(generationOptions));
  const source = [
    "// Generated by @sqlbraid/codegen. Do not edit.",
    `// Metadata: ${safeComment(metadataHash)}`,
    `// TypePolicy: ${safeComment(policy.id)} (${safeComment(policy.hash)})`,
    `// Codegen: ${optionsHash}`,
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
    optionsHash,
  };
}
