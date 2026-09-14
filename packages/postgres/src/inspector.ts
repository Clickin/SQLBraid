import type { MetadataInspector, MetadataSnapshot, RelationSnapshot, RoutineSnapshot, TypeSnapshot } from "@sqlbraid/metadata";
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
  return typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : undefined;
}

const builtinArrayElements: Readonly<Record<string, string>> = Object.freeze({
  _bool: "bool",
  _bytea: "bytea",
  _char: "char",
  _name: "name",
  _int2: "int2",
  _int4: "int4",
  _int8: "int8",
  _oid: "oid",
  _text: "text",
  _varchar: "varchar",
  _bpchar: "bpchar",
  _float4: "float4",
  _float8: "float8",
  _numeric: "numeric",
  _money: "money",
  _time: "time",
  _timetz: "timetz",
  _timestamp: "timestamp",
  _timestamptz: "timestamptz",
  _interval: "interval",
  _date: "date",
  _uuid: "uuid",
  _json: "json",
  _jsonb: "jsonb",
  _xml: "xml",
});

async function rows(client: PgClientLike, text: string): Promise<readonly CatalogRow[]> {
  const result = await client.query({ text, values: [] });
  return result.rows.map(objectRow);
}

export function createPostgresInspector(client: PgClientLike): MetadataInspector {
  return {
    dialect: "postgres",
    async inspect(): Promise<MetadataSnapshot> {
      const versionRow = (await rows(client, "SELECT current_setting('server_version') AS version"))[0];
      const version = text(versionRow, "version") ?? "unknown";
      const tableRows = await rows(client, "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name");
      const columnRows = await rows(client, "SELECT table_schema, table_name, ordinal_position, column_name, data_type, udt_schema, udt_name, domain_schema, domain_name, numeric_precision, numeric_scale, is_nullable, column_default, is_identity, identity_generation, is_generated, generation_expression FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position");
      const relations: Record<string, RelationSnapshot> = {};
      for (const relation of tableRows) {
        const schema = text(relation, "table_schema");
        const name = text(relation, "table_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${name}`;
        const columns = columnRows.filter((column) => text(column, "table_schema") === schema && text(column, "table_name") === name).map((column) => {
          const dataType = text(column, "data_type") ?? "unknown";
          const domainName = text(column, "domain_name");
          const ordinal = numberValue(column, "ordinal_position");
          const generationExpression = text(column, "generation_expression");
          const generatedEvidence = text(column, "is_generated");
          const generated = generatedEvidence === undefined && generationExpression === undefined
            ? undefined
            : generatedEvidence === "ALWAYS" || Boolean(generationExpression);
          const identityGenerated = text(column, "is_identity") === "YES";
          return {
            name: text(column, "column_name") ?? "unknown",
            ordinal: ordinal === undefined ? 0 : Math.max(0, ordinal - 1),
            type: domainName
              ? `${text(column, "domain_schema") ?? schema}.${domainName}`
              : `${text(column, "udt_schema") ?? "pg_catalog"}.${text(column, "udt_name") ?? dataType}`,
            nullable: text(column, "is_nullable") === "YES",
            ...(numberValue(column, "numeric_precision") === undefined ? {} : { precision: numberValue(column, "numeric_precision") }),
            ...(numberValue(column, "numeric_scale") === undefined ? {} : { scale: numberValue(column, "numeric_scale") }),
            ...(text(column, "column_default") ? { defaultExpression: text(column, "column_default") } : {}),
            ...(generated === undefined ? {} : { generated }),
            ...(generated === true ? { insertable: false, updatable: false, ...(generationExpression ? { generationExpression } : {}) } : {}),
            ...(identityGenerated ? { identity: true } : {}),
            ...(text(column, "identity_generation") ? { identityGeneration: text(column, "identity_generation") } : {}),
          };
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
        const routine: RoutineSnapshot = {
          name,
          schema,
          identity,
          kind: text(entry, "routine_type") === "PROCEDURE" ? "procedure" : "function",
          arguments: [],
          argumentsComplete: false,
          result: text(entry, "routine_type") === "PROCEDURE" ? { kind: "void" } : { kind: "scalar", type: dataType, nullable: true },
        };
        routines[name] = [...(routines[name] ?? []), routine];
      }
      const types: Record<string, TypeSnapshot> = {};
      const catalogTypes = new Map<string, CatalogRow>();
      for (const column of columnRows) {
        const schema = text(column, "udt_schema");
        const name = text(column, "udt_name");
        if (!schema || !name) continue;
        const identity = `${schema}.${name}`;
        const element = schema === "pg_catalog" ? builtinArrayElements[name] : undefined;
        if (!types[identity]) {
          types[identity] = element
            ? { identity, name, kind: "array", elementType: `pg_catalog.${element}` }
            : { identity, name, kind: "scalar" };
        }
      }
      try {
        const catalogRows = await rows(
          client,
          "SELECT n.nspname AS type_schema, t.typname AS type_name, t.oid AS type_oid, t.typtype, t.typelem AS element_oid, t.typbasetype AS base_oid, r.rngsubtype AS range_subtype_oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace LEFT JOIN pg_range r ON r.rngtypid = t.oid WHERE n.nspname <> 'pg_toast'",
        );
        for (const row of catalogRows) {
          const schema = text(row, "type_schema");
          const name = text(row, "type_name");
          if (schema && name) catalogTypes.set(`${schema}.${name}`, row);
        }
      } catch {
        // Older/fake clients may expose only information_schema. Built-in
        // array evidence above remains sufficient for those snapshots.
      }
      const identityForOid = (oid: number | undefined): string | undefined => {
        if (oid === undefined) return undefined;
        for (const [identity, row] of catalogTypes) {
          if (numberValue(row, "type_oid") === oid) return identity;
        }
        return undefined;
      };
      for (const [identity, row] of catalogTypes) {
        const [schema, name] = identity.split(".");
        if (!schema || !name) continue;
        if (schema === "pg_catalog" && !types[identity]) continue;
        const kind = text(row, "typtype");
        const elementType = identityForOid(numberValue(row, "element_oid"));
        const baseType = identityForOid(numberValue(row, "base_oid"));
        const rangeSubtype = identityForOid(numberValue(row, "range_subtype_oid"));
        if (kind === "d") {
          types[identity] = { identity, name, kind: "domain", ...(baseType ? { baseType } : {}) };
        } else if (kind === "c") {
          types[identity] = { identity, name, kind: "composite" };
        } else if (kind === "r") {
          types[identity] = { identity, name, kind: "range", ...(rangeSubtype ? { baseType: rangeSubtype } : {}) };
        } else if (kind === "m") {
          types[identity] = { identity, name, kind: "multirange" };
        } else if (elementType) {
          types[identity] = { identity, name, kind: "array", elementType };
        } else if (!types[identity]) {
          types[identity] = { identity, name, kind: "scalar" };
        }
      }
      const majorVersion = /^\d+/u.exec(version)?.[0];
      return { format: "sqlbraid-metadata", formatVersion: 1, dialect: "postgres", dialectVersion: version, server: { product: "postgres", version, ...(majorVersion ? { majorVersion: Number(majorVersion) } : {}) }, namespaces: {}, types, relations, routines, metadata: { source: "postgres information_schema", introspectionScope: "non-system schemas", completeness: "partial" } };
    },
  };
}
