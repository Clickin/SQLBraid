export const historySql = (table: string): string => `CREATE TABLE IF NOT EXISTS ${table} (
  \`scope\` VARCHAR(64) NOT NULL,
  \`installed_rank\` INTEGER NOT NULL,
  \`version\` VARCHAR(50),
  \`kind\` VARCHAR(16) NOT NULL,
  \`description\` VARCHAR(200) NOT NULL,
  \`source\` VARCHAR(1000) NOT NULL,
  \`dialect\` VARCHAR(32) NOT NULL,
  \`checksum\` VARCHAR(64) NOT NULL,
  \`status\` VARCHAR(16) NOT NULL,
  \`execution_id\` VARCHAR(36) NOT NULL,
  \`applied_by\` VARCHAR(128) NOT NULL,
  \`started_at\` VARCHAR(32) NOT NULL,
  \`duration_ms\` INTEGER,
  \`schema_hash\` VARCHAR(64),
  PRIMARY KEY (\`scope\`, \`installed_rank\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
