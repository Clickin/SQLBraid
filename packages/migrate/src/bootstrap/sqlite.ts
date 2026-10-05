export const historySql = (table: string): string => `CREATE TABLE IF NOT EXISTS ${table} (
  "scope" TEXT NOT NULL,
  "installed_rank" INTEGER NOT NULL,
  "version" TEXT,
  "kind" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "dialect" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "execution_id" TEXT NOT NULL,
  "applied_by" TEXT NOT NULL,
  "started_at" TEXT NOT NULL,
  "duration_ms" INTEGER,
  "schema_hash" TEXT,
  PRIMARY KEY ("scope", "installed_rank")
)`;
