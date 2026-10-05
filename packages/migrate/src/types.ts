import type { Database, Dialect } from "@sqlbraid/core";

/** One SQL migration. `checksum` is the SHA-256 hex of the normalized `sql` text. */
export interface ManifestEntry {
  readonly version: string | null;
  readonly description: string;
  readonly source: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface DialectManifest {
  readonly hash: string;
  readonly versioned: readonly ManifestEntry[];
  readonly repeatable: readonly ManifestEntry[];
}

export interface MigrationManifest {
  readonly format: "sqlbraid-migrations";
  readonly formatVersion: 1;
  readonly dialects: Readonly<Record<string, DialectManifest>>;
}

export interface MigrationHistoryRow {
  readonly scope: string;
  readonly installed_rank: number;
  readonly version: string | null;
  readonly kind: "versioned" | "repeatable" | "baseline";
  readonly description: string;
  readonly source: string;
  readonly dialect: string;
  readonly checksum: string;
  readonly status: "running" | "success" | "failed";
  readonly execution_id: string;
  readonly applied_by: string;
  readonly started_at: string;
  readonly duration_ms: number | null;
  readonly schema_hash: string | null;
}

export type MigrationDifferenceKind =
  | "pending"
  | "ahead"
  | "checksum-mismatch"
  | "missing-source"
  | "out-of-order"
  | "repeatable-changed"
  | "schema-drift";

export interface MigrationDifference {
  readonly kind: MigrationDifferenceKind;
  readonly version?: string | null;
  readonly source?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly path?: string;
}

export interface MigrationReport {
  readonly status: "off" | "uninitialized" | "incomplete" | "current" | "pending" | "ahead" | "mismatch";
  readonly summary: string;
  readonly scope: string;
  readonly dialect: string;
  readonly manifestHash: string;
  readonly head: string | null;
  readonly differences: readonly MigrationDifference[];
  readonly history: readonly MigrationHistoryRow[];
}

export interface MigrationDrift {
  readonly dialect?: string;
  inspect(): Promise<{ readonly hash: string; readonly snapshot: unknown; readonly differences?: readonly string[] }>;
}

export type MigrationEvent =
  | { readonly type: "startup.check"; readonly report: MigrationReport }
  | { readonly type: "lock.acquire" | "lock.release"; readonly scope: string }
  | { readonly type: "migration.start"; readonly entry: ManifestEntry }
  | { readonly type: "migration.end"; readonly entry: ManifestEntry; readonly durationMs: number }
  | { readonly type: "migration.error"; readonly entry: ManifestEntry; readonly error: unknown };

export interface MigratorOptions {
  readonly manifest: MigrationManifest;
  readonly dialect: Dialect;
  readonly scope?: string;
  readonly table?: string;
  readonly schema?: string;
  readonly appliedBy?: string;
  readonly busyTimeoutMs?: number;
  readonly onEvent?: (event: MigrationEvent) => void;
  readonly drift?: MigrationDrift;
}

export interface StartupOptions {
  readonly mode?: "off" | "report" | "verify" | "apply";
  readonly ahead?: "allow" | "error";
  readonly schema?: "hash";
}

export interface OnceOptions extends StartupOptions {
  /** Failed checks become retryable after this interval; defaults to 1,000 ms. */
  readonly retryIntervalMs?: number;
}

export interface Migrator {
  startup(db: Database, options?: StartupOptions): Promise<MigrationReport>;
  once(db: Database, options?: OnceOptions): Promise<MigrationReport>;
  baseline(db: Database, version: string): Promise<MigrationReport>;
  repair(db: Database): Promise<MigrationReport>;
  /** Record the inspected schema hash on the latest successful history row. Requires the drift option. */
  acceptSchema(db: Database): Promise<MigrationReport>;
}

export type MigrationErrorCode =
  | "BRAID_MIGRATE_SOURCE"
  | "BRAID_MIGRATE_UNINITIALIZED"
  | "BRAID_MIGRATE_PENDING"
  | "BRAID_MIGRATE_AHEAD"
  | "BRAID_MIGRATE_CHECKSUM"
  | "BRAID_MIGRATE_ORDER"
  | "BRAID_MIGRATE_DIRTY"
  | "BRAID_MIGRATE_BUSY"
  | "BRAID_MIGRATE_SCHEMA_DRIFT";
