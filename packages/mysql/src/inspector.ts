import type { MetadataInspector, MetadataSnapshot, RelationSnapshot, RoutineSnapshot, TypeSnapshot } from "@sqlbraid/metadata";
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

async function rows(connection: Mysql2ConnectionLike, sql: string): Promise<readonly Row[]> {
  const [payload] = await connection.execute(sql, []);
  if (!Array.isArray(payload)) throw new Error("MYSQL_INSPECT_RESULT: metadata query did not return rows.");
  return payload.map(objectRow);
}

export function createMysqlInspector(connection: Mysql2ConnectionLike): MetadataInspector {
  return {
    dialect: "mysql",
    async inspect(): Promise<MetadataSnapshot> {
      const server = (await rows(connection, "SELECT @@version AS version, @@version_comment AS product, @@sql_mode AS sqlMode, @@character_set_connection AS charset, @@collation_connection AS collation"))[0];
      const version = text(server, "version") ?? "unknown";
      const product = text(server, "product") ?? "mysql";
      if (/mariadb/iu.test(`${version} ${product}`)) throw new Error("MYSQL_PRODUCT_UNSUPPORTED: MariaDB requires a separate dialect profile.");
      const databaseRows = await rows(connection, "SELECT SCHEMA_NAME AS schema_name FROM information_schema.schemata ORDER BY schema_name");
      const namespaces = Object.fromEntries(databaseRows.flatMap((entry) => { const name = text(entry, "schema_name"); return name ? [[name, { name, kind: "database" as const }]] : []; }));
      const tableRows = await rows(connection, "SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM information_schema.tables ORDER BY table_schema, table_name");
      const columnRows = await rows(connection, "SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, ORDINAL_POSITION AS ordinal_position, COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, EXTRA AS extra, COLUMN_KEY AS column_key, GENERATION_EXPRESSION AS generation_expression, CHARACTER_SET_NAME AS character_set_name, COLLATION_NAME AS collation_name FROM information_schema.columns ORDER BY table_schema, table_name, ordinal_position");
      const relations: Record<string, RelationSnapshot> = {};
      const types: Record<string, TypeSnapshot> = {};
      for (const table of tableRows) {
        const schema = text(table, "table_schema");
        const name = text(table, "table_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${name}`;
        const columns = columnRows.filter((column) => text(column, "table_schema") === schema && text(column, "table_name") === name).map((column) => {
          const dataType = text(column, "data_type") ?? "unknown";
          const extra = text(column, "extra");
          const generationExpression = text(column, "generation_expression");
          const generated = extra === undefined && generationExpression === undefined
            ? undefined
            : Boolean(generationExpression) || /(?:^|\s)(?:virtual|stored)\s+generated(?:\s|$)/iu.test(extra ?? "");
          const autoIncrement = /(?:^|\s)auto_increment(?:\s|$)/iu.test(extra ?? "");
          return {
            name: text(column, "column_name") ?? "unknown",
            ordinal: Math.max(0, (integer(column, "ordinal_position") ?? 1) - 1),
            type: dataType,
            nullable: text(column, "is_nullable") === "YES",
            ...(text(column, "column_default") ? { defaultExpression: text(column, "column_default") } : {}),
            ...(generated === undefined ? {} : { generated }),
            ...(generated === true ? { insertable: false, updatable: false, ...(generationExpression ? { generationExpression } : {}) } : {}),
            ...(autoIncrement ? { identity: true } : {}),
            ...(text(column, "character_set_name") ? { charset: text(column, "character_set_name") } : {}),
            ...(text(column, "collation_name") ? { collation: text(column, "collation_name") } : {}),
            ...(extra ? { extra } : {}),
            ...(text(column, "column_key") ? { key: text(column, "column_key") } : {}),
          };
        });
        relations[identity] = { identity, name, namespace: schema, kind: text(table, "table_type") === "VIEW" ? "view" : "table", columns };
        for (const column of columns) {
          const typeIdentity = `${schema}.${column.type}`;
          if (!types[typeIdentity]) types[typeIdentity] = { identity: typeIdentity, name: column.type, kind: "scalar" };
        }
      }
      const routineRows = await rows(connection, "SELECT ROUTINE_SCHEMA AS routine_schema, ROUTINE_NAME AS routine_name, ROUTINE_TYPE AS routine_type, DATA_TYPE AS data_type, DTD_IDENTIFIER AS dtd_identifier, IS_DETERMINISTIC AS is_deterministic, SQL_DATA_ACCESS AS sql_data_access FROM information_schema.routines ORDER BY routine_schema, routine_name");
      const routines: Record<string, readonly RoutineSnapshot[]> = {};
      for (const entry of routineRows) {
        const schema = text(entry, "routine_schema");
        const name = text(entry, "routine_name");
        if (!schema || !name) continue;
        const resultType = text(entry, "data_type") ?? "unknown";
        const routine: RoutineSnapshot = {
          name,
          schema,
          identity: `${schema}.${name}:${text(entry, "dtd_identifier") ?? resultType}`,
          kind: text(entry, "routine_type") === "PROCEDURE" ? "procedure" : "function",
          arguments: [],
          result: text(entry, "routine_type") === "PROCEDURE" ? { kind: "void" } : { kind: "scalar", type: resultType, nullable: true },
          deterministic: text(entry, "is_deterministic") === "YES",
          dataAccess: text(entry, "sql_data_access") === "NO SQL" ? "none" : "unknown",
        };
        routines[name] = [...(routines[name] ?? []), routine];
      }
      const major = /^\d+(?:\.\d+)?/u.exec(version)?.[0];
      return { format: "sqlbraid-metadata", formatVersion: 1, dialect: "mysql", dialectVersion: version, server: { product, version, ...(major ? { majorVersion: Number(major.split(".")[0]) } : {}), capabilities: { sqlMode: text(server, "sqlMode") ?? "", charset: text(server, "charset") ?? "", collation: text(server, "collation") ?? "" } }, namespaces, types, relations, routines, metadata: { source: "mysql information_schema", introspectionScope: "all databases", completeness: "partial" } };
    },
  };
}
