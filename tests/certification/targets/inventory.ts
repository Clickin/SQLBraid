export const CERTIFICATION_TARGET_INVENTORY = [
  { id: "postgres-pg-node-16-4", class: "adapter" },
  { id: "postgres-current", class: "adapter" },
  { id: "postgres-pg-deno-2-9-3", class: "portability" },
  { id: "mysql-mysql2-node-8-4-2", class: "adapter" },
  { id: "mysql-mysql2-deno-2-9-3", class: "portability" },
  { id: "mariadb-connector-node-11-8-9", class: "adapter" },
  { id: "oracle-oracledb-thin-node-23-9", class: "adapter" },
  { id: "mssql-tedious-developer-node-2022-cu18", class: "adapter" },
  { id: "sqlite-node-sqlite-node-22-18-0", class: "adapter" },
  { id: "sqlite-node-sqlite-deno-2-9-3", class: "portability" },
  { id: "better-sqlite3-node-22-18-0", class: "adapter" },
  { id: "libsql-local-node-22-18-0", class: "adapter" },
  { id: "bun-sql-postgres", class: "portability" },
  { id: "bun-sql-mysql", class: "portability" },
  { id: "bun-sql-mariadb", class: "portability" },
  { id: "bun-sql-sqlite", class: "adapter" },
  { id: "d1-cloudflare-workerd-2026-07-30", class: "portability" },
  { id: "sqlite-wasm-browser-3-53-4", class: "portability" },
] as const;

/**
 * Every support/targets descriptor is a required certification target. Bun
 * SQLite remains explicit: it is a distinct @sqlbraid/bun-sql adapter, not a
 * host-only alias. Portability targets are not excluded; their host/runtime
 * tuple is part of the evidence and receives its own artifact.
 */
export const REQUIRED_CERTIFICATION_TARGETS = CERTIFICATION_TARGET_INVENTORY.map(({ id }) => id);
