import type { MetadataInspector, MetadataSnapshot, NamespaceSnapshot, RelationSnapshot, RoutineArgument, RoutineSnapshot, TypeSnapshot } from "@sqlbraid/metadata";

interface CatalogRow {
  readonly [key: string]: unknown;
}

interface OracleCatalogResultLike {
  readonly rows?: readonly unknown[];
  readonly metaData?: readonly { readonly name?: string }[];
}

export interface OracleInspectorConnectionLike {
  execute(sql: string, bindParams?: any, options?: any): Promise<unknown>;
}

function objectRow(value: unknown, fields: readonly { readonly name?: string }[] = []): CatalogRow {
  if (Array.isArray(value)) {
    const row: Record<string, unknown> = {};
    for (const [index, entry] of value.entries()) {
      const name = fields[index]?.name;
      if (name) row[name] = entry;
    }
    return row;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ORACLE_INSPECT_ROW: catalog row is not an object.");
  return Object.fromEntries(Object.entries(value));
}

function text(row: CatalogRow | undefined, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row?.[key] ?? row?.[key.toUpperCase()] ?? row?.[key.toLowerCase()];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function numberValue(row: CatalogRow | undefined, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row?.[key] ?? row?.[key.toUpperCase()] ?? row?.[key.toLowerCase()];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  }
  return undefined;
}

async function rows(connection: OracleInspectorConnectionLike, sql: string): Promise<readonly CatalogRow[]> {
  const value = await connection.execute(sql, []);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ORACLE_INSPECT_RESULT: metadata query returned a malformed result.");
  const result = value as OracleCatalogResultLike;
  if (!Array.isArray(result.rows)) throw new Error("ORACLE_INSPECT_RESULT: metadata query did not return rows.");
  const fields = Array.isArray(result.metaData) ? result.metaData : [];
  return result.rows.map((row) => objectRow(row, fields));
}

function typeEvidence(row: CatalogRow): { readonly identity: string; readonly name: string; readonly kind: TypeSnapshot["kind"] } | undefined {
  const domainOwner = text(row, "domain_owner");
  const domainName = text(row, "domain_name");
  if (domainOwner && domainName) return { identity: `${domainOwner}.${domainName}`, name: domainName, kind: "domain" };
  const owner = text(row, "data_type_owner", "type_owner");
  const raw = text(row, "data_type", "pls_type") ?? "UNKNOWN";
  const name = text(row, "data_type_name", "type_name")
    ?? (text(row, "data_type_owner") && !["OBJECT", "UNKNOWN"].includes(raw.trim().toUpperCase()) ? raw : undefined);
  if (owner && name) return { identity: `${owner}.${name}`, name, kind: "composite" };
  return undefined;
}

function dataType(row: CatalogRow): string {
  const evidence = typeEvidence(row);
  if (evidence) return evidence.identity;
  return (text(row, "data_type", "pls_type") ?? "UNKNOWN").toUpperCase();
}

function relationColumn(row: CatalogRow) {
  const type = dataType(row);
  const virtual = text(row, "virtual_column") === "YES";
  const identity = text(row, "identity_column") === "YES";
  const defaultExpression = text(row, "data_default");
  const ordinal = numberValue(row, "column_id");
  return {
    name: text(row, "column_name") ?? "UNKNOWN",
    ordinal: ordinal === undefined ? 0 : Math.max(0, ordinal - 1),
    type,
    nullable: text(row, "nullable") === "Y",
    ...(defaultExpression === undefined ? {} : { defaultExpression }),
    ...(virtual ? { generated: true, insertable: false, updatable: false } : {}),
    ...(identity ? { identity: true } : {}),
    ...(text(row, "char_used") ? { charSemantics: text(row, "char_used") } : {}),
  };
}

function routineParts(row: CatalogRow): { readonly owner: string; readonly object: string; readonly packageName?: string; readonly procedure: string; readonly overload: string } | undefined {
  const owner = text(row, "owner");
  const object = text(row, "object_name");
  const packageName = text(row, "package_name") ?? (text(row, "procedure_name") === undefined ? undefined : object);
  const procedure = text(row, "procedure_name") ?? (packageName ? undefined : object);
  if (!owner || !object || !procedure) return undefined;
  return { owner, object, packageName, procedure, overload: text(row, "overload") ?? "" };
}

function routineName(row: CatalogRow): { readonly name: string; readonly identity: string; readonly schema: string } | undefined {
  const parts = routineParts(row);
  if (!parts) return undefined;
  const base = parts.packageName ? `${parts.owner}.${parts.packageName}.${parts.procedure}` : `${parts.owner}.${parts.procedure}`;
  return { name: parts.procedure, identity: parts.overload ? `${base}#${parts.overload}` : base, schema: parts.owner };
}

function routineKey(row: CatalogRow, argument: boolean): string {
  const member = text(row, "procedure_name");
  const packageName = argument ? text(row, "package_name") : member === undefined ? undefined : text(row, "object_name");
  const name = argument ? text(row, "object_name") : member ?? text(row, "object_name");
  return JSON.stringify([text(row, "owner"), packageName, name, numberValue(row, "object_id"), numberValue(row, "subprogram_id"), text(row, "overload")]);
}

function argumentMode(value: string | undefined): RoutineArgument["mode"] {
  if (value === "OUT") return "out";
  if (value === "IN/OUT") return "inout";
  return "in";
}

export function createOracleInspector(connection: OracleInspectorConnectionLike): MetadataInspector {
  return {
    dialect: "oracle",
    async inspect(): Promise<MetadataSnapshot> {
      const versionRows = await rows(connection, "SELECT banner AS version FROM v$version WHERE banner LIKE 'Oracle Database%'");
      const versionBanner = text(versionRows[0], "version") ?? "unknown";
      const version = /\b\d+(?:\.\d+)*(?:[A-Za-z]+\d*)?\b/u.exec(versionBanner)?.[0] ?? versionBanner;
      const namespaceRows = await rows(connection, "SELECT username FROM all_users ORDER BY username");
      const namespaces: Record<string, NamespaceSnapshot> = {};
      for (const row of namespaceRows) {
        const name = text(row, "username");
        if (name) namespaces[name] = { name, kind: "schema" };
      }
      const relationRows = await rows(connection, "SELECT owner, table_name AS relation_name, 'TABLE' AS relation_kind FROM all_tables UNION ALL SELECT owner, view_name AS relation_name, 'VIEW' AS relation_kind FROM all_views ORDER BY owner, relation_name");
      const columnRows = await rows(connection, "SELECT owner, table_name, column_name, internal_column_id AS column_id, data_type, data_type_owner, nullable, data_default, identity_column, virtual_column, char_used, domain_owner, domain_name FROM all_tab_cols WHERE user_generated = 'YES' ORDER BY owner, table_name, internal_column_id");
      const columnsByRelation = Map.groupBy(columnRows, (column) => JSON.stringify([text(column, "owner"), text(column, "table_name")]));
      const relations: Record<string, RelationSnapshot> = {};
      for (const relation of relationRows) {
        const schema = text(relation, "owner");
        const name = text(relation, "relation_name", "table_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${name}`;
        relations[identity] = {
          identity,
          name,
          namespace: schema,
          kind: text(relation, "relation_kind") === "VIEW" ? "view" : "table",
          columns: (columnsByRelation.get(JSON.stringify([schema, name])) ?? []).map(relationColumn),
        };
      }
      const types: Record<string, TypeSnapshot> = {};
      for (const column of columnRows) {
        const evidence = typeEvidence(column);
        if (evidence && !types[evidence.identity]) types[evidence.identity] = evidence;
      }
      const procedureRows = await rows(connection, "SELECT owner, object_name, procedure_name, object_type, object_id, overload, subprogram_id FROM all_procedures WHERE object_type IN ('FUNCTION', 'PROCEDURE') OR procedure_name IS NOT NULL ORDER BY owner, object_name, procedure_name, overload, object_id");
      const argumentRows = await rows(connection, "SELECT owner, object_name, package_name, object_id, overload, subprogram_id, argument_name, position, sequence, in_out, data_type, type_owner, type_name, defaulted FROM all_arguments WHERE data_level = 0 ORDER BY owner, object_name, package_name, overload, sequence");
      const argumentsByRoutine = Map.groupBy(argumentRows, (argument) => routineKey(argument, true));
      const proceduresByIdentity = Map.groupBy(procedureRows, (procedure) => routineName(procedure)?.identity);
      const routines: Record<string, RoutineSnapshot[]> = {};
      for (const procedure of procedureRows) {
        const named = routineName(procedure);
        const procedureParts = routineParts(procedure);
        if (!named || !procedureParts) continue;
        const duplicateIdentity = (proceduresByIdentity.get(named.identity)?.length ?? 0) > 1;
        const objectId = numberValue(procedure, "object_id");
        if (duplicateIdentity && objectId === undefined) continue;
        const identity = duplicateIdentity ? `${named.identity}#${objectId}` : named.identity;
        const routineArguments: RoutineArgument[] = [];
        let result: RoutineSnapshot["result"] = { kind: "void" };
        for (const argument of argumentsByRoutine.get(routineKey(procedure, false)) ?? []) {
          const position = numberValue(argument, "position");
          const type = dataType(argument);
          if (position === 0) {
            result = { kind: "scalar", type, nullable: true };
            continue;
          }
          routineArguments.push({
            ...(text(argument, "argument_name") ? { name: text(argument, "argument_name") } : {}),
            mode: argumentMode(text(argument, "in_out")),
            type,
            ...(text(argument, "defaulted") === undefined ? {} : { hasDefault: text(argument, "defaulted") === "Y" }),
          });
        }
        const kind = text(procedure, "object_type") === "FUNCTION" || result.kind === "scalar" ? "function" : "procedure";
        const routine: RoutineSnapshot = { name: named.name, schema: named.schema, identity, kind, arguments: routineArguments, argumentsComplete: true, result };
        (routines[named.name] ??= []).push(routine);
      }
      const majorVersion = /^\d+/u.exec(version)?.[0];
      return {
        format: "sqlbraid-metadata",
        formatVersion: 1,
        dialect: "oracle",
        dialectVersion: version,
        server: { product: "oracle", version, ...(majorVersion ? { majorVersion: Number(majorVersion) } : {}) },
        namespaces,
        types,
        relations,
        routines,
        metadata: { source: "Oracle ALL_* catalog views", introspectionScope: "objects visible to the inspecting session", completeness: "partial" },
      };
    },
  };
}
