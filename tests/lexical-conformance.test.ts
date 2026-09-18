import assert from "node:assert/strict";
import { test } from "vitest";
import { discoverQueries } from "@sqlbraid/compiler";
import { createStatementBindingDescription, parameterizedSql } from "@sqlbraid/core";
import { createBunSqlDatabase, createBunSqlProvider, type BunSqlReservedClient } from "@sqlbraid/bun-sql";
import { sql as postgres } from "@sqlbraid/postgres";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as mariadb } from "@sqlbraid/mariadb";
import { sql as sqlite } from "@sqlbraid/sqlite";
import { sql as oracle } from "@sqlbraid/oracle";
import { sql as mssql } from "@sqlbraid/mssql";

const dialects = [
  { id: "postgres", sql: postgres },
  { id: "mysql", sql: mysql },
  { id: "mariadb", sql: mariadb },
  { id: "sqlite", sql: sqlite },
  { id: "oracle", sql: oracle },
  { id: "mssql", sql: mssql },
] as const;
type DialectId = (typeof dialects)[number]["id"];
const all: readonly DialectId[] = dialects.map(({ id }) => id);
const mysqlFamily: readonly DialectId[] = ["mysql", "mariadb"];
const standardComments: readonly DialectId[] = ["postgres", "sqlite", "oracle", "mssql"];
const nonPostgres: readonly DialectId[] = ["mysql", "mariadb", "sqlite", "oracle", "mssql"];
const nonNested: readonly DialectId[] = ["mysql", "mariadb", "sqlite", "oracle"];

// Each surface puts its own token between before/after: a bind, directive, or RETURNING.
const fixtures: readonly {
  readonly name: string;
  readonly before: string;
  readonly after: string;
  readonly codeIn: readonly DialectId[];
}[] = [
  { name: "double dash without whitespace", before: "--comment ", after: "\n", codeIn: mysqlFamily },
  { name: "double dash immediately before token", before: "--", after: "\n", codeIn: mysqlFamily },
  { name: "double dash space", before: "-- ", after: "\n", codeIn: [] },
  { name: "double dash tab", before: "--\t", after: "\n", codeIn: [] },
  { name: "double dash control", before: "--\u0001", after: "\n", codeIn: [] },
  { name: "hash", before: "# ", after: "\n", codeIn: standardComments },
  { name: "line feed recovery", before: "-- comment\n", after: "", codeIn: all },
  {
    name: "carriage return recovery",
    before: "-- comment\r",
    after: "\n",
    codeIn: ["postgres", "mysql", "mariadb", "oracle", "mssql"],
  },
  { name: "CRLF recovery", before: "-- comment\r\n", after: "", codeIn: all },
  { name: "comment at end of input", before: "-- ", after: "", codeIn: [] },
  { name: "single quote", before: "'-- # ", after: "'", codeIn: [] },
  { name: "doubled single quote", before: "'a''-- # ", after: "'", codeIn: [] },
  { name: "double quote", before: '"-- # ', after: '"', codeIn: [] },
  { name: "doubled double quote", before: '"a""-- # ', after: '"', codeIn: [] },
  { name: "quoted comment markers followed by code", before: "'-- #' ", after: "", codeIn: all },
  { name: "backtick identifier", before: "` ", after: " `", codeIn: ["postgres", "oracle", "mssql"] },
  { name: "bracket identifier", before: "[ ", after: " ]", codeIn: ["postgres", "mysql", "mariadb", "oracle"] },
  { name: "dollar quote", before: "$$ ", after: " $$", codeIn: nonPostgres },
  { name: "tagged dollar quote", before: "$tag$ ", after: " $tag$", codeIn: nonPostgres },
  {
    name: "Oracle q quote with apostrophe",
    before: "q'[ ' ",
    after: " ]'",
    codeIn: ["postgres", "mysql", "mariadb", "sqlite", "mssql"],
  },
  { name: "block comment", before: "/* -- # ", after: " */", codeIn: [] },
  { name: "block comment recovery", before: "/* -- # */ ", after: "", codeIn: all },
  { name: "nested block comment", before: "/* outer /* inner */ ", after: " */", codeIn: nonNested },
];

