import { createHash } from "node:crypto";
import { lexSql, type SqlToken } from "@sqlbraid/ast";
import { SQL_FRAGMENT, type Query, type QueryRow, type TemplateIr, type TemplateNode } from "@sqlbraid/core";

export type StatementOperation = "read" | "write" | "transaction" | "session" | "unknown";

export interface QuerySemantics {
  readonly operation: StatementOperation;
  readonly readOnly: boolean;
  readonly locking: boolean;
  readonly sessionAffine: boolean;
  readonly reason: string;
}

export interface QueryManifest {
  readonly fingerprint: string;
  readonly templateFamilyFingerprint: string;
  readonly variantFingerprint?: string;
  readonly operation: StatementOperation;
  readonly readOnly: boolean;
  readonly locking: boolean;
  readonly sessionAffine: boolean;
  readonly reason: string;
  readonly resultKind?: "rows" | "command" | "call" | "unknown";
  readonly source?: string;
  readonly resultType?: string;
}

export interface QueryManifestEvidence {
  readonly fingerprint: string;
  readonly templateFamilyFingerprint: string;
  readonly variantFingerprint?: string;
  readonly operation: StatementOperation;
  readonly readOnly?: boolean;
  readonly locking?: boolean;
  readonly sessionAffine?: boolean;
  readonly reason?: string;
  readonly resultKind?: "rows" | "command" | "call" | "unknown";
  readonly source?: string;
  readonly resultType?: string;
}

export interface StandardSchemaSuccess<T> {
  readonly value: T;
  readonly issues?: undefined;
}

export interface StandardSchemaFailure {
  readonly issues: readonly unknown[];
  readonly value?: undefined;
}

export interface StandardSchemaLike<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: unknown; readonly output: T };
    validate(value: unknown): StandardSchemaSuccess<T> | StandardSchemaFailure | Promise<StandardSchemaSuccess<T> | StandardSchemaFailure>;
  };
}

export class ResultValidationError extends Error {
  readonly issues: readonly unknown[];

  constructor(issues: readonly unknown[]) {
    super("Database result validation failed.");
    this.name = "ResultValidationError";
    this.issues = issues;
  }
}

interface FragmentLike {
  readonly [SQL_FRAGMENT]: true;
  readonly ir: TemplateIr;
  readonly values: readonly unknown[];
  readonly dialectId: string;
}

function isFragmentLike(value: unknown): value is FragmentLike {
  if (!value || typeof value !== "object") return false;
  if (!(SQL_FRAGMENT in value) || !("ir" in value) || !("dialectId" in value)) return false;
  if (!("values" in value)) return false;
  const marker = value[SQL_FRAGMENT];
  const ir = value.ir;
  const values = value.values;
  const dialectId = value.dialectId;
  return marker === true && Boolean(ir && typeof ir === "object") && Array.isArray(values) && typeof dialectId === "string";
}

function canonicalNode(node: TemplateNode, values: readonly unknown[]): string {
  if (node.kind === "text") return `text:${JSON.stringify(node.text)}`;
  if (node.kind === "bind") {
    const value = values[node.interpolation];
    return isFragmentLike(value) ? `structural:${canonicalIr(value.ir, value.values)}` : `bind:${node.interpolation}`;
  }
  if (node.kind === "fragment") return `fragment:${valueFragment(node.fragment)}`;
  if (node.kind === "identifier") return `identifier:${JSON.stringify(node.value)}`;
  if (node.kind === "raw") return `raw:${JSON.stringify(node.text)}`;
  if (node.kind === "list") return `list:${node.values.length}`;
  if (node.kind === "if") return `if:${node.condition}[${node.children.map((child) => canonicalNode(child, values)).join(",")}]`;
  if (node.kind === "choose") return `choose:${node.whens.map((when) => `${when.condition}[${when.children.map((child) => canonicalNode(child, values)).join(",")}]`).join("|")}|${node.otherwise?.map((child) => canonicalNode(child, values)).join(",") ?? ""}`;
  return `trim:${JSON.stringify(node.attributes)}[${node.children.map((child) => canonicalNode(child, values)).join(",")}]`;
}

function canonicalIr(ir: TemplateIr, values: readonly unknown[] = []): string {
  return `ir:${ir.version}:${ir.nodes.map((node) => canonicalNode(node, values)).join(";")}`;
}

function valueFragment(fragment: FragmentLike): string {
  return `${fragment.dialectId}:${canonicalIr(fragment.ir, fragment.values)}`;
}

export function templateFamilyFingerprint(query: Query): string {
  return createHash("sha256").update(canonicalIr(query.ir)).digest("hex");
}

export function templateFamilyFingerprintOf(ir: TemplateIr): string {
  return createHash("sha256").update(canonicalIr(ir)).digest("hex");
}

