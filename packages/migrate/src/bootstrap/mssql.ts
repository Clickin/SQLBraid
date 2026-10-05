export const historySql = (table: string): string => `CREATE TABLE ${table} (
  [scope] NVARCHAR(64) COLLATE Latin1_General_100_BIN2 NOT NULL,
  [installed_rank] INT NOT NULL,
  [version] NVARCHAR(50),
  [kind] NVARCHAR(16) NOT NULL,
  [description] NVARCHAR(200) NOT NULL,
  [source] NVARCHAR(1000) NOT NULL,
  [dialect] NVARCHAR(32) NOT NULL,
  [checksum] VARCHAR(64) NOT NULL,
  [status] VARCHAR(16) NOT NULL,
  [execution_id] VARCHAR(36) NOT NULL,
  [applied_by] NVARCHAR(128) NOT NULL,
  [started_at] VARCHAR(32) NOT NULL,
  [duration_ms] INT,
  [schema_hash] VARCHAR(64),
  PRIMARY KEY ([scope], [installed_rank])
)`;