function strings(parts: readonly string[]): TemplateStringsArray {
  return Object.assign([...parts], { raw: [...parts] });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sourcePart(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${").replaceAll("\r", "\\r");
}

function commandClient(seenValues: unknown[][] = []): BunSqlReservedClient {
  const client = ((_strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    seenValues.push([...values]);
    return Promise.resolve(Object.assign([], { command: "UPDATE", affectedRows: 0, count: 0 }));
  }) as unknown as BunSqlReservedClient;
  client.unsafe = async () => {
    throw new Error("Lexical fixtures must use native value templates.");
  };
  client.release = () => undefined;
  client.reserve = async () => client;
  return client;
}

for (const { id, sql } of dialects) {
  test(`dialect lexical runtime ${id}: comments, directives, interpolation, quotes and recovery`, () => {
    for (const fixture of fixtures) {
      // Oracle's alternative quote is deliberately not valid ordinary quoting elsewhere.
      if (fixture.name.startsWith("Oracle") && id !== "oracle") continue;
      const inCode = fixture.codeIn.includes(id);
      const parts = [`UPDATE t SET value = 0 ${fixture.before}`, fixture.after];
      const render = () => sql.command(strings(parts), "sentinel").render();
      if (inCode) {
        const statement = render();
        assert.deepEqual(
          statement.parameters.map(({ value }) => value),
          ["sentinel"],
          fixture.name,
        );
        assert.equal(
          parameterizedSql(statement, () => "?"),
          parts.join("?"),
          fixture.name,
        );
      } else {
        assert.throws(render, hasCode("BRAID_HOLE_CONTEXT"), fixture.name);
      }
      const directiveText = `${parts[0]}/*@braid end*/${parts[1]}`;
      const directive = () => sql.command(strings([directiveText])).render();
      if (inCode) assert.throws(directive, hasCode("BRAID_STRUCTURE"), fixture.name);
      else
        assert.equal(
          parameterizedSql(directive(), () => "?"),
          directiveText,
          fixture.name,
        );
    }
  });

  test(`dialect lexical compiler ${id}: mirrored profiles match runtime fixtures`, () => {
    for (const fixture of fixtures) {
      if (fixture.name.startsWith("Oracle") && id !== "oracle") continue;
      const inCode = fixture.codeIn.includes(id);
      const prefix = sourcePart(`UPDATE t SET value = 0 ${fixture.before}`);
      const suffix = sourcePart(fixture.after);
      for (const [token, expectedCode] of [
        ["${1}", inCode ? undefined : "BRAID_HOLE_CONTEXT"],
        ["/*@braid end*/", inCode ? "BRAID_STRUCTURE" : undefined],
      ] as const) {
        const result = discoverQueries(
          `import { sql } from '@sqlbraid/${id}'; const query = sql.command\`${prefix}${token}${suffix}\`;`,
          `lexical-${id}.ts`,
          {},
        );
        assert.deepEqual(
          result.diagnostics.map(({ code }) => code),
          expectedCode ? [expectedCode] : [],
          fixture.name,
        );
        if (expectedCode === undefined) assert.equal(result.queries.length, 1, fixture.name);
      }
    }
  });

  if (id === "oracle" || id === "mssql") continue;
  test(`dialect lexical Bun ${id}: RETURNING uses the shared dialect fixtures`, async () => {
    const db = createBunSqlDatabase(commandClient(), { dialect: id });
    for (const fixture of fixtures) {
      if (fixture.name.startsWith("Oracle")) continue;
      const text = `UPDATE t SET value = 0 ${fixture.before}RETURNING${fixture.after}`;
      const execute = (): Promise<import("@sqlbraid/core").CommandExecutionResult> =>
        db.execute(sql.command(strings([text])));
      if (fixture.codeIn.includes(id)) {
        await assert.rejects(execute, hasCode("BRAID_RESULT_KIND_AMBIGUOUS"), fixture.name);
      } else {
        assert.equal((await execute()).command.affectedRows, 0, fixture.name);
      }
    }
    for (const name of ["_RETURNING", "returning_value", "éRETURNING"]) {
      assert.equal((await db.execute(sql.command(strings([`UPDATE t SET ${name} = 0`])))).command.affectedRows, 0);
    }
    assert.equal(
      (await db.execute(sql.command(strings(["UPDATE t SET RET", "URNING = 0"]), "bound"))).command.affectedRows,
      0,
    );
    if (id === "mysql" || id === "mariadb") {
      await assert.rejects(
        () => db.execute(sql.command(strings(["UPDATE t SET value = 0 --", " RETURNING"]), 1)),
        hasCode("BRAID_RESULT_KIND_AMBIGUOUS"),
      );
    }
  });
}

for (const { id, sql } of dialects.filter((dialect) => dialect.id === "mysql" || dialect.id === "mariadb")) {
  test(`dialect lexical trim ${id}: WHERE and SET preserve arithmetic and native comments`, () => {
    assert.equal(
      parameterizedSql(
        sql`SELECT 1 /*@braid where*/ --1 = 1
/*@braid end*/`.render(),
        () => "?",
      ),
      "SELECT 1 WHERE --1 = 1",
    );
    assert.equal(
      parameterizedSql(
        sql`UPDATE t /*@braid set*/ value = --1,
/*@braid end*/`.render(),
        () => "?",
      ),
      "UPDATE t SET value = --1",
    );
    assert.equal(
      parameterizedSql(
        sql`UPDATE t /*@braid set*/ value = ${2}, other = --1,
/*@braid end*/`.render(),
        () => "?",
      ),
      "UPDATE t SET value = ?, other = --1",
    );
    assert.equal(
      parameterizedSql(
        sql`SELECT 1 /*@braid where*/ # only a comment
/*@braid end*/`.render(),
        () => "?",
      ),
      "SELECT 1 # only a comment\n",
    );
    assert.equal(
      parameterizedSql(
        sql`SELECT 1 /*@braid where*/ AND value = ${2} # keep the newline
/*@braid end*/ ORDER BY value`.render(),
        () => "?",
      ),
      "SELECT 1 WHERE value = ? # keep the newline\n ORDER BY value",
    );
  });

  test(`dialect lexical ${id}: a backslash cannot hide interpolation inside a string`, () => {
    assert.throws(
      () => sql.command(strings(["UPDATE t SET value = 'prefix\\", "'"]), "unsafe").render(),
      hasCode("BRAID_HOLE_CONTEXT"),
    );
  });
}

const diagnosticStrings = ["'", "\\", "\\'", "\n\r\t\b\f\0\u001a", "", "한글 café 😀", "\ud800"];
for (const id of ["mysql", "mariadb"] as const) {
  const sql = id === "mysql" ? mysql : mariadb;
  test(`diagnostic strings ${id}: core and Bun preserve values without claiming SQL-mode literal fidelity`, async () => {
    const values: unknown[][] = [];
    const client = commandClient(values);
    const provider = createBunSqlProvider(client, { dialect: id });
    const db = createBunSqlDatabase(client, { dialect: id });
    for (const value of diagnosticStrings) {
      const query = sql.command`UPDATE t SET value = ${value}`;
      const statement = query.render();
      const context = { dialectId: id, requestedReuse: "auto" } as const;
      const descriptions = [
        createStatementBindingDescription(statement, context, {
          adapterId: "diagnostic",
          transport: "text-positional",
          placeholder: () => "?",
          reuse: { effective: "simple", owner: "driver" },
        }),
        provider.statementBinding.describe(statement, context),
      ];
      for (const description of descriptions) {
        assert.equal(description.literalizedSql().text, "UPDATE t SET value = [REDACTED]");
        const inline = description.literalizedSql({ values: "inline" });
        const marker = inline.text.slice("UPDATE t SET value = ".length);
        assert.match(marker, /^\[string [\s\S]*\]$/u);
        assert.equal(JSON.parse(marker.slice("[string ".length, -1)), value);
        assert.equal(inline.complete, true);
      }
      await db.execute(query);
    }
    assert.deepEqual(
      values,
      diagnosticStrings.map((value) => [value]),
    );
  });
}
