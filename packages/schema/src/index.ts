import { createHash } from "node:crypto";

export const CURRENT_FORMAT_VERSION = 1 as const;

export interface ServerEvidence {
  readonly version?: string;
  readonly majorVersion?: number;
  readonly product?: string;
  readonly capabilities?: Readonly<Record<string, boolean | string | number>>;
  readonly [key: string]: unknown;
}

export interface SnapshotMetadata {
  readonly generatedAt?: string;
  readonly source?: string;
  readonly typePolicyId?: string;
  readonly typePolicyHash?: string;
  readonly grammarRevision?: string;
  readonly introspectionScope?: string;
  readonly [key: string]: unknown;
}

export interface NamespaceSnapshot {
  readonly name: string;
  readonly catalog?: string;
  readonly kind?: "database" | "schema" | "attached" | "unknown";
  readonly [key: string]: unknown;
}

export type TypeKind = "scalar" | "enum" | "domain" | "composite" | "array" | "range" | "multirange" | "opaque" | "unknown";

export interface TypeSnapshot {
  readonly identity: string;
  readonly name: string;
  readonly kind: TypeKind;
  readonly tsType?: string;
  readonly elementType?: string;
  readonly baseType?: string;
  readonly values?: readonly string[];
  readonly [key: string]: unknown;
}

export interface ColumnSnapshot {
  readonly name: string;
  readonly ordinal: number;
  readonly type: string;
  readonly tsType?: string;
  readonly nullable: boolean;
  readonly nullabilityEvidence?: string;
  readonly defaultExpression?: string;
  readonly generated?: boolean;
  readonly identity?: boolean;
  readonly insertable?: boolean;
  readonly updatable?: boolean;
  readonly charset?: string;
  readonly collation?: string;
  readonly [key: string]: unknown;
}

export interface ConstraintSnapshot {
  readonly name: string;
  readonly kind: string;
  readonly columns?: readonly string[];
  readonly referencedRelation?: string;
  readonly referencedColumns?: readonly string[];
  readonly [key: string]: unknown;
}

export interface IndexSnapshot {
  readonly name: string;
  readonly unique?: boolean;
  readonly columns: readonly string[];
  readonly [key: string]: unknown;
}

export interface RelationSnapshot {
  readonly identity: string;
  readonly name: string;
  readonly namespace?: string;
  readonly kind: "table" | "view" | "materialized" | "foreign" | "virtual" | "unknown";
  readonly columns: readonly ColumnSnapshot[];
  readonly constraints?: readonly ConstraintSnapshot[];
  readonly indexes?: readonly IndexSnapshot[];
  readonly [key: string]: unknown;
}

export type RoutineArgumentMode = "in" | "out" | "inout" | "variadic";

export interface RoutineArgument {
  readonly name?: string;
  readonly mode: RoutineArgumentMode;
  readonly type: string;
  readonly tsType?: string;
  readonly nullable?: boolean;
  readonly [key: string]: unknown;
}

export type RoutineResult =
  | { readonly kind: "scalar"; readonly type: string; readonly tsType?: string; readonly nullable?: boolean; readonly [key: string]: unknown }
  | { readonly kind: "set" | "record" | "table"; readonly columns?: readonly ColumnSnapshot[]; readonly rowType?: string; readonly [key: string]: unknown }
  | { readonly kind: "void" | "command" | "unknown" | "opaque"; readonly [key: string]: unknown };

export interface RoutineSnapshot {
  readonly name: string;
  readonly schema?: string;
  readonly identity: string;
  readonly kind: "function" | "procedure" | "aggregate" | "window";
  readonly arguments: readonly RoutineArgument[];
  readonly result: RoutineResult;
  readonly volatility?: "immutable" | "stable" | "volatile" | "unknown";
  readonly deterministic?: boolean;
  readonly dataAccess?: "none" | "read" | "write" | "unknown";
  readonly nullInput?: "strict" | "called" | "unknown";
  readonly versionRange?: string;
  readonly [key: string]: unknown;
}

export interface SchemaSnapshot {
  readonly formatVersion: number;
  readonly dialect: string;
  readonly dialectVersion: string;
  readonly server: ServerEvidence;
  readonly namespaces: Readonly<Record<string, NamespaceSnapshot>>;
  readonly types: Readonly<Record<string, TypeSnapshot>>;
  readonly relations: Readonly<Record<string, RelationSnapshot>>;
  readonly routines: Readonly<Record<string, readonly RoutineSnapshot[]>>;
  readonly metadata: SnapshotMetadata;
  readonly [key: string]: unknown;
}

export interface SnapshotDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface SnapshotDrift {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export class SnapshotValidationError extends Error {
  readonly diagnostics: readonly SnapshotDiagnostic[];

