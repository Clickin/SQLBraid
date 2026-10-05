import type { MigrationErrorCode, MigrationReport } from "./types.js";

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "MigrationError";
  }
}

export class MigrationStartupError extends MigrationError {
  constructor(readonly report: MigrationReport) {
    super(reportCode(report), report.summary);
    this.name = "MigrationStartupError";
  }
}

function reportCode(report: MigrationReport): MigrationErrorCode {
  if (report.status === "uninitialized") return "BRAID_MIGRATE_UNINITIALIZED";
  if (report.history.some((row) => row.status === "failed")) return "BRAID_MIGRATE_DIRTY";
  if (report.history.some((row) => row.status === "running")) return "BRAID_MIGRATE_BUSY";
  if (report.differences.some((difference) => difference.kind === "checksum-mismatch")) return "BRAID_MIGRATE_CHECKSUM";
  if (
    report.differences.some((difference) => difference.kind === "missing-source" || difference.kind === "out-of-order")
  ) {
    return "BRAID_MIGRATE_ORDER";
  }
  if (report.differences.some((difference) => difference.kind === "schema-drift")) return "BRAID_MIGRATE_SCHEMA_DRIFT";
  if (
    report.differences.some((difference) => difference.kind === "pending" || difference.kind === "repeatable-changed")
  ) {
    return "BRAID_MIGRATE_PENDING";
  }
  return "BRAID_MIGRATE_AHEAD";
}
