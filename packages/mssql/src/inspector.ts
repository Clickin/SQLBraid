import type { MetadataInspector, MetadataSnapshot, RelationSnapshot, RoutineArgument, RoutineSnapshot, TypeSnapshot } from "@sqlbraid/metadata";
import type { TediousConnectionLike } from "./tedious.js";
import { createTediousExecutor } from "./tedious.js";

interface CatalogRow {
  readonly [key: string]: unknown;
}

function objectRow(value: unknown): CatalogRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MSSQL_INSPECT_ROW: catalog row is not an object.");
  return Object.fromEntries(Object.entries(value));
}

function text(row: CatalogRow | undefined, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === "string" ? value : undefined;
}

function integer(row: CatalogRow | undefined, key: string): number | undefined {
  const value = row?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : undefined;
}

async function rows(connection: TediousConnectionLike, textQuery: string): Promise<readonly CatalogRow[]> {
  const result = await createTediousExecutor(connection).query<CatalogRow>({
    segments: [textQuery],
    parameters: [],
    dialectId: "mssql",
    resultKind: "rows",
  });
  if (result.kind !== "rows") throw new Error("MSSQL_INSPECT_RESULT: catalog query did not return rows.");
  return result.rows.map(objectRow);
}

function typeSnapshot(types: Record<string, TypeSnapshot>, name: string | undefined, schema = "sys"): void {
  if (!name) return;
  const identity = `${schema}.${name}`;
  if (!types[identity]) types[identity] = { identity, name, kind: "scalar" };
}

function typeReference(row: CatalogRow | undefined): { readonly name: string; readonly identity: string } {
  const name = text(row, "data_type") ?? "unknown";
  const schema = text(row, "type_schema_name") ?? "sys";
  const userDefined = row?.is_user_defined === true || row?.is_user_defined === 1 || text(row, "is_user_defined") === "1";
  return { name, identity: userDefined ? `${schema}.${name}` : name };
}

function nullable(row: CatalogRow): boolean {
  return row.is_nullable === true || row.is_nullable === 1 || text(row, "is_nullable") === "1";
}

