import { createHash } from "node:crypto";
import type { Query, QueryRow } from "../../core/src/index.js";

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
  readonly variantFingerprint?: string;
  readonly operation: StatementOperation;
  readonly source?: string;
  readonly resultType?: string;
}

export interface StandardSchemaLike<T> {
  readonly "~standard": {
    validate(value: unknown): T | Promise<T> | { readonly issues: readonly unknown[] } | Promise<{ readonly issues: readonly unknown[] }>;
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

function canonicalQuery(query: Query): string {
  return JSON.stringify(query.ir, (_key, value) => value === undefined ? undefined : value);
}

export function fingerprintQuery(query: Query): string {
  return createHash("sha256").update(canonicalQuery(query)).digest("hex");
}

export function classifySemantics(sqlText: string): QuerySemantics {
  const normalized = sqlText.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim().toUpperCase();
  if (/^(SELECT|VALUES|SHOW|DESCRIBE|EXPLAIN|PRAGMA)\b/.test(normalized)) return { operation: "read", readOnly: true, locking: /\bFOR\s+(UPDATE|SHARE)\b/.test(normalized), sessionAffine: false, reason: "read statement" };
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(normalized)) return { operation: "transaction", readOnly: false, locking: true, sessionAffine: true, reason: "transaction control" };
  if (/^(SET|RESET|USE|PRAGMA)\b/.test(normalized)) return { operation: "session", readOnly: false, locking: false, sessionAffine: true, reason: "session state" };
  if (/^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL)\b/.test(normalized)) return { operation: "write", readOnly: false, locking: true, sessionAffine: false, reason: "write or routine statement" };
  return { operation: "unknown", readOnly: false, locking: true, sessionAffine: true, reason: "unproven statement" };
}

export function createManifest(query: Query, options: { readonly source?: string; readonly resultType?: string } = {}): QueryManifest {
  const rendered = query.render();
  const semantics = classifySemantics(rendered.text);
  return { fingerprint: fingerprintQuery(query), variantFingerprint: rendered.variantFingerprint, operation: semantics.operation, ...(options.source ? { source: options.source } : {}), ...(options.resultType ? { resultType: options.resultType } : {}) };
}

export async function validateRows<Q extends Query>(query: Q, rows: readonly QueryRow<Q>[], schema: StandardSchemaLike<QueryRow<Q>>): Promise<readonly QueryRow<Q>[]> {
  const validated: QueryRow<Q>[] = [];
  for (const row of rows) {
    const result = await schema["~standard"].validate(row);
    if (result && typeof result === "object" && "issues" in result) throw new ResultValidationError(result.issues);
    validated.push(result as QueryRow<Q>);
  }
  return validated;
}
