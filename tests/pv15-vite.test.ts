import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "vitest";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { parameterizedSql, type RenderedStatement } from "@sqlbraid/core";
import { transformSource, type SourceMap } from "@sqlbraid/compiler";
import sqlbraid from "@sqlbraid/vite";

const modules = [
  "@sqlbraid/template",
  "@sqlbraid/postgres",
  "@sqlbraid/mysql",
  "@sqlbraid/sqlite",
  "@sqlbraid/oracle",
  "@sqlbraid/mssql",
] as const;

function offsetAt(source: string, line: number, character: number): number {
  let offset = 0;
  for (let index = 1; index < line; index += 1) offset = source.indexOf("\n", offset) + 1;
  return offset + character;
}

function lineAndColumn(source: string, offset: number): { readonly line: number; readonly column: number } {
  const lines = source.slice(0, offset).split(/\r\n|\r|\n/u);
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

async function invokePlugin(plugin: ReturnType<typeof sqlbraid>, context: unknown, source: string, id: string): Promise<unknown> {
  const hook = plugin.transform;
  if (typeof hook !== "function") throw new Error("sqlbraid transform hook missing");
  return hook.call(context as never, source, id);
}

test("first-party and configured custom tags preserve inactive-branch laziness", async () => {
  const template = await import("@sqlbraid/template");
  for (const moduleSpecifier of [...modules, "@acme/sql"]) {
    const custom = moduleSpecifier === "@acme/sql";
    const source = `import { ${custom ? "query" : "sql"} as tag } from "${moduleSpecifier}";
let evaluations = 0;
function make(value?: { id: number }) {
  return tag\`SELECT 1 /*@braid if \${value !== undefined}*/ WHERE id = \${(++evaluations, value.id)} /*@braid end*/\`;
}
export const query = make();
export { evaluations };`;
    const result = transformSource(source, "query.ts", custom ? { moduleSpecifier, tagExport: "query" } : {});
    assert.equal(result.diagnostics.length, 0);
    const library: unknown = custom ? { query: template.sql } : await import(moduleSpecifier);
    const output: { query?: { render(): RenderedStatement }; evaluations?: number } = {};
    const javascript = ts.transpileModule(result.code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "exports", javascript)((name: string) => {
      if (name === moduleSpecifier) return library;
      if (name === "@sqlbraid/template") return template;
      throw new Error(`Unexpected generated import ${name}`);
    }, output);
    assert.ok(output.query);
    assert.equal(parameterizedSql(output.query.render(), () => "?").trim(), "SELECT 1");
    assert.equal(output.evaluations, 0);
  }
});

test("transformSource recognizes contract-form first-party and custom tags", async () => {
  const template = await import("@sqlbraid/template");
  for (const moduleSpecifier of [...modules, "@acme/sql"]) {
    const custom = moduleSpecifier === "@acme/sql";
    const source = `import { ${custom ? "query" : "sql"} as tag } from "${moduleSpecifier}";
const schema = { "~standard": { version: 1 as const, vendor: "test", validate: (value: unknown) => ({ value: { value } }) } };
const contract = { output: schema };
let evaluations = 0;
export const query = tag.call(contract)\`CALL routine() /*@braid if \${false}*/ WHERE id = \${(++evaluations, 1)} /*@braid end*/\`;
export { evaluations, schema };`;
    const result = transformSource(source, "contract.ts", custom ? { moduleSpecifier, tagExport: "query" } : {});
    assert.equal(result.diagnostics.length, 0);
    const library: unknown = custom ? { query: template.sql } : await import(moduleSpecifier);
    const output: {
      query?: { render(): RenderedStatement; readonly routineContract?: { readonly output?: unknown } };
      evaluations?: number;
      schema?: unknown;
    } = {};
    const javascript = ts.transpileModule(result.code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "exports", javascript)((name: string) => {
      if (name === moduleSpecifier) return library;
      if (name === "@sqlbraid/template") return template;
      throw new Error(`Unexpected generated import ${name}`);
    }, output);
    assert.ok(output.query);
    assert.equal(parameterizedSql(output.query.render(), () => "?").trim(), "CALL routine()");
    assert.equal(output.evaluations, 0);
    assert.equal(output.query.routineContract?.output, output.schema);
  }
});

test("lowers guarded templates without transpiling TypeScript or TSX", () => {
  const source = [
    "import { sql } from '@sqlbraid/template';",
    "type User = { id: number; email: string };",
    "const user: User | null = { id: 1, email: 'a@example.com' };",
    "export function View() {",
    "  const query = sql.rows<User>`SELECT id FROM users /*@braid if ${user !== null}*/ /*@braid choose*/ /*@braid when ${user.id > 0}*/ WHERE email = ${user.email} /*@braid otherwise*/ WHERE id IS NULL /*@braid end*/ /*@braid end*/`;",
    "  return <section data-query={query}>안녕</section>;",
    "}",
  ].join("\n");
  const result = transformSource(source, "component.tsx");
  assert.equal(result.diagnostics.length, 0);
  assert.ok(result.map);
  const map = new TraceMap(result.map as SourceMap);
  const parsed = ts.createSourceFile("component.tsx", result.code, ts.ScriptTarget.Latest, true);
  const generatedPrefix = parsed.statements.find((statement) => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === "@sqlbraid/template"
  ));
  assert.ok(generatedPrefix);
  const prefixStart = generatedPrefix.getStart(parsed);
  const prefixLine = result.code.indexOf("\n", prefixStart) + 1;
  assert.ok(prefixLine > prefixStart);
  const prefixPosition = originalPositionFor(map, lineAndColumn(result.code, prefixLine));
  const expectedPrefix = lineAndColumn(source, 0);
  assert.equal(prefixPosition.line, expectedPrefix.line);
  assert.equal(prefixPosition.column, expectedPrefix.column);
  const generatedQuery = result.code.indexOf("sql.rows");
  assert.ok(generatedQuery >= 0);
  const queryPosition = originalPositionFor(map, lineAndColumn(result.code, generatedQuery));
  const expectedQuery = lineAndColumn(source, source.indexOf("sql.rows"));
  assert.equal(queryPosition.line, expectedQuery.line);
  assert.equal(queryPosition.column, expectedQuery.column);
  const helperLine = result.code.indexOf("\n", generatedQuery) + 1;
  assert.ok(helperLine > generatedQuery);
  const helperPosition = originalPositionFor(map, lineAndColumn(result.code, helperLine));
  assert.equal(helperPosition.line, expectedQuery.line);
  assert.equal(helperPosition.column, expectedQuery.column);
  const generatedBinding = result.code.indexOf("user.email", generatedQuery);
  assert.ok(generatedBinding >= 0);
  const bindingPosition = originalPositionFor(map, lineAndColumn(result.code, generatedBinding));
  const expectedBinding = lineAndColumn(source, source.indexOf("user.email"));
  assert.equal(bindingPosition.line, expectedBinding.line);
  assert.equal(bindingPosition.column, expectedBinding.column);
  assert.match(result.code, /type User = \{ id: number; email: string \}/u);
  assert.match(result.code, /<section data-query=\{query\}>안녕<\/section>/u);
});

