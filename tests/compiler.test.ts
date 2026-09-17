import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { test } from "vitest";
import {
  checkProject,
  checkSource,
  checkSourceDetailed,
  createProjectContext,
  createVirtualOverlay,
  discoverQueries,
  emitSource,
  transformSource,
} from "@sqlbraid/compiler";

const source = `import { sql as dbSql } from '@sqlbraid/template';\nconst name: string | null = 'Ada';\ntype UserRow = { id: bigint };\nconst query = dbSql.rows<UserRow>\`SELECT custom_company_function(id) AS id FROM vendor_table /*@braid where*/ /*@braid if \${name != null}*/ AND name = \${name} /*@braid end*/ /*@braid end*/\`;`;
const options = {
  moduleSpecifier: "@sqlbraid/template",
  compilerOptions: { baseUrl: process.cwd(), paths: { "@sqlbraid/*": ["packages/*/src/index.ts"] } },
};

test("discovers aliased SQL tags by import identity", () => {
  const result = discoverQueries(source, "fixture.ts", { moduleSpecifier: "@sqlbraid/template" });
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].bindings.length, 2);
  assert.equal(result.queries[0].bindings[1].expression, "name");
});

const ownershipProbe = "sql`SELECT 1 /*@braid if ${false}*/ WHERE id = ${effect()} /*@braid end*/`";
// Each row specifies binding form and ownership; ownership requires one discovered/lowered
// query, while a foreign binding requires zero discoveries and byte-for-byte preservation.
const tagOwnershipCases: readonly [form: string, body: string, owned: boolean][] = [
  ["import", `${ownershipProbe};`, true],
  ["block const", `{ const sql = foreignTag; ${ownershipProbe}; }`, false],
  ["block let before declaration", `{ ${ownershipProbe}; let sql = foreignTag; }`, false],
  ["object binding", `{ const { sql } = object; ${ownershipProbe}; }`, false],
  ["array binding", `{ const [sql] = values; ${ownershipProbe}; }`, false],
  ["nested renamed binding", `{ const { nested: [{ tag: sql = foreignTag }] } = object; ${ownershipProbe}; }`, false],
  ["object rest binding", `{ const { other, ...sql } = object; ${ownershipProbe}; }`, false],
  ["array rest binding", `{ const [, ...sql] = values; ${ownershipProbe}; }`, false],
  ["binding property is not a local name", `{ const { sql: tag } = object; ${ownershipProbe}; }`, true],
  ["for initializer", `for (let sql = foreignTag; condition; step()) { ${ownershipProbe}; }`, false],
  ["for condition", `for (let sql = foreignTag; ${ownershipProbe}; step()) {}`, false],
  ["for increment", `for (let sql = foreignTag; condition; ${ownershipProbe}) {}`, false],
  ["for of", `for (const sql of values) { ${ownershipProbe}; }`, false],
  ["for in", `for (const sql in object) { ${ownershipProbe}; }`, false],
  ["destructured for of", `for (const { nested: [sql] } of values) { ${ownershipProbe}; }`, false],
  ["for binding does not escape", `for (const sql of values) {} ${ownershipProbe};`, true],
  ["identifier parameter", `function f(sql) { ${ownershipProbe}; }`, false],
  ["object parameter", `function f({ sql }) { ${ownershipProbe}; }`, false],
  ["array parameter", `function f([sql]) { ${ownershipProbe}; }`, false],
  ["arrow parameter", `const f = ({ sql }) => ${ownershipProbe};`, false],
  ["nested default parameter", `const f = ({ nested: [sql = foreignTag] }) => ${ownershipProbe};`, false],
  ["rest parameter", `function f(...sql) { ${ownershipProbe}; }`, false],
  ["identifier catch", `try {} catch (sql) { ${ownershipProbe}; }`, false],
  ["object catch", `try {} catch ({ sql }) { ${ownershipProbe}; }`, false],
  ["nested catch", `try {} catch ({ nested: [sql] }) { ${ownershipProbe}; }`, false],
  ["catch binding does not escape", `try {} catch ({ sql }) {} ${ownershipProbe};`, true],
  ["hoisted var before declaration", `function f() { ${ownershipProbe}; if (condition) { var sql = foreignTag; } }`, false],
  ["hoisted var after declaration", `function f() { if (condition) { var sql = foreignTag; } ${ownershipProbe}; }`, false],
  ["hoisted destructured var", `function f() { ${ownershipProbe}; if (condition) { var { sql } = object; } }`, false],
  ["hoisted for var", `function f() { for (var sql of values) {} ${ownershipProbe}; }`, false],
  ["nested function var does not escape", `function f() { function nested() { var sql; } ${ownershipProbe}; }`, true],
  ["block let does not escape", `function f() { if (condition) { let sql = foreignTag; } ${ownershipProbe}; }`, true],
  ["body var does not shadow parameter default", `function f(query = ${ownershipProbe}) { var sql; }`, true],
  ["body function does not shadow parameter default", `function f(query = ${ownershipProbe}) { function sql() {} }`, true],
  ["parameter default binding", `function f(sql = ${ownershipProbe}) {}`, false],
  ["function declaration", `{ ${ownershipProbe}; function sql() {} }`, false],
  ["function expression name", `const f = function sql() { ${ownershipProbe}; };`, false],
  ["function expression name does not escape", `const f = function sql() {}; ${ownershipProbe};`, true],
  ["class declaration", `{ ${ownershipProbe}; class sql {} }`, false],
  ["class expression name", `const C = class sql { field = ${ownershipProbe}; };`, false],
  ["class expression name does not escape", `const C = class sql {}; ${ownershipProbe};`, true],
  ["static block var", `class C { static { if (condition) { var sql; } ${ownershipProbe}; } }`, false],
  ["static block var does not escape", `class C { static { var sql; } } ${ownershipProbe};`, true],
  ["switch case binding", `switch (condition) { case true: ${ownershipProbe}; break; default: let sql; }`, false],
  ["switch discriminant outside case scope", `switch (${ownershipProbe}) { default: let sql; }`, true],
  ["enum binding", `{ enum sql {} ${ownershipProbe}; }`, false],
  ["namespace binding", `{ namespace sql { export const value = 1; } ${ownershipProbe}; }`, false],
  ["method computed name outside parameter scope", `const object = { [${ownershipProbe}](sql) {} };`, true],
];

