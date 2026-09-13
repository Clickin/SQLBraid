import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { discoverQueries, emitSource } from "@sqlbraid/compiler";
import { createLanguageService } from "@sqlbraid/tooling";
import type { MetadataSnapshot } from "@sqlbraid/metadata";

function metadata(dialect: "oracle" | "mssql", relation: { readonly identity: string; readonly name: string; readonly namespace: string; readonly column: string }): MetadataSnapshot {
  return {
    format: "sqlbraid-metadata",
    formatVersion: 1,
    dialect,
    dialectVersion: dialect === "oracle" ? "19c" : "2022",
    server: {},
    namespaces: { [relation.namespace]: { name: relation.namespace, kind: "schema" } },
    types: {},
    relations: {
      [relation.identity]: {
        identity: relation.identity,
        name: relation.name,
        namespace: relation.namespace,
        kind: "table",
        columns: [{ name: relation.column, ordinal: 0, type: "integer", nullable: false }],
      },
    },
    routines: {},
    metadata: { completeness: "partial", introspectionScope: relation.namespace },
  };
}

test.each([
  ["oracle", "SELECT c.ID FROM APP.CUSTOMERS c"],
  ["mssql", "SELECT u.[UserId] FROM [dbo].[Users] AS u"],
] as const)("compiler discovers %s first-party SQL tags", (module, sqlText) => {
  const source = `import { sql } from "@sqlbraid/${module}"; const query = sql.rows<{}>\`${sqlText}\`;`;
  const result = discoverQueries(source, `${module}.ts`, {});
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0]?.moduleSpecifier, `@sqlbraid/${module}`);
  assert.equal(result.diagnostics.length, 0);
});

test("Oracle q literals stay opaque while known metadata remains useful", async () => {
  const snapshot = metadata("oracle", { identity: "APP.CUSTOMERS", name: "CUSTOMERS", namespace: "APP", column: "ID" });
  const source = "import { sql } from '@sqlbraid/oracle'; const query = sql.rows<{}>`SELECT c.ID, q'[FROM fake_table]' FROM APP.CUSTOMERS c`;";
  const target = { name: "oracle", metadata: snapshot, metadataPath: "oracle-metadata.json", metadataSource: JSON.stringify(snapshot) };
  const service = createLanguageService({ targets: [target] });
  assert.deepEqual(service.diagnostics(source, "oracle.ts"), []);
  assert.match(service.hover(source, "oracle.ts", source.indexOf("CUSTOMERS"))?.contents ?? "", /^Relation APP\.CUSTOMERS/u);
  assert.equal(service.complete(source.replace("APP.CUSTOMERS", "APP."), "oracle.ts", source.indexOf("APP.CUSTOMERS") + "APP.".length)[0]?.label, "CUSTOMERS");
  assert.ok(service.definition(source, "oracle.ts", source.indexOf("CUSTOMERS"))?.uri.endsWith("oracle-metadata.json"));
  assert.equal((await service.references(source, "oracle.ts", source.indexOf("CUSTOMERS"))).length, 1);
  assert.equal(service.hover(source, "oracle.ts", source.indexOf("fake_table")), undefined);
});

test("SQL Server bracket identifiers resolve and unknown temp objects stay open-world", async () => {
  const snapshot = metadata("mssql", { identity: "dbo.Users", name: "Users", namespace: "dbo", column: "UserId" });
  const source = "import { sql } from '@sqlbraid/mssql'; const query = sql.rows<{}>`SELECT u.[UserId] FROM [dbo].[Users] AS u JOIN #session_temp t ON t.[UserId] = u.[UserId] WHERE dbo.unknown_builtin(u.[UserId]) = ${1}`;";
  const target = { name: "mssql", metadata: snapshot, metadataPath: "mssql-metadata.json", metadataSource: JSON.stringify(snapshot) };
  const service = createLanguageService({ targets: [target] });
  assert.deepEqual(service.diagnostics(source, "mssql.ts"), []);
  assert.match(service.hover(source, "mssql.ts", source.indexOf("[Users]"))?.contents ?? "", /^Relation dbo\.Users/u);
  assert.match(service.hover(source, "mssql.ts", source.indexOf("[UserId]"))?.contents ?? "", /^Column dbo\.Users\.UserId/u);
  const completionSource = source.replace("[dbo].[Users]", "dbo.");
  assert.equal(service.complete(completionSource, "mssql.ts", completionSource.indexOf("dbo.") + "dbo.".length)[0]?.label, "Users");
  assert.ok(service.definition(source, "mssql.ts", source.indexOf("[Users]"))?.uri.endsWith("mssql-metadata.json"));
  assert.ok(service.definition(source, "mssql.ts", source.indexOf("[UserId]"))?.uri.endsWith("mssql-metadata.json"));
  assert.equal((await service.references(source, "mssql.ts", source.indexOf("[Users]"))).length, 1);
  assert.doesNotMatch(service.hover(source, "mssql.ts", source.indexOf("#session_temp"))?.contents ?? "", /^Relation /u);
  assert.doesNotMatch(service.hover(source, "mssql.ts", source.indexOf("unknown_builtin"))?.contents ?? "", /^Routine /u);
});

test("emitted guarded lowering rejects bind hints before entering a branch", async () => {
  const source = `
    import { sql } from "@sqlbraid/template";
    export function build(condition, branch) {
      return sql\`SELECT 1 /*@braid if \${sql.bind(condition(), { databaseType: "NUMBER" })}*/ AND value = \${branch()} /*@braid end*/\`;
    }
  `;
  const emitted = emitSource(source, "bind-condition.ts", { moduleSpecifier: "@sqlbraid/template" });
  assert.equal(emitted.diagnostics.length, 0);
  const directory = mkdtempSync(join(process.cwd(), ".sqlbraid-bind-condition-"));
  try {
    const file = join(directory, "bind-condition.mjs");
    writeFileSync(file, emitted.outputText.replace(/\n\/\/#[^\n]*sourceMappingURL[^\n]*/u, ""));
    const module = await import(pathToFileURL(file).href);
    const events: string[] = [];
    assert.throws(
      () => module.build(() => { events.push("condition"); return false; }, () => { events.push("branch"); return 1; }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_BIND_HINT_CONTEXT",
    );
    assert.deepEqual(events, ["condition"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