test("maps multiple lowered queries and Unicode locations back to original source", () => {
  const source = [
    "import { sql } from '@sqlbraid/template';",
    "const label = '한국어';",
    "const first = sql`SELECT 1 /*@braid if ${label}*/ WHERE name = ${label} /*@braid end*/`;",
    "const untouched = label;",
    "const second = sql`SELECT 2 /*@braid if ${label}*/ WHERE name = ${label} /*@braid end*/`;",
    "const after = '끝';",
  ].join("\n");
  const result = transformSource(source, "unicode.ts");
  assert.ok(result.map);
  const map = new TraceMap(result.map as SourceMap);
  const parsed = ts.createSourceFile("unicode.ts", result.code, ts.ScriptTarget.Latest, true);
  const generatedQueries = parsed.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name) && ["first", "second"].includes(declaration.name.text))
    .map((declaration) => {
      assert.ok(declaration.initializer);
      return declaration.initializer.getStart(parsed);
    });
  assert.equal(generatedQueries.length, 2);
  const expectedQueries = [...source.matchAll(/sql`/g)].map((match) => match.index ?? 0);
  for (const [index, generatedOffset] of generatedQueries.entries()) {
    const generated = lineAndColumn(result.code, generatedOffset);
    const original = originalPositionFor(map, generated);
    const expected = lineAndColumn(source, expectedQueries[index] ?? 0);
    assert.equal(original.line, expected.line);
    assert.equal(original.column, expected.column);
  }
  const generatedBefore = result.code.indexOf("const label");
  const mappedBefore = originalPositionFor(map, lineAndColumn(result.code, generatedBefore));
  const expectedBefore = lineAndColumn(source, source.indexOf("const label"));
  assert.equal(mappedBefore.line, expectedBefore.line);
  assert.equal(mappedBefore.column, expectedBefore.column);
  const generatedBinding = result.code.indexOf("label", generatedQueries[0] ?? 0);
  const mappedBinding = originalPositionFor(map, lineAndColumn(result.code, generatedBinding));
  const firstQuerySource = source.indexOf("const first");
  const expectedBinding = lineAndColumn(source, source.indexOf("${label}", firstQuerySource) + 2);
  assert.equal(mappedBinding.line, expectedBinding.line);
  assert.equal(mappedBinding.column, expectedBinding.column);
  const firstHelperLine = result.code.indexOf("\n", generatedQueries[0] ?? 0) + 1;
  const mappedHelper = originalPositionFor(map, lineAndColumn(result.code, firstHelperLine));
  const expectedFirstQuery = lineAndColumn(source, expectedQueries[0] ?? 0);
  assert.equal(mappedHelper.line, expectedFirstQuery.line);
  assert.equal(mappedHelper.column, expectedFirstQuery.column);
  const generatedAfter = result.code.indexOf("const after");
  const mappedAfter = originalPositionFor(map, lineAndColumn(result.code, generatedAfter));
  const expectedAfter = lineAndColumn(source, source.lastIndexOf("const after"));
  assert.equal(mappedAfter.line, expectedAfter.line);
  assert.equal(mappedAfter.column, expectedAfter.column);
  assert.equal(offsetAt(source, mappedAfter.line, mappedAfter.column), source.lastIndexOf("const after"));
});

test("Vite forwards transform maps for downstream composition", async () => {
  const source = [
    "import { sql } from '@sqlbraid/template';",
    "const before = 1;",
    "const query = sql`SELECT 1 /*@braid if ${before}*/ WHERE id = ${before} /*@braid end*/`;",
    "const after = 2;",
  ].join("\n");
  const transformed = await invokePlugin(sqlbraid(), {}, source, "/workspace/src/query.ts");
  assert.ok(transformed && typeof transformed === "object");
  const result = transformed as { readonly code: string; readonly map: SourceMap | null };
  assert.ok(result.map);
  const map = new TraceMap(result.map);
  const parsed = ts.createSourceFile("query.ts", result.code, ts.ScriptTarget.Latest, true);
  const generatedQuery = parsed.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "query")
    ?.initializer?.getStart(parsed) ?? -1;
  assert.ok(generatedQuery >= 0);
  const mappedQuery = originalPositionFor(map, lineAndColumn(result.code, generatedQuery));
  const expectedQuery = lineAndColumn(source, source.indexOf("sql`"));
  assert.equal(mappedQuery.line, expectedQuery.line);
  assert.equal(mappedQuery.column, expectedQuery.column);
  const generatedAfter = result.code.indexOf("const after");
  const mappedAfter = originalPositionFor(map, lineAndColumn(result.code, generatedAfter));
  const expectedAfter = lineAndColumn(source, source.indexOf("const after"));
  assert.equal(mappedAfter.line, expectedAfter.line);
  assert.equal(mappedAfter.column, expectedAfter.column);
});

test("Vite plugin filters generated modules and reports original diagnostics", async () => {
  const plugin = sqlbraid();
  const source = "import { sql } from '@sqlbraid/template';\nconst q = sql`SELECT 1\n/*@braid otherwise*/`;";
  for (const id of [
    "/workspace/node_modules/pkg/index.ts",
    "/workspace/dist/index.ts",
    "/workspace/src/generated/query.ts",
    "/workspace/src/query.gen.ts",
    "/workspace/src/query.d.ts",
  ]) {
    assert.equal(await invokePlugin(plugin, {}, source, id), null);
  }

  let reported: unknown;
  const context = {
    warn() {},
    error(error: unknown) {
      reported = error;
      throw error;
    },
  };
  await assert.rejects(() => invokePlugin(plugin, context, source, "/workspace/src/query.ts"));
  assert.match(String((reported as { readonly message?: unknown })?.message), /BRAID_STRUCTURE/u);
  assert.deepEqual((reported as { readonly loc?: unknown })?.loc, {
    file: "/workspace/src/query.ts", line: 2, column: 13,
  });
});