const tagImportCases: readonly [form: string, source: string, tagExport: string, owned: boolean][] = [
  ["unimported local sql", `const sql = foreignTag; ${ownershipProbe};`, "sql", false],
  ["foreign import", `import { sql } from 'foreign-tags'; ${ownershipProbe};`, "sql", false],
  ["unrelated catalog export", `import { capture as sql } from '@sqlbraid/template'; ${ownershipProbe};`, "sql", false],
  ["type-only import", `import type { sql } from '@sqlbraid/template'; ${ownershipProbe};`, "sql", false],
  ["named alias", `import { sql as tag } from '@sqlbraid/template'; ${ownershipProbe.replace(/^sql/u, "tag.rows")};`, "sql", true],
  ["shadowed alias", `import { sql as tag } from '@sqlbraid/template'; function f({ tag }) { ${ownershipProbe.replace(/^sql/u, "tag.rows")}; }`, "sql", false],
  ["namespace import", `import * as braid from '@sqlbraid/template'; ${ownershipProbe.replace(/^sql/u, "braid.sql.rows(schema)")};`, "sql", true],
  ["shadowed namespace", `import * as braid from '@sqlbraid/template'; for (const { braid } of values) { ${ownershipProbe.replace(/^sql/u, "braid.sql.command")}; }`, "sql", false],
  ["custom export", `import { query as sql } from '@sqlbraid/template'; ${ownershipProbe};`, "query", true],
  ["default import", `import sql from '@sqlbraid/template'; ${ownershipProbe};`, "default", true],
  ["shadowed default import", `import sql from '@sqlbraid/template'; function f({ sql }) { ${ownershipProbe}; }`, "default", false],
];

