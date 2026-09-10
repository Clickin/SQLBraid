import type { SchemaInspector, SchemaSnapshot, RelationSnapshot, RoutineSnapshot, TypeSnapshot } from "@sqlbraid/schema";
import type { PgClientLike } from "./pg.js";

interface CatalogRow {
  readonly [key: string]: unknown;
}

function objectRow(value: unknown): CatalogRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PG_INSPECT_ROW: catalog row is not an object.");
  return Object.fromEntries(Object.entries(value));
}

function text(row: CatalogRow | undefined, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberValue(row: CatalogRow | undefined, key: string): number | undefined {
  const value = row?.[key];
  return typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : undefined;
}

function tsType(dataType: string): string | undefined {
  const normalized = dataType.toLowerCase();
  if (["smallint", "integer", "real", "double precision"].includes(normalized)) return "number";
  if (["bigint"].includes(normalized)) return "bigint";
  if (["boolean"].includes(normalized)) return "boolean";
  if (normalized.includes("char") || normalized === "text" || normalized === "uuid") return "string";
  return undefined;
}

async function rows(client: PgClientLike, text: string): Promise<readonly CatalogRow[]> {
  const result = await client.query({ text, values: [] });
  return result.rows.map(objectRow);
}

export function createPostgresInspector(client: PgClientLike): SchemaInspector {
  return {
    dialect: "postgres",
    async inspect(): Promise<SchemaSnapshot> {
      const versionRow = (await rows(client, "SELECT current_setting('server_version') AS version"))[0];
      const version = text(versionRow, "version") ?? "unknown";
      const tableRows = await rows(client, "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name");
      const columnRows = await rows(client, "SELECT table_schema, table_name, ordinal_position, column_name, data_type, udt_schema, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position");
      const relations: Record<string, RelationSnapshot> = {};
      for (const relation of tableRows) {
        const schema = text(relation, "table_schema");
        const name = text(relation, "table_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${name}`;
        const columns = columnRows.filter((column) => text(column, "table_schema") === schema && text(column, "table_name") === name).map((column) => {
          const dataType = text(column, "data_type") ?? "unknown";
          const ordinal = numberValue(column, "ordinal_position");
          return { name: text(column, "column_name") ?? "unknown", ordinal: ordinal === undefined ? 0 : Math.max(0, ordinal - 1), type: `${text(column, "udt_schema") ?? "pg_catalog"}.${text(column, "udt_name") ?? dataType}`, ...(tsType(dataType) ? { tsType: tsType(dataType) } : {}), nullable: text(column, "is_nullable") === "YES", ...(text(column, "column_default") ? { defaultExpression: text(column, "column_default") } : {}) };
        });
        relations[identity] = { identity, name, namespace: schema, kind: text(relation, "table_type") === "VIEW" ? "view" : "table", columns };
      }
      const routineRows = await rows(client, "SELECT routine_schema, routine_name, routine_type, data_type, specific_name FROM information_schema.routines WHERE routine_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY routine_schema, routine_name, specific_name");
      const routines: Record<string, readonly RoutineSnapshot[]> = {};
      for (const entry of routineRows) {
        const schema = text(entry, "routine_schema");
        const name = text(entry, "routine_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${text(entry, "specific_name") ?? name}`;
        const dataType = text(entry, "data_type") ?? "unknown";
        const routine: RoutineSnapshot = { name, schema, identity, kind: text(entry, "routine_type") === "PROCEDURE" ? "procedure" : "function", arguments: [], result: text(entry, "routine_type") === "PROCEDURE" ? { kind: "void" } : { kind: "scalar", type: dataType, ...(tsType(dataType) ? { tsType: tsType(dataType) } : {}), nullable: true } };
        routines[name] = [...(routines[name] ?? []), routine];
      }
      const types: Record<string, TypeSnapshot> = {};
      for (const column of columnRows) {
        const schema = text(column, "udt_schema");
        const name = text(column, "udt_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${name}`;
        if (!types[identity]) types[identity] = { identity, name, kind: "scalar", ...(tsType(text(column, "data_type") ?? "") ? { tsType: tsType(text(column, "data_type") ?? "") } : {}) };
      }
      const majorVersion = /^\d+/u.exec(version)?.[0];
      return { formatVersion: 1, dialect: "postgres", dialectVersion: version, server: { product: "postgres", version, ...(majorVersion ? { majorVersion: Number(majorVersion) } : {}) }, namespaces: {}, types, relations, routines, metadata: { source: "postgres information_schema", introspectionScope: "non-system schemas", completeness: "partial" } };
    },
  };
}
