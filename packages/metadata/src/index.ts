import { createHash } from "node:crypto";

export {
  qualifiedIdentity,
  qualifiedIdentitySegments,
  qualifiedIdentitySegmentsWithSuffix,
  qualifiedIdentityWithSuffix,
  QUALIFIED_IDENTITY_ENCODING,
} from "./qualified-identity.js";
import { isQualifiedIdentity, qualifiedIdentity, QUALIFIED_IDENTITY_ENCODING } from "./qualified-identity.js";

export const CURRENT_FORMAT_VERSION = 1 as const;

export interface ServerEvidence {
  readonly version?: string;
  readonly majorVersion?: number;
  readonly product?: string;
  readonly capabilities?: Readonly<Record<string, boolean | string | number | readonly string[]>>;
  readonly [key: string]: unknown;
}

export interface SnapshotMetadata {
  readonly generatedAt?: string;
  readonly source?: string;
  readonly introspectionScope?: string;
  readonly completeness?: "complete" | "partial" | "unknown";
  /** Present on snapshots emitted by current inspectors; absent means legacy dot identities. */
  readonly identityEncoding?: typeof QUALIFIED_IDENTITY_ENCODING;
  readonly [key: string]: unknown;
}

export interface NamespaceSnapshot {
  readonly name: string;
  readonly catalog?: string;
  readonly kind?: "database" | "schema" | "attached" | "unknown";
  readonly [key: string]: unknown;
}

export type TypeKind =
  | "scalar"
  | "enum"
  | "domain"
  | "composite"
  | "array"
  | "range"
  | "multirange"
  | "opaque"
  | "unknown";

export interface TypeSnapshot {
  readonly identity: string;
  readonly name: string;
  readonly kind: TypeKind;
  readonly elementType?: string;
  readonly baseType?: string;
  readonly values?: readonly string[];
  readonly [key: string]: unknown;
}

export interface ColumnSnapshot {
  readonly name: string;
  readonly ordinal: number;
  readonly type: string;
  readonly nullable: boolean;
  readonly nullabilityEvidence?: string;
  readonly defaultExpression?: string;
  /** True when the database computes or generates this value; absence means unknown. */
  readonly generated?: boolean;
  /** True only when the database proves an identity/autoincrement mechanism for this column. */
  readonly identity?: boolean;
  /** Whether the database permits explicit inserts; absence means unknown. */
  readonly insertable?: boolean;
  /** Whether the database permits explicit updates; absence means unknown. */
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
  readonly nullable?: boolean;
  readonly hasDefault?: boolean;
  readonly [key: string]: unknown;
}

export type RoutineResult =
  | { readonly kind: "scalar"; readonly type: string; readonly nullable?: boolean; readonly [key: string]: unknown }
  | {
      readonly kind: "set" | "record" | "table";
      readonly columns?: readonly ColumnSnapshot[];
      readonly [key: string]: unknown;
    }
  | { readonly kind: "void" | "command" | "unknown" | "opaque"; readonly [key: string]: unknown };

export interface RoutineSnapshot {
  readonly name: string;
  readonly schema?: string;
  readonly packageName?: string;
  readonly identity: string;
  readonly kind: "function" | "procedure" | "aggregate" | "window";
  readonly arguments: readonly RoutineArgument[];
  /** Whether the snapshot proves that the complete routine argument list is present. */
  readonly argumentsComplete?: boolean;
  readonly result: RoutineResult;
  readonly volatility?: "immutable" | "stable" | "volatile" | "unknown";
  readonly deterministic?: boolean;
  readonly dataAccess?: "none" | "read" | "write" | "unknown";
  readonly nullInput?: "strict" | "called" | "unknown";
  readonly versionRange?: string;
  readonly [key: string]: unknown;
}

export interface MetadataSnapshot {
  readonly format: "sqlbraid-metadata";
  readonly formatVersion: typeof CURRENT_FORMAT_VERSION;
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

export interface MetadataInspector {
  readonly dialect: string;
  inspect(): Promise<MetadataSnapshot>;
}

export class SnapshotValidationError extends Error {
  readonly diagnostics: readonly SnapshotDiagnostic[];

