export const historySql = (table: string): string => `CREATE TABLE ${table} (
  "scope" VARCHAR2(64 CHAR) NOT NULL,
  "installed_rank" NUMBER(10) NOT NULL,
  "version" VARCHAR2(50 CHAR),
  "kind" VARCHAR2(16 CHAR) NOT NULL,
  "description" VARCHAR2(200 CHAR) NOT NULL,
  "source" VARCHAR2(1000 CHAR) NOT NULL,
  "dialect" VARCHAR2(32 CHAR) NOT NULL,
  "checksum" VARCHAR2(64 CHAR) NOT NULL,
  "status" VARCHAR2(16 CHAR) NOT NULL,
  "execution_id" VARCHAR2(36 CHAR) NOT NULL,
  "applied_by" VARCHAR2(128 CHAR) NOT NULL,
  "started_at" VARCHAR2(32 CHAR) NOT NULL,
  "duration_ms" NUMBER(10),
  "schema_hash" VARCHAR2(64 CHAR),
  PRIMARY KEY ("scope", "installed_rank")
)`;
