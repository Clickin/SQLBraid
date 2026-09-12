import type { ColumnSnapshot, MetadataInspector, MetadataSnapshot, RelationSnapshot } from "@sqlbraid/metadata";
import type { SqliteDatabaseLike } from "./node-sqlite.js";

interface SqliteRow {
  readonly [key: string]: unknown;
}

function row(value: unknown): SqliteRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SQLITE_INSPECT_ROW: native metadata row is not an object.");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : typeof value === "bigint" ? Number(value) : undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function all(database: SqliteDatabaseLike, sql: string): readonly SqliteRow[] {
  return database.prepare(sql).all().map(row);
}

function rowidIdentityColumn(database: SqliteDatabaseLike, table: string, sql: string, info: readonly SqliteRow[], withoutRowid: boolean): string | undefined {
  if (withoutRowid || /\bPRIMARY\s+KEY\s+DESC\b/iu.test(sql)) return undefined;
  const primary = info.filter((entry) => (integer(entry.pk) ?? 0) !== 0);
  if (primary.length !== 1 || integer(primary[0]?.pk) !== 1 || text(primary[0]?.type)?.toUpperCase() !== "INTEGER") return undefined;
  // A primary-key autoindex proves this is not the special rowid alias (including DESC).
  const indexes = all(database, `PRAGMA index_list(${quoteIdentifier(table)})`);
  if (indexes.some((entry) => text(entry.origin) === undefined)) return undefined;
  if (indexes.some((entry) => text(entry.origin)?.toLowerCase() === "pk")) return undefined;
  return text(primary[0]?.name);
}

export function createSqliteInspector(database: SqliteDatabaseLike): MetadataInspector {
  return {
    dialect: "sqlite",
    async inspect(): Promise<MetadataSnapshot> {
      const versionRow = all(database, "SELECT sqlite_version() AS version")[0];
      const version = text(versionRow?.version) ?? "unknown";
      const namespaces = Object.fromEntries(all(database, "PRAGMA database_list").map((entry) => {
        const name = text(entry.name) ?? "unknown";
        return [name, { name, kind: "attached" as const, catalog: text(entry.file) }];
      }));
      const relations: Record<string, RelationSnapshot> = {};
      const objects = all(database, "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name");
      for (const object of objects) {
        const name = text(object.name);
        if (!name) continue;
        const sql = text(object.sql) ?? "";
        const strict = /\bSTRICT\s*$/iu.test(sql);
        const withoutRowid = /\bWITHOUT\s+ROWID\b/iu.test(sql);
        const columns: ColumnSnapshot[] = [];
        const info = all(database, `PRAGMA table_xinfo(${quoteIdentifier(name)})`);
        const identityColumn = object.type === "table" ? rowidIdentityColumn(database, name, sql, info, withoutRowid) : undefined;
        for (const entry of info) {
          const columnName = text(entry.name);
          const ordinal = integer(entry.cid);
          if (!columnName || ordinal === undefined) continue;
          const declaredType = text(entry.type) ?? "ANY";
          const hidden = integer(entry.hidden);
          const generated = hidden === undefined ? undefined : hidden === 2 || hidden === 3;
          columns.push({
            name: columnName,
            ordinal,
            type: declaredType || "ANY",
            nullable: identityColumn === columnName ? false : integer(entry.notnull) !== 1,
            ...(text(entry.dflt_value) ? { defaultExpression: text(entry.dflt_value) } : {}),
            ...(generated === undefined ? {} : { generated }),
            ...(generated === true ? { insertable: false, updatable: false } : {}),
            ...(identityColumn === columnName ? { identity: true } : {}),
          });
        }
        const identity = `main.${name}`;
        relations[identity] = { identity, name, namespace: "main", kind: object.type === "view" ? "view" : "table", columns, withoutRowid, strict };
      }
      let compileOptions: readonly string[] = [];
      try { compileOptions = all(database, "PRAGMA compile_options").flatMap((entry) => { const option = text(entry.compile_options); return option ? [option] : []; }); } catch { /* optional metadata */ }
      return { format: "sqlbraid-metadata", formatVersion: 1, dialect: "sqlite", dialectVersion: version, server: { product: "sqlite", version, capabilities: { compileOptions } }, namespaces, types: {}, relations, routines: {}, metadata: { source: "sqlite inspector", introspectionScope: "main", completeness: "complete" } };
    },
  };
}
