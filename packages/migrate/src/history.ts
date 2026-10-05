import type { Database, Dialect } from "@sqlbraid/core";
import { createMigrationSql, historyTable, isMissingHistory } from "./dialect.js";
import { MigrationError } from "./errors.js";
import { compareVersions, normalizeVersion } from "./manifest.js";
import type { DialectManifest, MigrationDifference, MigrationHistoryRow, MigrationReport } from "./types.js";

const historyColumns = [
  "scope",
  "installed_rank",
  "version",
  "kind",
  "description",
  "source",
  "dialect",
  "checksum",
  "status",
  "execution_id",
  "applied_by",
  "started_at",
  "duration_ms",
  "schema_hash",
] as const;

type DriverHistoryRow = Omit<MigrationHistoryRow, "installed_rank" | "duration_ms"> & {
  readonly installed_rank: number | string;
  readonly duration_ms: number | string | null;
};

export function createHistoryStore(dialect: Dialect, scope: string, table: string, schema?: string) {
  const sql = createMigrationSql(dialect);
  const target = sql.raw(historyTable(dialect, table, schema));
  const columns = sql.join(
    historyColumns.map((name) => sql.ident(name)),
    sql.raw(", "),
  );
  const column = sql.ident;
  return {
    async read(db: Database): Promise<readonly MigrationHistoryRow[] | undefined> {
      let rows: readonly DriverHistoryRow[];
      try {
        rows = await db.all(sql.rows<DriverHistoryRow>`SELECT ${columns} FROM ${target}
          WHERE ${column("scope")} = ${scope} ORDER BY ${column("installed_rank")}`);
      } catch (error) {
        if (isMissingHistory(error, dialect)) return undefined;
        throw error;
      }
      return rows.map((row) => {
        const rank = Number(row.installed_rank);
        const duration = row.duration_ms === null ? null : Number(row.duration_ms);
        if (
          !Number.isSafeInteger(rank) ||
          rank < 1 ||
          (duration !== null && (!Number.isSafeInteger(duration) || duration < 0)) ||
          !["running", "success", "failed"].includes(row.status) ||
          !["versioned", "repeatable", "baseline"].includes(row.kind) ||
          row.scope !== scope ||
          row.dialect !== dialect.id
        ) {
          throw new MigrationError(
            "BRAID_MIGRATE_DIRTY",
            "Invalid migration history; inspect the history table before continuing.",
          );
        }
        if (row.kind !== "repeatable" && (typeof row.version !== "string" || !/^\d+(?:[._]\d+)*$/.test(row.version))) {
          throw new MigrationError("BRAID_MIGRATE_DIRTY", "Invalid migration version in history.");
        }
        return Object.assign({}, row, { installed_rank: rank, duration_ms: duration });
      });
    },
    async insert(db: Database, row: MigrationHistoryRow): Promise<void> {
      await db.execute(sql.command`INSERT INTO ${target} (${columns})
        VALUES (${sql.join(
          historyColumns.map((name) => (row[name] === null ? sql.raw("NULL") : sql.fragment`${row[name]}`)),
          sql.raw(", "),
        )})`);
    },
    async finish(
      db: Database,
      rank: number,
      executionId: string,
      status: "success" | "failed",
      durationMs: number,
    ): Promise<void> {
      await db.execute(sql.command`UPDATE ${target}
        SET ${column("status")} = ${status}, ${column("duration_ms")} = ${durationMs}
        WHERE ${column("scope")} = ${scope} AND ${column("installed_rank")} = ${rank}
          AND ${column("execution_id")} = ${executionId}`);
    },
    async schemaHash(db: Database, rank: number, executionId: string, hash: string): Promise<void> {
      await db.execute(sql.command`UPDATE ${target} SET ${column("schema_hash")} = ${hash}
        WHERE ${column("scope")} = ${scope} AND ${column("installed_rank")} = ${rank}
          AND ${column("execution_id")} = ${executionId} AND ${column("status")} = ${"success"}`);
    },
    async repair(db: Database): Promise<void> {
      await db.execute(sql.command`DELETE FROM ${target} WHERE ${column("scope")} = ${scope}
        AND (${column("status")} = ${"running"} OR ${column("status")} = ${"failed"})`);
    },
  };
}

export function compareHistory(
  manifest: DialectManifest,
  rows: readonly MigrationHistoryRow[] | undefined,
  scope: string,
  dialect: string,
): MigrationReport {
  const history = rows ?? [];
  const differences: MigrationDifference[] = [];
  const applied = new Map<string, MigrationHistoryRow>();
  const repeatable = new Map<string, MigrationHistoryRow>();
  let baseline: string | null = null;
  let head: string | null = null;
  for (const row of history) {
    if (row.status !== "success") continue;
    if (row.kind === "repeatable") {
      repeatable.set(row.source, row);
      continue;
    }
    if (row.version === null) continue;
    if (head === null || compareVersions(row.version, head) > 0) head = row.version;
    if (row.kind === "baseline") {
      if (baseline === null || compareVersions(row.version, baseline) > 0) baseline = row.version;
    } else {
      applied.set(normalizeVersion(row.version), row);
    }
  }
  const versions = new Map(manifest.versioned.map((entry) => [normalizeVersion(entry.version!), entry]));
  const lastVersion = manifest.versioned[manifest.versioned.length - 1]?.version ?? null;
  for (const row of applied.values()) {
    const entry = versions.get(normalizeVersion(row.version!));
    if (entry) {
      if (entry.checksum !== row.checksum) {
        differences.push({
          kind: "checksum-mismatch",
          version: row.version,
          source: entry.source,
          expected: entry.checksum,
          actual: row.checksum,
        });
      }
    } else {
      differences.push({
        kind: lastVersion === null || compareVersions(row.version!, lastVersion) > 0 ? "ahead" : "missing-source",
        version: row.version,
        source: row.source,
      });
    }
  }
  if (baseline !== null && (lastVersion === null || compareVersions(baseline, lastVersion) > 0)) {
    differences.push({ kind: "ahead", version: baseline });
  }
  for (const entry of manifest.versioned) {
    if (
      applied.has(normalizeVersion(entry.version!)) ||
      (baseline !== null && compareVersions(entry.version!, baseline) <= 0)
    )
      continue;
    differences.push({
      kind: head !== null && compareVersions(entry.version!, head) < 0 ? "out-of-order" : "pending",
      version: entry.version,
      source: entry.source,
    });
  }
  for (const entry of manifest.repeatable) {
    const previous = repeatable.get(entry.source);
    if (previous?.checksum !== entry.checksum) {
      differences.push({
        kind: "repeatable-changed",
        version: null,
        source: entry.source,
        expected: entry.checksum,
        ...(previous ? { actual: previous.checksum } : {}),
      });
    }
  }
  let status: MigrationReport["status"] = "current";
  if (rows === undefined) status = "uninitialized";
  else if (history.some((row) => row.status !== "success")) status = "incomplete";
  else if (
    differences.some((difference) => ["checksum-mismatch", "missing-source", "out-of-order"].includes(difference.kind))
  )
    status = "mismatch";
  else if (differences.some((difference) => difference.kind === "pending" || difference.kind === "repeatable-changed"))
    status = "pending";
  else if (differences.length > 0) status = "ahead";
  return {
    status,
    summary: `Migration scope ${scope} is ${status}${differences.length ? ` (${differences.length} differences)` : ""}.`,
    scope,
    dialect,
    manifestHash: manifest.hash,
    head,
    differences,
    history,
  };
}
