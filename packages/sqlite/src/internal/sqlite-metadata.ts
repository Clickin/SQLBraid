export interface SqliteMetadataStatementLike {
  all(...values: readonly unknown[]): readonly unknown[];
}

export interface SqliteMetadataDatabaseLike {
  prepare(sql: string): SqliteMetadataStatementLike;
}

export interface SqliteMetadataRow {
  readonly [key: string]: unknown;
}

export function sqliteMetadataRow(value: unknown): SqliteMetadataRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SQLITE_INSPECT_ROW: native metadata row is not an object.");
  }
  return Object.fromEntries(Object.entries(value));
}

export function sqliteMetadataText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function sqliteMetadataInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "bigint"
      ? Number(value)
      : undefined;
}

export function quoteSqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function readSqliteMetadataRows(
  database: SqliteMetadataDatabaseLike,
  sql: string,
): readonly SqliteMetadataRow[] {
  return database.prepare(sql).all().map(sqliteMetadataRow);
}

export function findSqliteRowidIdentityColumn(
  database: SqliteMetadataDatabaseLike,
  table: string,
  info: readonly SqliteMetadataRow[],
  withoutRowid: boolean,
): string | undefined {
  if (withoutRowid) return undefined;
  const primary = info.filter((entry) => (sqliteMetadataInteger(entry.pk) ?? 0) !== 0);
  if (
    primary.length !== 1 ||
    sqliteMetadataInteger(primary[0]?.pk) !== 1 ||
    sqliteMetadataText(primary[0]?.type)?.toUpperCase() !== "INTEGER"
  )
    return undefined;

  // A primary-key autoindex proves this is not the special rowid alias (including DESC).
  const indexes = readSqliteMetadataRows(database, `PRAGMA main.index_list(${quoteSqliteIdentifier(table)})`);
  if (indexes.some((entry) => sqliteMetadataText(entry.origin) === undefined)) return undefined;
  if (indexes.some((entry) => sqliteMetadataText(entry.origin)?.toLowerCase() === "pk")) return undefined;
  return sqliteMetadataText(primary[0]?.name);
}