  constructor(diagnostics: readonly SnapshotDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"));
    this.name = "SnapshotValidationError";
    this.diagnostics = diagnostics;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function add(diagnostics: SnapshotDiagnostic[], code: string, message: string, path: string): void {
  diagnostics.push({ code, message, path });
}

function validateMarkedIdentity(
  value: unknown,
  path: string,
  marked: boolean,
  diagnostics: SnapshotDiagnostic[],
): void {
  if (marked && (typeof value !== "string" || !isQualifiedIdentity(value))) {
    add(diagnostics, "SNAPSHOT_IDENTITY", "Marked qualified identities must use escaped-qualified-v1 encoding.", path);
  }
}

function scanSnapshotValues(value: unknown, path: string, diagnostics: SnapshotDiagnostic[]): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    add(diagnostics, "SNAPSHOT_NUMBER", "Snapshot numbers must be finite.", path);
    return;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    add(diagnostics, "SNAPSHOT_VALUE", `Unsupported snapshot value: ${typeof value}.`, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSnapshotValues(entry, `${path}[${index}]`, diagnostics));
    return;
  }
  if (isRecord(value))
    for (const [key, entry] of Object.entries(value))
      scanSnapshotValues(entry, path ? `${path}.${key}` : key, diagnostics);
}

function validateColumn(value: unknown, path: string, diagnostics: SnapshotDiagnostic[]): void {
  if (!isRecord(value)) {
    add(diagnostics, "SNAPSHOT_COLUMN", "Column must be an object.", path);
    return;
  }
  if (typeof value.name !== "string" || !value.name)
    add(diagnostics, "SNAPSHOT_COLUMN_NAME", "Column name must be non-empty.", `${path}.name`);
  if (!isFiniteNumber(value.ordinal) || !Number.isInteger(value.ordinal) || value.ordinal < 0)
    add(diagnostics, "SNAPSHOT_COLUMN_ORDINAL", "Column ordinal must be a non-negative integer.", `${path}.ordinal`);
  if (typeof value.type !== "string" || !value.type)
    add(diagnostics, "SNAPSHOT_COLUMN_TYPE", "Column type must be non-empty.", `${path}.type`);
  if (typeof value.nullable !== "boolean")
    add(diagnostics, "SNAPSHOT_COLUMN_NULLABLE", "Column nullable must be boolean.", `${path}.nullable`);
  for (const field of ["nullabilityEvidence", "defaultExpression", "charset", "collation"]) {
    if (value[field] !== undefined && typeof value[field] !== "string")
      add(diagnostics, "SNAPSHOT_COLUMN_FACT", `Column ${field} must be a string.`, `${path}.${field}`);
  }
  for (const field of ["generated", "identity", "insertable", "updatable"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean")
      add(diagnostics, "SNAPSHOT_COLUMN_FACT", `Column ${field} must be boolean.`, `${path}.${field}`);
  }
}

function validateRelation(value: unknown, path: string, diagnostics: SnapshotDiagnostic[]): void {
  if (!isRecord(value)) {
    add(diagnostics, "SNAPSHOT_RELATION", "Relation must be an object.", path);
    return;
  }
  if (typeof value.identity !== "string" || !value.identity)
    add(diagnostics, "SNAPSHOT_RELATION_ID", "Relation identity must be non-empty.", `${path}.identity`);
  if (typeof value.name !== "string" || !value.name)
    add(diagnostics, "SNAPSHOT_RELATION_NAME", "Relation name must be non-empty.", `${path}.name`);
  if (value.namespace !== undefined && typeof value.namespace !== "string")
    add(diagnostics, "SNAPSHOT_RELATION_NAMESPACE", "Relation namespace must be a string.", `${path}.namespace`);
  if (value.strict !== undefined && typeof value.strict !== "boolean")
    add(diagnostics, "SNAPSHOT_RELATION_STRICT", "Relation strict evidence must be boolean.", `${path}.strict`);
  if (!["table", "view", "materialized", "foreign", "virtual", "unknown"].includes(String(value.kind)))
    add(diagnostics, "SNAPSHOT_RELATION_KIND", "Relation kind is invalid.", `${path}.kind`);
  if (!Array.isArray(value.columns)) {
    add(diagnostics, "SNAPSHOT_RELATION_COLUMNS", "Relation columns must be an array.", `${path}.columns`);
    return;
  }
  const names = new Set<string>();
  const ordinals = new Set<number>();
  value.columns.forEach((column, index) => {
    validateColumn(column, `${path}.columns[${index}]`, diagnostics);
    if (!isRecord(column)) return;
    if (typeof column.name === "string" && names.has(column.name))
      add(
        diagnostics,
        "SNAPSHOT_DUPLICATE_COLUMN",
        `Duplicate column: ${column.name}.`,
        `${path}.columns[${index}].name`,
      );
    if (typeof column.name === "string") names.add(column.name);
    if (isFiniteNumber(column.ordinal) && ordinals.has(column.ordinal))
      add(
        diagnostics,
        "SNAPSHOT_DUPLICATE_ORDINAL",
        `Duplicate column ordinal: ${column.ordinal}.`,
        `${path}.columns[${index}].ordinal`,
      );
    if (isFiniteNumber(column.ordinal)) ordinals.add(column.ordinal);
  });
}

function validateRoutine(value: unknown, path: string, diagnostics: SnapshotDiagnostic[]): void {
  if (!isRecord(value)) {
    add(diagnostics, "SNAPSHOT_ROUTINE", "Routine must be an object.", path);
    return;
  }
  if (typeof value.identity !== "string" || !value.identity)
    add(diagnostics, "SNAPSHOT_ROUTINE_ID", "Routine identity must be non-empty.", `${path}.identity`);
  if (typeof value.name !== "string" || !value.name)
    add(diagnostics, "SNAPSHOT_ROUTINE_NAME", "Routine name must be non-empty.", `${path}.name`);
  if (value.schema !== undefined && typeof value.schema !== "string")
    add(diagnostics, "SNAPSHOT_ROUTINE_SCHEMA", "Routine schema must be a string.", `${path}.schema`);
  if (value.packageName !== undefined && typeof value.packageName !== "string")
    add(diagnostics, "SNAPSHOT_ROUTINE_PACKAGE", "Routine packageName must be a string.", `${path}.packageName`);
  if (!["function", "procedure", "aggregate", "window"].includes(String(value.kind)))
    add(diagnostics, "SNAPSHOT_ROUTINE_KIND", "Routine kind is invalid.", `${path}.kind`);
  if (!Array.isArray(value.arguments))
    add(diagnostics, "SNAPSHOT_ROUTINE_ARGS", "Routine arguments must be an array.", `${path}.arguments`);
  else {
    value.arguments.forEach((argument, index) => {
      if (!isRecord(argument)) {
        add(diagnostics, "SNAPSHOT_ARGUMENT", "Routine argument must be an object.", `${path}.arguments[${index}]`);
        return;
      }
      if (!["in", "out", "inout", "variadic"].includes(String(argument.mode)))
        add(
          diagnostics,
          "SNAPSHOT_ARGUMENT_MODE",
          "Routine argument mode is invalid.",
          `${path}.arguments[${index}].mode`,
        );
      if (typeof argument.type !== "string" || !argument.type)
        add(
          diagnostics,
          "SNAPSHOT_ARGUMENT_TYPE",
          "Routine argument type must be non-empty.",
          `${path}.arguments[${index}].type`,
        );
      if (argument.name !== undefined && typeof argument.name !== "string")
        add(
          diagnostics,
          "SNAPSHOT_ARGUMENT_NAME",
          "Routine argument name must be a string.",
          `${path}.arguments[${index}].name`,
        );
      for (const field of ["nullable", "hasDefault"]) {
        if (argument[field] !== undefined && typeof argument[field] !== "boolean")
          add(
            diagnostics,
            "SNAPSHOT_ARGUMENT_FACT",
            `Routine argument ${field} must be boolean.`,
            `${path}.arguments[${index}].${field}`,
          );
      }
    });
  }
  if (value.argumentsComplete !== undefined && typeof value.argumentsComplete !== "boolean")
    add(
      diagnostics,
      "SNAPSHOT_ROUTINE_ARGS_COMPLETE",
      "Routine argumentsComplete must be boolean.",
      `${path}.argumentsComplete`,
    );
  if (!isRecord(value.result))
    add(diagnostics, "SNAPSHOT_RESULT", "Routine result must be an object.", `${path}.result`);
  else if (value.result.kind === "scalar") {
    if (typeof value.result.type !== "string" || !value.result.type)
      add(diagnostics, "SNAPSHOT_RESULT_TYPE", "Scalar result type must be non-empty.", `${path}.result.type`);
    if (value.result.nullable !== undefined && typeof value.result.nullable !== "boolean")
      add(
        diagnostics,
        "SNAPSHOT_RESULT_NULLABLE",
        "Scalar result nullable must be boolean.",
        `${path}.result.nullable`,
      );
  } else if (["table", "record", "set"].includes(String(value.result.kind)) && value.result.columns !== undefined) {
    if (!Array.isArray(value.result.columns))
      add(diagnostics, "SNAPSHOT_RESULT_COLUMNS", "Routine result columns must be an array.", `${path}.result.columns`);
    else
      value.result.columns.forEach((column, index) =>
        validateColumn(column, `${path}.result.columns[${index}]`, diagnostics),
      );
  }
}

function sortedRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const output: Record<string, T> = Object.create(null);
  for (const key of Object.keys(record).sort(compareKeys)) output[key] = record[key]!;
  return output;
}

function normalizeSnapshot(snapshot: MetadataSnapshot, includeVolatile: boolean): MetadataSnapshot {
  const relations: Record<string, RelationSnapshot> = Object.create(null);
  for (const [key, relation] of Object.entries(snapshot.relations).sort(([left], [right]) =>
    compareKeys(left, right),
  )) {
    relations[key] = {
      ...relation,
      columns: [...relation.columns].sort(
        (left, right) => left.ordinal - right.ordinal || compareKeys(left.name, right.name),
      ),
      constraints: relation.constraints
        ? [...relation.constraints].sort((left, right) => compareKeys(left.name, right.name))
        : undefined,
      indexes: relation.indexes
        ? [...relation.indexes].sort((left, right) => compareKeys(left.name, right.name))
        : undefined,
    };
  }
  const routines: Record<string, readonly RoutineSnapshot[]> = Object.create(null);
  for (const [key, values] of Object.entries(snapshot.routines).sort(([left], [right]) => compareKeys(left, right)))
    routines[key] = [...values].sort((left, right) => compareKeys(left.identity, right.identity));
  const metadata: Record<string, unknown> = Object.create(null);
  for (const [key, value] of (includeVolatile
    ? Object.entries(snapshot.metadata)
    : Object.entries(snapshot.metadata).filter(
        ([metadataKey]) => !["generatedAt", "observedAt", "capturedAt"].includes(metadataKey),
      )
  ).sort(([left], [right]) => compareKeys(left, right)))
    metadata[key] = value;
  return {
    ...snapshot,
    metadata,
    namespaces: sortedRecord(snapshot.namespaces),
    types: sortedRecord(snapshot.types),
    relations,
    routines,
  };
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Snapshot contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isRecord(value))
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
      .join(",")}}`;
  throw new TypeError(`Snapshot contains unsupported value: ${typeof value}`);
}

export function validateSnapshot(snapshot: unknown): asserts snapshot is MetadataSnapshot {
  const diagnostics: SnapshotDiagnostic[] = [];
  if (!isRecord(snapshot))
    throw new SnapshotValidationError([{ code: "SNAPSHOT_OBJECT", message: "Snapshot must be an object." }]);
  scanSnapshotValues(snapshot, "", diagnostics);
  if (snapshot.format !== "sqlbraid-metadata")
    add(diagnostics, "SNAPSHOT_FORMAT", `Unsupported snapshot format: ${String(snapshot.format)}.`, "format");
  if (snapshot.formatVersion !== CURRENT_FORMAT_VERSION)
    add(
      diagnostics,
      "SNAPSHOT_VERSION",
      `Unsupported snapshot format version: ${String(snapshot.formatVersion)}.`,
      "formatVersion",
    );
  if (typeof snapshot.dialect !== "string" || !snapshot.dialect)
    add(diagnostics, "SNAPSHOT_DIALECT", "Snapshot dialect must be a non-empty string.", "dialect");
  if (typeof snapshot.dialectVersion !== "string" || !snapshot.dialectVersion)
    add(
      diagnostics,
      "SNAPSHOT_DIALECT_VERSION",
      "Snapshot dialectVersion must be a non-empty string.",
      "dialectVersion",
    );
  for (const field of ["server", "namespaces", "types", "relations", "routines", "metadata"] as const)
    if (!isRecord(snapshot[field]))
      add(diagnostics, "SNAPSHOT_FIELD", `Snapshot field ${field} must be an object.`, field);
  if (
    isRecord(snapshot.metadata) &&
    snapshot.metadata.identityEncoding !== undefined &&
    snapshot.metadata.identityEncoding !== QUALIFIED_IDENTITY_ENCODING
  ) {
    add(
      diagnostics,
      "SNAPSHOT_IDENTITY_ENCODING",
      `Unsupported qualified identity encoding: ${String(snapshot.metadata.identityEncoding)}.`,
      "metadata.identityEncoding",
    );
  }
  const marked = isRecord(snapshot.metadata) && snapshot.metadata.identityEncoding === QUALIFIED_IDENTITY_ENCODING;
  if (isRecord(snapshot.namespaces))
    for (const [key, value] of Object.entries(snapshot.namespaces))
      if (!isRecord(value) || typeof value.name !== "string" || !value.name)
        add(diagnostics, "SNAPSHOT_NAMESPACE", `Invalid namespace entry: ${key}.`, `namespaces.${key}`);
  const identities = new Set<string>();
  if (isRecord(snapshot.types))
    for (const [key, value] of Object.entries(snapshot.types)) {
      if (!isRecord(value)) {
        add(diagnostics, "SNAPSHOT_TYPE", "Type entry must be an object.", `types.${key}`);
        continue;
      }
      validateMarkedIdentity(value.identity, `types.${key}.identity`, marked, diagnostics);
      if (typeof value.identity !== "string" || !value.identity || typeof value.name !== "string" || !value.name)
        add(diagnostics, "SNAPSHOT_TYPE_ID", "Type identity and name must be non-empty.", `types.${key}`);
      else if (identities.has(value.identity))
        add(
          diagnostics,
          "SNAPSHOT_DUPLICATE_IDENTITY",
          `Duplicate type identity: ${value.identity}.`,
          `types.${key}.identity`,
        );
      else identities.add(value.identity);
      if (
        !["scalar", "enum", "domain", "composite", "array", "range", "multirange", "opaque", "unknown"].includes(
          String(value.kind),
        )
      )
        add(diagnostics, "SNAPSHOT_TYPE_KIND", "Type kind is invalid.", `types.${key}.kind`);
      for (const field of ["elementType", "baseType"]) {
        if (value[field] !== undefined && typeof value[field] !== "string")
          add(diagnostics, "SNAPSHOT_TYPE_FACT", `Type ${field} must be a string.`, `types.${key}.${field}`);
      }
      if (
        value.values !== undefined &&
        (!Array.isArray(value.values) || value.values.some((entry) => typeof entry !== "string"))
      )
        add(diagnostics, "SNAPSHOT_TYPE_VALUES", "Type values must be an array of strings.", `types.${key}.values`);
    }
  const relationIdentities = new Set<string>();
  if (isRecord(snapshot.relations))
    for (const [key, value] of Object.entries(snapshot.relations)) {
      validateRelation(value, `relations.${key}`, diagnostics);
      if (isRecord(value) && typeof value.identity === "string") {
        validateMarkedIdentity(value.identity, `relations.${key}.identity`, marked, diagnostics);
        if (
          isRecord(snapshot.metadata) &&
          snapshot.metadata.identityEncoding === QUALIFIED_IDENTITY_ENCODING &&
          typeof value.namespace === "string" &&
          typeof value.name === "string" &&
          value.identity !== qualifiedIdentity(value.namespace, value.name)
        ) {
          add(
            diagnostics,
            "SNAPSHOT_RELATION_IDENTITY",
            `Relation identity does not match its namespace and name: ${value.identity}.`,
            `relations.${key}.identity`,
          );
        }
        if (relationIdentities.has(value.identity))
          add(
            diagnostics,
            "SNAPSHOT_DUPLICATE_IDENTITY",
            `Duplicate relation identity: ${value.identity}.`,
            `relations.${key}.identity`,
          );
        relationIdentities.add(value.identity);
      }
    }
  if (isRecord(snapshot.routines))
    for (const [key, value] of Object.entries(snapshot.routines)) {
      if (!Array.isArray(value)) {
        add(diagnostics, "SNAPSHOT_ROUTINES", "Routine entry must be an array.", `routines.${key}`);
        continue;
      }
      const routineIdentities = new Set<string>();
      value.forEach((routine, index) => {
        validateRoutine(routine, `routines.${key}[${index}]`, diagnostics);
        if (isRecord(routine) && typeof routine.identity === "string") {
          validateMarkedIdentity(routine.identity, `routines.${key}[${index}].identity`, marked, diagnostics);
          if (routineIdentities.has(routine.identity))
            add(
              diagnostics,
              "SNAPSHOT_DUPLICATE_IDENTITY",
              `Duplicate routine identity: ${routine.identity}.`,
              `routines.${key}[${index}].identity`,
            );
          routineIdentities.add(routine.identity);
        }
      });
    }
  if (diagnostics.length) throw new SnapshotValidationError(diagnostics);
}

export function canonicalizeSnapshot(snapshot: MetadataSnapshot): string {
  validateSnapshot(snapshot);
  return canonicalValue(normalizeSnapshot(snapshot, false));
}

export function hashSnapshot(snapshot: MetadataSnapshot): string {
  return createHash("sha256").update(canonicalizeSnapshot(snapshot)).digest("hex");
}

export function snapshotIdentity(snapshot: MetadataSnapshot): {
  readonly hash: string;
  readonly formatVersion: number;
  readonly dialect: string;
  readonly dialectVersion: string;
} {
  validateSnapshot(snapshot);
  return {
    hash: hashSnapshot(snapshot),
    formatVersion: snapshot.formatVersion,
    dialect: snapshot.dialect,
    dialectVersion: snapshot.dialectVersion,
  };
}

export function parseSnapshotJson(text: string): MetadataSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SnapshotValidationError([
      { code: "SNAPSHOT_JSON", message: error instanceof Error ? error.message : String(error) },
    ]);
  }
  validateSnapshot(value);
  return value;
}

function collectDrift(before: unknown, after: unknown, path: string, output: SnapshotDrift[]): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1)
      collectDrift(before[index], after[index], `${path}[${index}]`, output);
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort(compareKeys))
      collectDrift(before[key], after[key], path ? `${path}.${key}` : key, output);
    return;
  }
  output.push({ path, before, after });
}

export function diffSnapshots(before: MetadataSnapshot, after: MetadataSnapshot): readonly SnapshotDrift[] {
  validateSnapshot(before);
  validateSnapshot(after);
  const output: SnapshotDrift[] = [];
  collectDrift(
    JSON.parse(canonicalValue(normalizeSnapshot(before, false))),
    JSON.parse(canonicalValue(normalizeSnapshot(after, false))),
    "",
    output,
  );
  return output;
}
