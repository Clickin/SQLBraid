import type { ColumnSnapshot, RelationSnapshot, SchemaInspector, SchemaSnapshot } from "@sqlbraid/schema";
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

function sqliteTypeToTs(type: string, strict: boolean): string | undefined {
  if (!strict) return undefined;
  const normalized = type.toUpperCase();
  if (/INT/u.test(normalized)) return "number";
  if (/(REAL|FLOA|DOUB)/u.test(normalized)) return "number";
  if (/(CHAR|CLOB|TEXT)/u.test(normalized)) return "string";
  if (normalized === "BLOB" || !normalized) return "Uint8Array";
  return undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function all(database: SqliteDatabaseLike, sql: string): readonly SqliteRow[] {
  return database.prepare(sql).all().map(row);
}

export function createSqliteInspector(database: SqliteDatabaseLike): SchemaInspector {
  return {
    dialect: "sqlite",
    async inspect(): Promise<SchemaSnapshot> {
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
        for (const entry of info) {
          const columnName = text(entry.name);
          const ordinal = integer(entry.cid);
          if (!columnName || ordinal === undefined) continue;
          const declaredType = text(entry.type) ?? "ANY";
          columns.push({ name: columnName, ordinal, type: declaredType || "ANY", ...(sqliteTypeToTs(declaredType, strict) ? { tsType: sqliteTypeToTs(declaredType, strict) } : {}), nullable: integer(entry.notnull) !== 1, ...(text(entry.dflt_value) ? { defaultExpression: text(entry.dflt_value) } : {}), generated: integer(entry.hidden) === 2 || integer(entry.hidden) === 3, identity: integer(entry.pk) !== 0, insertable: integer(entry.hidden) !== 2 && integer(entry.hidden) !== 3, updatable: integer(entry.hidden) !== 2 && integer(entry.hidden) !== 3 });
        }
        const identity = `main.${name}`;
        relations[identity] = { identity, name, namespace: "main", kind: object.type === "view" ? "view" : "table", columns, withoutRowid, strict };
      }
      let compileOptions: readonly string[] = [];
      try { compileOptions = all(database, "PRAGMA compile_options").flatMap((entry) => { const option = text(entry.compile_options); return option ? [option] : []; }); } catch { /* optional metadata */ }
      return { formatVersion: 1, dialect: "sqlite", dialectVersion: version, server: { product: "sqlite", version, capabilities: { compileOptions } }, namespaces, types: {}, relations, routines: {}, metadata: { source: "sqlite inspector", introspectionScope: "main", completeness: "complete" } };
    },
  };
}