test("tag ownership matrix preserves lexical bindings with and without a checker", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlbraid-tag-ownership-"));
  try {
    const cases: readonly [form: string, source: string, tagExport: string, owned: boolean][] = [
      ...tagOwnershipCases.map(([form, body, owned]): [string, string, string, boolean] => [
        form,
        `import { sql } from '@sqlbraid/template';\n${body}`,
        "sql",
        owned,
      ]),
      ...tagImportCases,
    ];
    const fixtures = cases.map(([form, body, tagExport, owned], index) => {
      const fileName = join(directory, `case-${index}.ts`);
      const source = `declare const foreignTag: any, values: any, object: any, schema: any, condition: boolean, step: () => void, effect: () => number;\n${body}`;
      writeFileSync(fileName, source);
      return { form, owned, fileName, source, tagExport };
    });
    const program = ts.createProgram(fixtures.map(({ fileName }) => fileName), { noLib: true, noResolve: true });
    const typeChecker = program.getTypeChecker();
    for (const fixture of fixtures) {
      for (const checked of [false, true]) {
        const options = {
          moduleSpecifier: "@sqlbraid/template",
          tagExport: fixture.tagExport,
          ...(checked ? { sourceFile: program.getSourceFile(fixture.fileName), typeChecker } : {}),
        };
        const label = `${fixture.form} (${checked ? "checker" : "syntax"})`;
        const discovered = discoverQueries(fixture.source, fixture.fileName, options);
        assert.deepEqual(discovered.diagnostics, [], label);
        assert.equal(discovered.queries.length, fixture.owned ? 1 : 0, label);
        const transformed = transformSource(fixture.source, fixture.fileName, options);
        assert.deepEqual(transformed.diagnostics, [], label);
        if (fixture.owned) {
          assert.notEqual(transformed.code, fixture.source, label);
          assert.equal(discoverQueries(transformed.code, fixture.fileName, {}).queries.length, 0, label);
        } else {
          assert.equal(transformed.code, fixture.source, label);
          assert.equal(transformed.map, null, label);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("foreign tags retain eager interpolation, tag invocation, and template identity after transformSource", async () => {
  const template = await import("@sqlbraid/template");
  const probe = "sql`SELECT 1 /*@braid if ${observe('guard', false)}*/ WHERE id = ${observe('value', 7)} /*@braid end*/`";
  const cases = [
    `for (const sql of [foreignTag]) { result = ${probe}; }`,
    `{ const { nested: [sql] } = { nested: [foreignTag] }; result = ${probe}; }`,
    `(({ sql }) => { result = ${probe}; })({ sql: foreignTag });`,
    `try { throw { sql: foreignTag }; } catch ({ sql }) { result = ${probe}; }`,
    `(function () { if (true) { var sql = foreignTag; } result = ${probe}; })();`,
  ];
  for (const body of cases) {
    const source = `import { sql } from '@sqlbraid/template';
export function run(foreignTag, observe) { let result; ${body} return result; }
export function braid(observe) { return sql\`SELECT 1 /*@braid if \${false}*/ WHERE id = \${observe('inactive', 1)} /*@braid end*/\`; }`;
    const transformed = transformSource(source, "foreign-tag.ts");
    const javascript = ts.transpileModule(transformed.code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const output: {
      run?: (tag: unknown, observe: unknown) => unknown;
      braid?: (observe: unknown) => { render(): { segments: readonly string[]; parameters: readonly unknown[] } };
    } = {};
    new Function("require", "exports", javascript)((name: string) => {
      assert.equal(name, "@sqlbraid/template");
      return template;
    }, output);
    assert.ok(output.run);
    assert.ok(output.braid);
    const events: unknown[] = [];
    const templates: TemplateStringsArray[] = [];
    const result = {};
    const foreignTag = (strings: TemplateStringsArray, ...values: unknown[]) => {
      events.push(["tag", ...values]);
      templates.push(strings);
      return result;
    };
    const observe = (name: string, value: unknown) => {
      events.push(name);
      return value;
    };
    assert.equal(output.run(foreignTag, observe), result);
    assert.equal(output.run(foreignTag, observe), result);
    assert.deepEqual(events, ["guard", "value", ["tag", false, 7], "guard", "value", ["tag", false, 7]]);
    assert.equal(templates[0], templates[1]);
    assert.deepEqual([...templates[0]], ["SELECT 1 /*@braid if ", "*/ WHERE id = ", " /*@braid end*/"]);
    const statement = output.braid(observe).render();
    assert.equal(statement.segments.join("").trim(), "SELECT 1");
    assert.deepEqual(statement.parameters, []);
    assert.equal(events.includes("inactive"), false);
    const failure = new Error("foreign interpolation failed");
    assert.throws(
      () => output.run?.(foreignTag, () => { throw failure; }),
      (error) => error === failure,
    );
    assert.equal(templates.length, 2);
  }
});

test("checker tag ownership follows the actual export, not sibling reexports or matching types", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlbraid-tag-symbols-"));
  try {
    writeFileSync(
      join(directory, "author.ts"),
      "export declare const sql: any; export declare const foreign: any;",
    );
    writeFileSync(
      join(directory, "bridge.ts"),
      "export { sql as braid, foreign as sql } from './author';",
    );
    writeFileSync(
      join(directory, "unrelated.ts"),
      "export { sql as other } from './author'; export declare const innocent: any;",
    );
    writeFileSync(join(directory, "star.ts"), "export * from './author';");
    writeFileSync(join(directory, "local.ts"), "import { sql as imported } from './author'; export { imported as sql };");
    const fileName = join(directory, "main.ts");
    const probe = (tag: string) => ownershipProbe.replace(/^sql/u, tag);
    const source = [
      "import { sql, foreign as importedForeign } from './author';",
      "import { sql as disguised, braid as reexported } from './bridge';",
      "import * as bridge from './bridge';",
      "import { innocent } from './unrelated';",
      "import { sql as star } from './star';",
      "import { sql as local } from './local';",
      "import type { sql as typeOnly } from './author';",
      "import type * as typeNamespace from './author';",
      "declare const effect: () => number;",
      ...["sql", "importedForeign", "disguised", "reexported", "bridge.sql", "bridge.braid", "innocent", "star", "local", "typeOnly", "typeNamespace.sql"].map((tag) => `${probe(tag)};`),
      `function typed(sql: typeof import('./author').sql) { ${probe("sql")}; }`,
      `function shadowed({ reexported }: any) { ${probe("reexported")}; }`,
      `function namespaceShadow({ bridge }: any) { ${probe("bridge.braid")}; }`,
    ].join("\n");
    writeFileSync(fileName, source);
    const program = ts.createProgram([fileName], { noLib: true });
    const options = {
      moduleSpecifier: "./author",
      sourceFile: program.getSourceFile(fileName),
      typeChecker: program.getTypeChecker(),
    };
    const discovered = discoverQueries(source, fileName, options);
    assert.deepEqual(discovered.diagnostics, []);
    assert.deepEqual(discovered.queries.map(({ tagName }) => tagName), ["sql", "reexported", "bridge.braid", "star", "local"]);
    const transformed = transformSource(source, fileName, options);
    assert.deepEqual(transformed.diagnostics, []);
    for (const tag of ["importedForeign", "disguised", "bridge.sql", "innocent", "typeOnly", "typeNamespace.sql"])
      assert.ok(transformed.code.includes(probe(tag)), `${tag} must remain a foreign tag`);
    assert.ok(transformed.code.includes(`function typed(sql: typeof import('./author').sql) { ${probe("sql")}; }`));
    assert.ok(transformed.code.includes(`function shadowed({ reexported }: any) { ${probe("reexported")}; }`));
    assert.ok(transformed.code.includes(`function namespaceShadow({ bridge }: any) { ${probe("bridge.braid")}; }`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("facade lowering imports app-resolvable compiler helpers and selects facade dialects exactly", () => {
  const source = `import { sql } from "sqlbraid/tedious"; export const query = sql\`SELECT [Bob's] WHERE id = \${1} /*@braid if \${true}*/ AND active = 1 /*@braid end*/\`;`;
  const emitted = emitSource(source, "facade.ts", { moduleSpecifier: "sqlbraid/tedious" });
  assert.equal(emitted.diagnostics.length, 0);
  assert.match(emitted.outputText, /from "sqlbraid\/compiled"/u);
});

test("recognizes SQLite adapter and facade module specifiers by default", () => {
  const result = discoverQueries(
    [
      'import { sql as better } from "@sqlbraid/sqlite/better-sqlite3";',
      'import { sql as libsql } from "@sqlbraid/sqlite/libsql";',
      'import { sql as facadeBetter } from "sqlbraid/better-sqlite3";',
      'import { sql as facadeLibsql } from "sqlbraid/libsql";',
      "const first = better`SELECT 1`;",
      "const second = libsql`SELECT 2`;",
      "const third = facadeBetter`SELECT 3`;",
      "const fourth = facadeLibsql`SELECT 4`;",
    ].join("\n"),
    "sqlite-adapters.ts",
    {},
  );
  assert.deepEqual(
    result.queries.map((query) => query.tagName),
    ["facadeBetter", "facadeLibsql"],
  );
  assert.deepEqual(
    result.queries.map((query) => query.moduleSpecifier),
    ["sqlbraid/better-sqlite3", "sqlbraid/libsql"],
  );
});

test("preserves source escapes separately from cooked template strings", () => {
  const escaped =
    "import { sql } from '@sqlbraid/template'; const value = true; const query = sql`SELECT E'line\\n' /*@braid if ${value}*/ AND id = ${1} /*@braid end*/`;";
  const result = discoverQueries(escaped, "escaped.ts", { moduleSpecifier: "@sqlbraid/template" });
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].strings[0], "SELECT E'line\n' /*@braid if ");
  assert.equal(result.queries[0].rawStrings[0], "SELECT E'line\\n' /*@braid if ");
});

test("lowered native carriers retain raw source escapes", async () => {
  const escaped =
    "import { sql } from '@sqlbraid/template'; export const query = sql`SELECT E'line\\n' /*@braid if ${true}*/ AND id = ${1} /*@braid end*/`;";
  const emitted = emitSource(escaped, "escaped-runtime.ts", { moduleSpecifier: "@sqlbraid/template" });
  assert.deepEqual(emitted.diagnostics, []);
  const directory = mkdtempSync(join(process.cwd(), ".sqlbraid-escaped-runtime-"));
  try {
    const file = join(directory, "escaped-runtime.mjs");
    writeFileSync(file, emitted.outputText.replace(/\n\/\/#[^\n]*sourceMappingURL[^\n]*/u, ""));
    const module = await import(pathToFileURL(file).href);
    const nativeTemplate = module.query.render().nativeTemplate;
    assert.equal(nativeTemplate[0], "SELECT E'line\n'  AND id = ");
    assert.equal(nativeTemplate.raw[0], "SELECT E'line\\n'  AND id = ");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MariaDB tags preserve native hash comments while finding active directives", () => {
  const native = [
    "import { sql } from '@sqlbraid/mariadb';",
    "const query = sql.rows`SELECT 1 AS id",
    "# /*@braid otherwise*/ is a native comment",
    "/*@braid if ${true}*/ WHERE id = ${1} /*@braid end*/`;",
  ].join("\n");
  const result = discoverQueries(native, "mariadb.ts", {});
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].declaredResultKind, "rows");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(createVirtualOverlay(native, "mariadb.ts", {}).diagnostics, []);
});

test("virtual overlay preserves source and attaches declared query contract", () => {
  const overlay = createVirtualOverlay(source, "fixture.ts", {
    moduleSpecifier: "@sqlbraid/template",
  });
  assert.equal(overlay.sourceText, source);
  assert.deepEqual(overlay.queryTypes[0], {
    range: overlay.queryTypes[0].range,
    rowType: "UserRow",
    resultKind: "rows",
  });
  assert.equal(overlay.diagnostics.length, 0);
});

test("detailed checking separates native, Braid, and lowering-only diagnostics", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlbraid-diagnostic-provenance-"));
  try {
    const moduleSpecifier = "./tag";
    const fileName = join(directory, "fixture.ts");
    writeFileSync(join(directory, "tag.ts"), "export declare const sql: any;\n");
    const source = [
      `import { sql } from '${moduleSpecifier}';`,
      "const native: string = 123;",
      "const malformed = sql`SELECT 1 /*@braid otherwise*/`;",
      "const lowered = sql`SELECT 1 /*@braid if ${true}*/ WHERE id = ${1} /*@braid end*/`;",
    ].join("\n");
    const result = checkSourceDetailed(source, fileName, { moduleSpecifier });
    assert.deepEqual(
      result.nativeTypeScriptDiagnostics.map((diagnostic) => diagnostic.code),
      ["TS2322"],
    );
    assert.ok(result.braidDiagnostics.some((diagnostic) => diagnostic.code === "BRAID_STRUCTURE"));
    assert.ok(result.overlayTypeScriptDiagnostics.some((diagnostic) => diagnostic.code === "TS2322"));
    assert.ok(result.overlayOnlyDiagnostics.some((diagnostic) => diagnostic.code === "TS2307"));
    assert.ok(result.overlayOnlyDiagnostics.some((diagnostic) => diagnostic.code === "TS7006"));
    assert.equal(
      result.overlayOnlyDiagnostics.some((diagnostic) => diagnostic.code === "TS2322"),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("detailed checking matches mapped diagnostics by source range, not repeated snippets", () => {
  const source =
    "import { sql } from '@sqlbraid/template'; /* string */ const comment = 'string'; const first: string = 1; const q=sql`SELECT 1 /*@braid if ${true}*/ WHERE value = ${1} /*@braid end*/`; const second: string = 2; class Base { x = 1; } class Child extends Base { query = sql`SELECT 1 /*@braid if ${true}*/ WHERE value = ${super.x} /*@braid end*/`; }";
  const result = checkSourceDetailed(source, join(tmpdir(), "sqlbraid-repeated-diagnostic.ts"), options);
  const native = result.nativeTypeScriptDiagnostics.filter((diagnostic) => diagnostic.code === "TS2322");
  const overlay = result.overlayTypeScriptDiagnostics.filter((diagnostic) => diagnostic.code === "TS2322");
  assert.equal(native.length, 2);
  assert.deepEqual(
    overlay.map((diagnostic) => diagnostic.range),
    native.map((diagnostic) => diagnostic.range),
  );
  assert.equal(result.nativeTypeScriptDiagnostics.filter((diagnostic) => diagnostic.code === "TS2855").length, 1);
  assert.equal(result.overlayTypeScriptDiagnostics.filter((diagnostic) => diagnostic.code === "TS2855").length, 1);
  assert.equal(
    result.overlayOnlyDiagnostics.some((diagnostic) => diagnostic.code === "TS2855"),
    false,
  );
});

test("discovers explicit rows, command, and call tag helpers", () => {
  const result = discoverQueries(
    "import { sql as dbSql } from '@sqlbraid/template'; import type { RoutineCallResult } from '@sqlbraid/core'; type UserRow = { id: number }; type CallResult = RoutineCallResult<{ readonly ok: boolean }, readonly [{ readonly id: number }], number>; const contract = {}; const rows = dbSql.rows<UserRow>`SELECT id FROM users`; const command = dbSql.command`UPDATE users SET active = true`; const call = dbSql.call<CallResult>`CALL refresh_users()`; const contracted = dbSql.call(contract)`CALL refresh_users()`;",
    "fixture.ts",
    { moduleSpecifier: "@sqlbraid/template" },
  );
  assert.deepEqual(
    result.queries.map((query) => ({
      name: query.tagName,
      kind: query.declaredResultKind,
      type: query.declaredRowType,
    })),
    [
      { name: "dbSql.rows", kind: "rows", type: "UserRow" },
      { name: "dbSql.command", kind: "command", type: undefined },
      { name: "dbSql.call", kind: "call", type: "CallResult" },
      { name: "dbSql.call(contract)", kind: "call", type: undefined },
    ],
  );
});

test("discovers mapped rows through direct, aliased, and namespace imports", () => {
  const mapped = `
    import { sql } from '@sqlbraid/template';
    import { sql as dbSql } from '@sqlbraid/template';
    import * as braid from '@sqlbraid/template';
    declare const UserSchema: import('@sqlbraid/core').StandardSchemaV1<unknown, { id: number }>;
    const direct = sql.rows(UserSchema)\`SELECT id FROM users\`;
    const alias = dbSql.rows(UserSchema)\`SELECT id FROM users\`;
    const namespace = braid.sql.rows(UserSchema)\`SELECT id FROM users\`;
    const unrelated = { rows: (_schema: unknown) => (_strings: TemplateStringsArray) => undefined };
    const ignored = unrelated.rows(UserSchema)\`SELECT id FROM users\`;
  `;
  const result = discoverQueries(mapped, "mapped.ts", { moduleSpecifier: "@sqlbraid/template" });
  assert.equal(result.queries.length, 3);
  for (const query of result.queries) {
    assert.equal(query.declaredResultKind, "rows");
    assert.equal(query.mappedRow, true);
    assert.equal(query.resultSchemaExpression, "UserSchema");
    const schemaRange = query.resultSchemaRange;
    assert.ok(schemaRange);
    assert.equal(mapped.slice(schemaRange.start, schemaRange.end), "UserSchema");
  }
});

// Cold TypeScript programs exceed Vitest's default 5s on the Node floor CI runner.
test("checker discovers mapped rows through a re-export", () => {
  const directory = mkdtempSync(join(process.cwd(), ".sqlbraid-mapped-project-"));
  try {
    writeFileSync(join(directory, "bridge.ts"), "export { sql } from '@sqlbraid/template';\n");
    writeFileSync(
      join(directory, "main.ts"),
      "import { sql } from './bridge.js'; declare const UserSchema: import('@sqlbraid/core').StandardSchemaV1<unknown, { id: number }>; export const query = sql.rows(UserSchema)`SELECT id FROM users`;\n",
    );
    const projectFile = join(directory, "tsconfig.json");
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          baseUrl: ".",
          paths: { "@sqlbraid/*": ["../packages/*/src/index.ts"] },
        },
        include: ["*.ts"],
      }),
    );
    const context = createProjectContext(projectFile);
    const sourceFile = context.program.getSourceFile(join(directory, "main.ts"));
    assert.ok(sourceFile);
    const discovered = discoverQueries(sourceFile.text, sourceFile.fileName, {
      moduleSpecifier: "@sqlbraid/template",
      compilerOptions: context.compilerOptions,
      sourceFile,
      typeChecker: context.checker,
    });
    assert.equal(discovered.queries.length, 1);
    assert.equal(discovered.queries[0].mappedRow, true);
    assert.equal(checkProject(projectFile, { moduleSpecifier: "@sqlbraid/template" }).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test("checker preserves facade identity through re-export when emitting compiled helpers", () => {
  const directory = mkdtempSync(join(process.cwd(), ".sqlbraid-facade-reexport-"));
  try {
    writeFileSync(join(directory, "bridge.ts"), "export { sql } from 'sqlbraid/tedious';\n");
    const source =
      "import { sql } from './bridge.js'; export const query = sql`SELECT 1 /*@braid if ${true}*/ WHERE id = ${1} /*@braid end*/`;\n";
    const fileName = join(directory, "main.ts");
    writeFileSync(fileName, source);
    const projectFile = join(directory, "tsconfig.json");
    writeFileSync(
      projectFile,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          baseUrl: ".",
          paths: { "sqlbraid/*": [join(process.cwd(), "packages/sqlbraid/src/*.ts")] },
        },
        include: ["*.ts"],
      }),
    );
    const context = createProjectContext(projectFile);
    const emitted = emitSource(source, fileName, { compilerOptions: context.compilerOptions });
    assert.deepEqual(emitted.diagnostics, []);
    assert.match(emitted.outputText, /from "sqlbraid\/compiled"/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mapped rows use the Standard Schema output type for downstream checking", () => {
  const mapped = `
    import { sql } from '@sqlbraid/template';
    import type { Database } from '@sqlbraid/core';
    declare const db: Database;
    type UserRow = { id: number };
    declare const UserSchema: import('@sqlbraid/core').StandardSchemaV1<unknown, UserRow>;
    declare const user: { id: number } | null;
    const query = sql.rows(UserSchema)\`SELECT id FROM users /*@braid if \${user !== null}*/ WHERE id = \${user.id} /*@braid end*/\`;
    async function read() {
      const rows = await db.all(query);
      return rows[0].missing;
    }
  `;
  const diagnostics = checkSource(mapped, join(tmpdir(), "sqlbraid-mapped-output.ts"), options);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    ["TS2339"],
  );
});

test("mapped guarded lowering preserves the tag call and evaluates schema once", async () => {
  const source = `
    import { sql } from '@sqlbraid/template';
    export function build(getSchema, observe, enabled) {
      return sql.rows(getSchema())\`SELECT id FROM users /*@braid if \${observe('condition', enabled)}*/ WHERE id = \${observe('value', 1)} /*@braid end*/\`;
    }
  `;
  const emitted = emitSource(source, "mapped-guarded.ts", { moduleSpecifier: "@sqlbraid/template" });
  assert.equal(emitted.diagnostics.length, 0);
  const directory = mkdtempSync(join(process.cwd(), ".sqlbraid-mapped-runtime-"));
  try {
    const file = join(directory, "mapped-guarded.mjs");
    writeFileSync(file, emitted.outputText.replace(/\n\/\/#[^\n]*sourceMappingURL[^\n]*/u, ""));
    const module = await import(pathToFileURL(file).href);
    const schema = { "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) } };
    const events: string[] = [];
    const getSchema = () => {
      events.push("schema");
      return schema;
    };
    const observe = (event: string, value: unknown) => {
      events.push(event);
      return value;
    };
    const query = module.build(getSchema, observe, true);
    assert.deepEqual(events, ["schema", "condition", "value"]);
    assert.equal(query.resultSchema, schema);
    assert.deepEqual(
      query.render().parameters.map(({ value }: { readonly value: unknown }) => value),
      [1],
    );
    events.length = 0;
    const inactive = module.build(getSchema, observe, false);
    assert.deepEqual(events, ["schema", "condition"]);
    assert.equal(inactive.resultSchema, schema);
    assert.deepEqual(inactive.render().parameters, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capture and guarded preserve tag contracts and reject cross-kind arguments", () => {
  const declarations = `
    import { sql, capture, guarded } from '@sqlbraid/template';
    import type { Query, RowQuery, CommandQuery, CommandResult, CallQuery, RoutineCallResult } from '@sqlbraid/core';
    type Row = { id: number };
    type CallResult = RoutineCallResult<{ readonly ok: boolean }, readonly [{ readonly id: number }], number>;
    const rows: RowQuery<Row> = capture(sql.rows<Row>, ['opaque'], () => {});
    const command: CommandQuery = capture<CommandResult, 'command'>(sql.command, ['opaque'], () => {});
    const call: CallQuery<CallResult> = guarded<CallResult, 'call'>(sql.call, ['opaque'], []);
    const unknown: Query<unknown, 'unknown'> = guarded(sql, ['opaque'], []);
    const inferredRows: RowQuery = capture(sql.rows, ['opaque'], () => {});
  `;
  assert.deepEqual(checkSource(declarations, join(tmpdir(), "sqlbraid-capture-contracts.ts"), options), []);
  const invalid = `${declarations}
    capture<Row, 'rows'>(sql.command, ['opaque'], () => {});
    capture<Row, 'call'>(sql.rows, ['opaque'], () => {});
    guarded<Row, 'rows'>(sql.call, ['opaque'], []);
    guarded<Row, 'command'>(sql, ['opaque'], []);
  `;
  const diagnostics = checkSource(invalid, join(tmpdir(), "sqlbraid-capture-mismatches.ts"), options);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    ["TS2345", "TS2345", "TS2345", "TS2345"],
  );
}, 15_000);

test("bare sql rejects generic row shorthand with or without guards", () => {
  const invalid =
    "import {sql} from '@sqlbraid/template'; type Row = {id:number}; const plain=sql<Row>`SELECT 1`; const dynamic=sql<Row>`SELECT 1 /*@braid if ${true}*/ WHERE id=${1} /*@braid end*/`;";
  const diagnostics = checkSource(invalid, join(tmpdir(), "sqlbraid-no-shorthand.ts"), options);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "TS2558"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "TS2635"));
});

test("opaque SQL needs no schema or local SQL grammar and keeps declared contracts", () => {
  const opaque = [
    "SELECT custom_company_function(account_id) AS score FROM reporting_view",
    "SELECT jsonb_path_query(payload, '$.items[*]') FROM events",
    "SELECT value @@ vendor_specific_operator(pattern) FROM custom_table",
    "SELECT proprietary_extension(foo, bar) FROM vendor_relation",
  ];
  const declarations =
    "import {sql} from '@sqlbraid/template'; import type {RowQuery, CommandQuery, CallQuery, Query, RoutineCallResult} from '@sqlbraid/core'; type Row={score:number}; type CallResult=RoutineCallResult<{ok:boolean}, readonly [{id:number}]>; declare const user:{name:string}|null;";
  const queries = opaque.map((text, index) => `const q${index}: RowQuery<Row> = sql.rows<Row>\`${text}\`;`);
  const guarded =
    "const dynamic: RowQuery<Row> = sql.rows<Row>`SELECT proprietary_extension(foo, bar) /*@braid if ${user != null}*/ FROM vendor_relation WHERE name=${user.name} /*@braid end*/`;";
  const kinds =
    "const command:CommandQuery = sql.command`opaque /*@braid if ${true}*/ vendor_command() /*@braid end*/`; const call:CallQuery<CallResult> = sql.call<CallResult>`opaque /*@braid if ${true}*/ vendor_call() /*@braid end*/`; const unknown:Query<unknown,'unknown'> = sql`SELECT id FROM users`;";
  const input = [declarations, ...queries, guarded, kinds].join("\n");
  assert.deepEqual(checkSource(input, join(tmpdir(), "sqlbraid-opaque.ts"), options), []);
  const overlay = createVirtualOverlay(input, "sqlbraid-opaque.ts", options);
  assert.deepEqual(
    overlay.queryTypes.map(({ rowType, resultKind }) => [rowType, resultKind]),
    [
      ...Array.from({ length: 5 }, () => ["Row", "rows"]),
      ['import("@sqlbraid/core").CommandResult', "command"],
      ["CallResult", "call"],
      ["unknown", "unknown"],
    ],
  );
});
