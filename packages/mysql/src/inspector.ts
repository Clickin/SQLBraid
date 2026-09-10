import type { RelationSnapshot, RoutineSnapshot, SchemaInspector, SchemaSnapshot, TypeSnapshot } from "@sqlbraid/schema";
import type { Mysql2ConnectionLike } from "./mysql2.js";

interface Row {
  readonly [key: string]: unknown;
}

function objectRow(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MYSQL_INSPECT_ROW: metadata row is not an object.");
  return Object.fromEntries(Object.entries(value));
}

function text(row: Row | undefined, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === "string" ? value : undefined;
}

function integer(row: Row | undefined, key: string): number | undefined {
  const value = row?.[key];
  return typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : undefined;
}

function tsType(dataType: string): string | undefined {
  const normalized = dataType.toLowerCase();
  if (["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "float", "double", "decimal"].includes(normalized)) return normalized === "bigint" ? "string" : normalized === "decimal" ? "string" : "number";
  if (["char", "varchar", "text", "tinytext", "mediumtext", "longtext", "enum", "set", "date", "datetime", "timestamp", "time", "year", "json"].includes(normalized)) return normalized === "json" ? "unknown" : "string";
  if (["binary", "varbinary", "blob", "tinyblob", "mediumblob", "longblob"].includes(normalized)) return "Uint8Array";
  return undefined;
}

async function rows(connection: Mysql2ConnectionLike, sql: string): Promise<readonly Row[]> {
  const [payload] = await connection.execute(sql, []);
  if (!Array.isArray(payload)) throw new Error("MYSQL_INSPECT_RESULT: metadata query did not return rows.");
  return payload.map(objectRow);
}

export function createMysqlInspector(connection: Mysql2ConnectionLike): SchemaInspector {
  return {
    dialect: "mysql",
    async inspect(): Promise<SchemaSnapshot> {
      const server = (await rows(connection, "SELECT @@version AS version, @@version_comment AS product, @@sql_mode AS sqlMode, @@character_set_connection AS charset, @@collation_connection AS collation"))[0];
      const version = text(server, "version") ?? "unknown";
      const product = text(server, "product") ?? "mysql";
      if (/mariadb/iu.test(`${version} ${product}`)) throw new Error("MYSQL_PRODUCT_UNSUPPORTED: MariaDB requires a separate dialect profile.");
      const databaseRows = await rows(connection, "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name");
      const namespaces = Object.fromEntries(databaseRows.flatMap((entry) => { const name = text(entry, "schema_name"); return name ? [[name, { name, kind: "database" as const }]] : []; }));
      const tableRows = await rows(connection, "SELECT table_schema, table_name, table_type FROM information_schema.tables ORDER BY table_schema, table_name");
      const columnRows = await rows(connection, "SELECT table_schema, table_name, ordinal_position, column_name, data_type, is_nullable, column_default, extra, column_key, generation_expression, character_set_name, collation_name FROM information_schema.columns ORDER BY table_schema, table_name, ordinal_position");
      const relations: Record<string, RelationSnapshot> = {};
      const types: Record<string, TypeSnapshot> = {};
      for (const table of tableRows) {
        const schema = text(table, "table_schema");
        const name = text(table, "table_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${name}`;
        const columns = columnRows.filter((column) => text(column, "table_schema") === schema && text(column, "table_name") === name).map((column) => {
          const dataType = text(column, "data_type") ?? "unknown";
          const generated = Boolean(text(column, "generation_expression"));
          return { name: text(column, "column_name") ?? "unknown", ordinal: Math.max(0, (integer(column, "ordinal_position") ?? 1) - 1), type: dataType, ...(tsType(dataType) ? { tsType: tsType(dataType) } : {}), nullable: text(column, "is_nullable") === "YES", ...(text(column, "column_default") ? { defaultExpression: text(column, "column_default") } : {}), generated, identity: text(column, "column_key") === "PRI", insertable: !generated, updatable: !generated, ...(text(column, "character_set_name") ? { charset: text(column, "character_set_name") } : {}), ...(text(column, "collation_name") ? { collation: text(column, "collation_name") } : {}) };
        });
        relations[identity] = { identity, name, namespace: schema, kind: text(table, "table_type") === "VIEW" ? "view" : "table", columns };
        for (const column of columns) {
          const typeIdentity = `${schema}.${column.type}`;
          if (!types[typeIdentity]) types[typeIdentity] = { identity: typeIdentity, name: column.type, kind: "scalar", ...(column.tsType ? { tsType: column.tsType } : {}) };
        }
      }
      const routineRows = await rows(connection, "SELECT routine_schema, routine_name, routine_type, data_type, dtd_identifier, is_deterministic, sql_data_access FROM information_schema.routines ORDER BY routine_schema, routine_name");
      const routines: Record<string, readonly RoutineSnapshot[]> = {};
      for (const entry of routineRows) {
        const schema = text(entry, "routine_schema");
        const name = text(entry, "routine_name");
        if (!schema || !name) continue;
        const resultType = text(entry, "data_type") ?? "unknown";
        const routine: RoutineSnapshot = { name, schema, identity: `${schema}.${name}:${text(entry, "dtd_identifier") ?? resultType}`, kind: text(entry, "routine_type") === "PROCEDURE" ? "procedure" : "function", arguments: [], result: text(entry, "routine_type") === "PROCEDURE" ? { kind: "void" } : { kind: "scalar", type: resultType, ...(tsType(resultType) ? { tsType: tsType(resultType) } : {}), nullable: true }, deterministic: text(entry, "is_deterministic") === "YES", dataAccess: text(entry, "sql_data_access") === "NO SQL" ? "none" : "unknown" };
        routines[name] = [...(routines[name] ?? []), routine];
      }
      const major = /^\d+(?:\.\d+)?/u.exec(version)?.[0];
      return { formatVersion: 1, dialect: "mysql", dialectVersion: version, server: { product, version, ...(major ? { majorVersion: Number(major.split(".")[0]) } : {}), capabilities: { sqlMode: text(server, "sqlMode") ?? "", charset: text(server, "charset") ?? "", collation: text(server, "collation") ?? "" } }, namespaces, types, relations, routines, metadata: { source: "mysql information_schema", introspectionScope: "all databases", completeness: "partial" } };
    },
  };
}