export function createMssqlInspector(connection: TediousConnectionLike): MetadataInspector {
  return {
    dialect: "mssql",
    async inspect(): Promise<MetadataSnapshot> {
      const server = (await rows(connection, `
        SELECT
          CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
          CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128)) AS productLevel,
          CAST(SERVERPROPERTY('Edition') AS nvarchar(256)) AS edition,
          CAST(SERVERPROPERTY('EngineEdition') AS int) AS engineEdition
      `))[0];
      const version = text(server, "version") ?? "unknown";
      const schemas = await rows(connection, `
        SELECT name AS schema_name
        FROM sys.schemas
        WHERE name NOT IN (N'sys', N'INFORMATION_SCHEMA')
        ORDER BY name
      `);
      const namespaces = Object.fromEntries(schemas.flatMap((entry) => {
        const name = text(entry, "schema_name");
        return name ? [[name, { name, kind: "schema" as const }]] : [];
      }));
      const relationRows = await rows(connection, `
        SELECT
          s.name AS schema_name,
          o.name AS relation_name,
          CASE WHEN o.type = 'V' THEN N'VIEW' ELSE N'TABLE' END AS relation_kind
        FROM sys.objects AS o
        JOIN sys.schemas AS s ON s.schema_id = o.schema_id
        WHERE o.type IN ('U', 'V')
          AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA')
        ORDER BY s.name, o.name
      `);
      const columnRows = await rows(connection, `
        SELECT
          s.name AS schema_name,
          o.name AS relation_name,
          c.column_id AS ordinal_position,
          c.name AS column_name,
          t.name AS data_type,
          ts.name AS type_schema_name,
          t.is_user_defined AS is_user_defined,
          c.max_length AS max_length,
          c.precision AS numeric_precision,
          c.scale AS numeric_scale,
          c.is_nullable AS is_nullable,
          dc.definition AS default_expression,
          c.is_identity AS is_identity,
          c.is_computed AS is_computed,
          c.generated_always_type AS generated_always_type,
          cc.definition AS computed_definition,
          c.collation_name AS collation_name
        FROM sys.columns AS c
        JOIN sys.objects AS o ON o.object_id = c.object_id
        JOIN sys.schemas AS s ON s.schema_id = o.schema_id
        JOIN sys.types AS t ON t.user_type_id = c.user_type_id
        JOIN sys.schemas AS ts ON ts.schema_id = t.schema_id
        LEFT JOIN sys.default_constraints AS dc ON dc.object_id = c.default_object_id
        LEFT JOIN sys.computed_columns AS cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
        WHERE o.type IN ('U', 'V')
          AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA')
        ORDER BY s.name, o.name, c.column_id
      `);
      const relations: Record<string, RelationSnapshot> = {};
      const types: Record<string, TypeSnapshot> = {};
      for (const relation of relationRows) {
        const schema = text(relation, "schema_name");
        const name = text(relation, "relation_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${name}`;
        const columns = columnRows
          .filter((column) => text(column, "schema_name") === schema && text(column, "relation_name") === name)
          .map((column) => {
            const type = typeReference(column);
            typeSnapshot(types, type.name, text(column, "type_schema_name") ?? "sys");
            const generatedAlways = integer(column, "generated_always_type");
            const computed = Boolean(column.is_computed) || generatedAlways !== undefined && generatedAlways !== 0;
            const maxLength = integer(column, "max_length");
            const precision = integer(column, "numeric_precision");
            const scale = integer(column, "numeric_scale");
            return {
              name: text(column, "column_name") ?? "unknown",
              ordinal: Math.max(0, (integer(column, "ordinal_position") ?? 1) - 1),
              type: type.identity,
              nullable: nullable(column),
              ...(column.is_nullable !== undefined ? { nullabilityEvidence: String(column.is_nullable) } : {}),
              ...(text(column, "default_expression") ? { defaultExpression: text(column, "default_expression") } : {}),
              ...(column.is_identity === true || text(column, "is_identity") === "1" ? { identity: true } : {}),
              ...(computed ? { generated: true, insertable: false, updatable: false } : {}),
              ...(text(column, "computed_definition") ? { generationExpression: text(column, "computed_definition") } : {}),
              ...(maxLength !== undefined ? { length: maxLength } : {}),
              ...(precision !== undefined ? { precision } : {}),
              ...(scale !== undefined ? { scale } : {}),
              ...(text(column, "collation_name") ? { collation: text(column, "collation_name") } : {}),
            };
          });
        relations[identity] = {
          identity,
          name,
          namespace: schema,
          kind: text(relation, "relation_kind") === "VIEW" ? "view" : "table",
          columns,
        };
      }
      const routineRows = await rows(connection, `
        SELECT
          s.name AS schema_name,
          o.name AS routine_name,
          o.type AS routine_type,
          o.type_desc AS routine_type_desc,
          p.parameter_id AS parameter_id,
          p.name AS parameter_name,
          p.is_output AS is_output,
          p.has_default_value AS has_default_value,
          t.name AS data_type,
          ts.name AS type_schema_name,
          t.is_user_defined AS is_user_defined,
          p.max_length AS max_length,
          p.precision AS numeric_precision,
          p.scale AS numeric_scale
        FROM sys.objects AS o
        JOIN sys.schemas AS s ON s.schema_id = o.schema_id
        LEFT JOIN sys.parameters AS p ON p.object_id = o.object_id
        LEFT JOIN sys.types AS t ON t.user_type_id = p.user_type_id
        LEFT JOIN sys.schemas AS ts ON ts.schema_id = t.schema_id
        WHERE o.type IN ('P', 'FN', 'IF', 'TF')
          AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA')
        ORDER BY s.name, o.name, p.parameter_id
      `);
      const routineColumnRows = await rows(connection, `
        SELECT
          s.name AS schema_name,
          o.name AS routine_name,
          c.column_id AS ordinal_position,
          c.name AS column_name,
          t.name AS data_type,
          ts.name AS type_schema_name,
          t.is_user_defined AS is_user_defined,
          c.max_length AS max_length,
          c.precision AS numeric_precision,
          c.scale AS numeric_scale,
          c.is_nullable AS is_nullable,
          c.collation_name AS collation_name
        FROM sys.columns AS c
        JOIN sys.objects AS o ON o.object_id = c.object_id
        JOIN sys.schemas AS s ON s.schema_id = o.schema_id
        JOIN sys.types AS t ON t.user_type_id = c.user_type_id
        JOIN sys.schemas AS ts ON ts.schema_id = t.schema_id
        WHERE o.type IN ('IF', 'TF')
          AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA')
        ORDER BY s.name, o.name, c.column_id
      `);
      const routines: Record<string, readonly RoutineSnapshot[]> = {};
      for (const entry of routineRows) {
        const schema = text(entry, "schema_name");
        const name = text(entry, "routine_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${name}`;
        const kindCode = text(entry, "routine_type");
        const kind = kindCode === "P" ? "procedure" : "function";
        const argumentRows = routineRows.filter((candidate) =>
          text(candidate, "schema_name") === schema
          && text(candidate, "routine_name") === name
          && integer(candidate, "parameter_id") !== 0
          && integer(candidate, "parameter_id") !== undefined,
        );
        const routineArguments: RoutineArgument[] = argumentRows.map((argument) => {
          const type = typeReference(argument);
          typeSnapshot(types, type.name, text(argument, "type_schema_name") ?? "sys");
          return {
            name: text(argument, "parameter_name")?.replace(/^@/u, ""),
            mode: argument.is_output === true || text(argument, "is_output") === "1" ? "out" : "in",
            type: type.identity,
            ...(argument.has_default_value === true || text(argument, "has_default_value") === "1" ? { hasDefault: true } : {}),
            ...(integer(argument, "max_length") !== undefined ? { length: integer(argument, "max_length") } : {}),
            ...(integer(argument, "numeric_precision") !== undefined ? { precision: integer(argument, "numeric_precision") } : {}),
            ...(integer(argument, "numeric_scale") !== undefined ? { scale: integer(argument, "numeric_scale") } : {}),
          };
        });
        const returnRow = routineRows.find((candidate) =>
          text(candidate, "schema_name") === schema
          && text(candidate, "routine_name") === name
          && integer(candidate, "parameter_id") === 0,
        );
        const returnType = returnRow ? typeReference(returnRow) : undefined;
        if (returnType) typeSnapshot(types, returnType.name, text(returnRow, "type_schema_name") ?? "sys");
        const tableColumns = routineColumnRows
          .filter((column) => text(column, "schema_name") === schema && text(column, "routine_name") === name)
          .map((column) => {
            const type = typeReference(column);
            typeSnapshot(types, type.name, text(column, "type_schema_name") ?? "sys");
            return {
              name: text(column, "column_name") ?? "unknown",
              ordinal: Math.max(0, (integer(column, "ordinal_position") ?? 1) - 1),
              type: type.identity,
              nullable: nullable(column),
              ...(column.is_nullable !== undefined ? { nullabilityEvidence: String(column.is_nullable) } : {}),
              ...(integer(column, "max_length") !== undefined ? { length: integer(column, "max_length") } : {}),
              ...(integer(column, "numeric_precision") !== undefined ? { precision: integer(column, "numeric_precision") } : {}),
              ...(integer(column, "numeric_scale") !== undefined ? { scale: integer(column, "numeric_scale") } : {}),
              ...(text(column, "collation_name") ? { collation: text(column, "collation_name") } : {}),
            };
          });
        const routine: RoutineSnapshot = {
          name,
          schema,
          identity,
          kind,
          arguments: routineArguments,
          argumentsComplete: true,
          result: kind === "procedure"
            ? { kind: "unknown" }
            : kindCode === "FN"
              ? { kind: "scalar", type: returnType?.identity ?? "unknown", nullable: true }
              : tableColumns.length > 0 ? { kind: "table", columns: tableColumns } : { kind: "unknown" },
        };
        const current = routines[name] ?? [];
        if (!current.some((candidate) => candidate.identity === identity)) routines[name] = [...current, routine];
      }
      const major = /^\d+/u.exec(version)?.[0];
      return {
        format: "sqlbraid-metadata",
        formatVersion: 1,
        dialect: "mssql",
        dialectVersion: version,
        server: {
          product: "Microsoft SQL Server",
          version,
          ...(major ? { majorVersion: Number(major) } : {}),
          capabilities: {
            productLevel: text(server, "productLevel") ?? "",
            edition: text(server, "edition") ?? "",
            engineEdition: integer(server, "engineEdition") ?? 0,
          },
        },
        namespaces,
        types,
        relations,
        routines,
        metadata: {
          source: "SQL Server sys catalogs",
          introspectionScope: "non-system schemas",
          completeness: "partial",
        },
      };
    },
  };
}