  constructor(diagnostics: readonly SnapshotDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"));
    this.name = "SnapshotValidationError";
    this.diagnostics = diagnostics;
  }
}

function sortedRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

function normalizeSnapshot(snapshot: SchemaSnapshot): SchemaSnapshot {
  const relations: Record<string, RelationSnapshot> = {};
  for (const [key, relation] of Object.entries(snapshot.relations).sort(([left], [right]) => left.localeCompare(right))) {
    relations[key] = {
      ...relation,
      columns: [...relation.columns].sort((left, right) => left.ordinal - right.ordinal),
      constraints: relation.constraints ? [...relation.constraints].sort((left, right) => left.name.localeCompare(right.name)) : undefined,
      indexes: relation.indexes ? [...relation.indexes].sort((left, right) => left.name.localeCompare(right.name)) : undefined,
    };
  }
  const routines: Record<string, readonly RoutineSnapshot[]> = {};
  for (const [key, values] of Object.entries(snapshot.routines).sort(([left], [right]) => left.localeCompare(right))) routines[key] = [...values].sort((left, right) => left.identity.localeCompare(right.identity));
  return { ...snapshot, namespaces: sortedRecord(snapshot.namespaces), types: sortedRecord(snapshot.types), relations, routines };
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`).join(",")}}`;
  }
  throw new TypeError(`Snapshot contains unsupported value: ${typeof value}`);
}

export function validateSnapshot(snapshot: unknown): asserts snapshot is SchemaSnapshot {
  const diagnostics: SnapshotDiagnostic[] = [];
  if (!snapshot || typeof snapshot !== "object") throw new SnapshotValidationError([{ code: "SNAPSHOT_OBJECT", message: "Snapshot must be an object." }]);
  const candidate = snapshot as Partial<SchemaSnapshot>;
  if (candidate.formatVersion !== CURRENT_FORMAT_VERSION) diagnostics.push({ code: "SNAPSHOT_VERSION", message: `Unsupported snapshot format version: ${String(candidate.formatVersion)}.`, path: "formatVersion" });
  if (typeof candidate.dialect !== "string" || !candidate.dialect) diagnostics.push({ code: "SNAPSHOT_DIALECT", message: "Snapshot dialect must be a non-empty string.", path: "dialect" });
  if (typeof candidate.dialectVersion !== "string" || !candidate.dialectVersion) diagnostics.push({ code: "SNAPSHOT_DIALECT_VERSION", message: "Snapshot dialectVersion must be a non-empty string.", path: "dialectVersion" });
  for (const field of ["server", "namespaces", "types", "relations", "routines", "metadata"] as const) {
    if (!candidate[field] || typeof candidate[field] !== "object") diagnostics.push({ code: "SNAPSHOT_FIELD", message: `Snapshot field ${field} must be an object.`, path: field });
  }
  if (diagnostics.length) throw new SnapshotValidationError(diagnostics);
}

export function canonicalizeSnapshot(snapshot: SchemaSnapshot): string {
  validateSnapshot(snapshot);
  return canonicalValue(normalizeSnapshot(snapshot));
}

export function hashSnapshot(snapshot: SchemaSnapshot): string {
  return createHash("sha256").update(canonicalizeSnapshot(snapshot)).digest("hex");
}

export function snapshotIdentity(snapshot: SchemaSnapshot): { readonly hash: string; readonly formatVersion: number; readonly dialect: string; readonly dialectVersion: string } {
  validateSnapshot(snapshot);
  return { hash: hashSnapshot(snapshot), formatVersion: snapshot.formatVersion, dialect: snapshot.dialect, dialectVersion: snapshot.dialectVersion };
}

export function migrateSnapshot(snapshot: unknown, targetVersion = CURRENT_FORMAT_VERSION): SchemaSnapshot {
  validateSnapshot(snapshot);
  if (targetVersion !== CURRENT_FORMAT_VERSION) throw new SnapshotValidationError([{ code: "SNAPSHOT_TARGET_VERSION", message: `No migration path to format version ${targetVersion}.` }]);
  return structuredClone(snapshot);
}

function collectDrift(before: unknown, after: unknown, path: string, output: SnapshotDrift[]): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) collectDrift(before[index], after[index], `${path}[${index}]`, output);
    return;
  }
  if (typeof before === "object" && before !== null && typeof after === "object" && after !== null && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) collectDrift((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], path ? `${path}.${key}` : key, output);
    return;
  }
  output.push({ path, before, after });
}

export function diffSnapshots(before: SchemaSnapshot, after: SchemaSnapshot): readonly SnapshotDrift[] {
  validateSnapshot(before);
  validateSnapshot(after);
  const output: SnapshotDrift[] = [];
  collectDrift(JSON.parse(canonicalizeSnapshot(before)), JSON.parse(canonicalizeSnapshot(after)), "", output);
  return output;
}
