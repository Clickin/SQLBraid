import { qualifiedIdentity, QUALIFIED_IDENTITY_ENCODING } from "../../metadata/src/qualified-identity.js";
import type { ColumnSnapshot, MetadataInspector, MetadataSnapshot, RelationSnapshot } from "@sqlbraid/metadata";
import {
  findSqliteRowidIdentityColumn,
  quoteSqliteIdentifier,
  readSqliteMetadataRows,
  sqliteMetadataInteger,
  sqliteMetadataText,
} from "./internal/sqlite-metadata.js";
import type { SqliteMetadataDatabaseLike } from "./internal/sqlite-metadata.js";
export type { SqliteMetadataDatabaseLike, SqliteMetadataStatementLike } from "./internal/sqlite-metadata.js";

export function createSqliteInspector(database: SqliteMetadataDatabaseLike): MetadataInspector {
  return {
    dialect: "sqlite",
    async inspect(): Promise<MetadataSnapshot> {
      const versionRow = readSqliteMetadataRows(database, "SELECT sqlite_version() AS version")[0];
      const version = sqliteMetadataText(versionRow?.version) ?? "unknown";
      const namespaces: Record<
        string,
        { readonly name: string; readonly kind: "attached"; readonly catalog?: string }
      > = Object.create(null);
      for (const entry of readSqliteMetadataRows(database, "PRAGMA database_list")) {
        const name = sqliteMetadataText(entry.name) ?? "unknown";
        namespaces[name] = { name, kind: "attached", catalog: sqliteMetadataText(entry.file) };
      }
      const relations: Record<string, RelationSnapshot> = Object.create(null);
      const tableFlags = new Map<string, { readonly strict: boolean; readonly withoutRowid: boolean }>();
      try {
        for (const entry of readSqliteMetadataRows(database, "PRAGMA table_list")) {
          const name = sqliteMetadataText(entry.name);
          const schema = sqliteMetadataText(entry.schema) ?? "main";
          if (name)
            tableFlags.set(`${schema}\u0000${name}`, {
              strict: sqliteMetadataInteger(entry.strict) === 1,
              withoutRowid: sqliteMetadataInteger(entry.wr) === 1,
            });
        }
      } catch {
        // Older SQLite versions may not expose table_list; leave these facts unknown.
      }
      const objects = readSqliteMetadataRows(
        database,
        "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
      );
      for (const object of objects) {
        const name = sqliteMetadataText(object.name);
        if (!name) continue;
        const flags = tableFlags.get(`main\u0000${name}`);
        const strict = flags?.strict;
        const withoutRowid = flags?.withoutRowid;
        const columns: ColumnSnapshot[] = [];
        const info = readSqliteMetadataRows(database, `PRAGMA main.table_xinfo(${quoteSqliteIdentifier(name)})`);
        const identityColumn =
          object.type === "table"
            ? findSqliteRowidIdentityColumn(database, name, info, withoutRowid === true)
            : undefined;
        for (const entry of info) {
          const columnName = sqliteMetadataText(entry.name);
          const ordinal = sqliteMetadataInteger(entry.cid);
          if (!columnName || ordinal === undefined) continue;
          const declaredType = sqliteMetadataText(entry.type) ?? "ANY";
          const hidden = sqliteMetadataInteger(entry.hidden);
          const generated = hidden === undefined ? undefined : hidden === 2 || hidden === 3;
          columns.push({
            name: columnName,
            ordinal,
            type: declaredType || "ANY",
            nullable: identityColumn === columnName ? false : sqliteMetadataInteger(entry.notnull) !== 1,
            ...(sqliteMetadataText(entry.dflt_value) === undefined
              ? {}
              : { defaultExpression: sqliteMetadataText(entry.dflt_value) }),
            ...(generated === undefined ? {} : { generated }),
            ...(generated === true ? { insertable: false, updatable: false } : {}),
            ...(identityColumn === columnName ? { identity: true } : {}),
          });
        }
        const identity = qualifiedIdentity("main", name);
        relations[identity] = {
          identity,
          name,
          namespace: "main",
          kind: object.type === "view" ? "view" : "table",
          columns,
          ...(withoutRowid === undefined ? {} : { withoutRowid }),
          ...(strict === undefined ? {} : { strict }),
        };
      }
      let compileOptions: readonly string[] = [];
      try {
        compileOptions = readSqliteMetadataRows(database, "PRAGMA compile_options").flatMap((entry) => {
          const option = sqliteMetadataText(entry.compile_options);
          return option ? [option] : [];
        });
      } catch {
        /* optional metadata */
      }
      return {
        format: "sqlbraid-metadata",
        formatVersion: 1,
        dialect: "sqlite",
        dialectVersion: version,
        server: { product: "sqlite", version, capabilities: { compileOptions } },
        namespaces,
        types: Object.create(null),
        relations,
        routines: Object.create(null),
        metadata: {
          source: "sqlite inspector",
          introspectionScope: "main",
          completeness: "complete",
          identityEncoding: QUALIFIED_IDENTITY_ENCODING,
        },
      };
    },
  };
}
