import type { TransactionIsolation, TransactionOptions } from "@sqlbraid/core";
import { invalidTransactionOptions } from "./errors.js";

function postgresIsolationLevel(isolation: TransactionIsolation): string {
  switch (isolation) {
    case "read-uncommitted":
      return "READ UNCOMMITTED";
    case "read-committed":
      return "READ COMMITTED";
    case "repeatable-read":
      return "REPEATABLE READ";
    case "serializable":
      return "SERIALIZABLE";
    default:
      throw invalidTransactionOptions(`Unsupported PostgreSQL transaction isolation level: ${String(isolation)}.`);
  }
}

export function postgresBeginSql(options: TransactionOptions | undefined): string {
  if (options === undefined) return "BEGIN";
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidTransactionOptions("PostgreSQL transaction options must be an object.");
  }
  const unexpected = Object.keys(options).find((key) => key !== "isolation" && key !== "readOnly");
  if (unexpected !== undefined)
    throw invalidTransactionOptions(`Unknown PostgreSQL transaction option: ${unexpected}.`);
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") {
    throw invalidTransactionOptions("PostgreSQL transaction readOnly must be a boolean.");
  }
  const clauses: string[] = [];
  if (options.isolation !== undefined) clauses.push(`ISOLATION LEVEL ${postgresIsolationLevel(options.isolation)}`);
  if (options.readOnly === true) clauses.push("READ ONLY");
  else if (options.readOnly === false) clauses.push("READ WRITE");
  return clauses.length === 0 ? "BEGIN" : `BEGIN ${clauses.join(" ")}`;
}

export function resolveStreamBatchSize(value: number | undefined): number {
  const size = value ?? 100;
  if (!Number.isSafeInteger(size) || size < 1)
    throw new RangeError("PostgreSQL streamBatchSize must be a positive safe integer.");
  return size;
}