export function fingerprintQuery(query: Query): string {
  return createHash("sha256").update(canonicalIr(query.ir, query.values)).digest("hex");
}

export function fingerprintTemplate(ir: TemplateIr, values: readonly unknown[]): string {
  return createHash("sha256").update(canonicalIr(ir, values)).digest("hex");
}

function significant(tokens: readonly SqlToken[]): readonly SqlToken[] {
  return tokens.filter((token) => token.kind !== "comment" && token.kind !== "eof");
}

function unknownSemantics(reason: string): QuerySemantics {
  return { operation: "unknown", readOnly: false, locking: true, sessionAffine: true, reason };
}

function portableSource(source: string | undefined): string | undefined {
  if (!source || source.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(source)) return undefined;
  return source;
}

function tokenNames(tokens: readonly SqlToken[]): readonly string[] {
  return tokens.map((token) => token.text.toUpperCase());
}

export function classifySemantics(sqlText: string): QuerySemantics {
  let tokens: readonly SqlToken[];
  try { tokens = significant(lexSql(sqlText)); }
  catch { return unknownSemantics("SQL could not be lexed safely"); }
  const first = tokens[0]?.text.toUpperCase();
  if (!first) return unknownSemantics("empty statement");
  const names = tokenNames(tokens);
  if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"].includes(first)) return { operation: "transaction", readOnly: false, locking: true, sessionAffine: true, reason: "transaction control" };
  if (["SET", "RESET", "USE"].includes(first)) return { operation: "session", readOnly: false, locking: false, sessionAffine: true, reason: "session state" };
  if (first === "PRAGMA") {
    const assignment = names.includes("=") || names.includes(":=");
    return assignment ? { operation: "session", readOnly: false, locking: false, sessionAffine: true, reason: "PRAGMA changes session state" } : { operation: "read", readOnly: true, locking: false, sessionAffine: false, reason: "read-only PRAGMA query" };
  }
  if (first === "EXPLAIN") return unknownSemantics(names.includes("ANALYZE") ? "EXPLAIN ANALYZE executes the statement" : "planning effects are not proven absent");
  if (first === "SELECT" || first === "VALUES" || first === "SHOW" || first === "DESCRIBE") {
    const suspicious = ["NEXTVAL", "SETVAL", "CURRVAL", "LASTVAL", "PG_ADVISORY_LOCK", "PG_ADVISORY_XACT_LOCK", "PG_TRY_ADVISORY_LOCK", "SET_CONFIG"];
    if (suspicious.some((name) => names.includes(name))) return unknownSemantics("routine or session effects are not proven absent");
    if (names.includes("FOR")) return unknownSemantics("locking clause requires a pinned session");
    return { operation: "read", readOnly: true, locking: false, sessionAffine: false, reason: "static read statement" };
  }
  if (["INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE", "CALL"].includes(first)) return { operation: "write", readOnly: false, locking: true, sessionAffine: false, reason: "write or routine statement" };
  return unknownSemantics(`unproven statement kind: ${first}`);
}

export function createManifest(query: Query, options: { readonly source?: string; readonly resultType?: string } = {}): QueryManifest {
  const rendered = query.render();
  const semantics = classifySemantics(rendered.text);
  return {
    fingerprint: fingerprintQuery(query),
    templateFamilyFingerprint: templateFamilyFingerprint(query),
    ...(rendered.variantFingerprint ? { variantFingerprint: rendered.variantFingerprint } : {}),
    operation: semantics.operation,
    readOnly: semantics.readOnly,
    locking: semantics.locking,
    sessionAffine: semantics.sessionAffine,
    reason: semantics.reason,
    ...(rendered.resultKind ? { resultKind: rendered.resultKind } : {}),
    ...(portableSource(options.source) ? { source: portableSource(options.source) } : {}),
    ...(options.resultType ? { resultType: options.resultType } : {}),
  };
}

export function createManifestFromEvidence(evidence: QueryManifestEvidence): QueryManifest {
  return { readOnly: false, locking: true, sessionAffine: true, reason: "manifest supplied without semantic evidence", ...evidence, ...(portableSource(evidence.source) ? { source: portableSource(evidence.source) } : { source: undefined }) };
}

export async function validateRows<Q extends Query>(query: Q, rows: readonly QueryRow<Q>[], schema: StandardSchemaLike<QueryRow<Q>>): Promise<readonly QueryRow<Q>[]> {
  const validated: QueryRow<Q>[] = [];
  for (const row of rows) {
    const result = await schema["~standard"].validate(row);
    if (result.issues !== undefined) throw new ResultValidationError(result.issues);
    validated.push(result.value);
  }
  return validated;
}
