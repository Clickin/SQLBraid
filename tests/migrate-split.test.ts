import assert from "node:assert/strict";
import { test } from "vitest";
import { dialect as postgres } from "@sqlbraid/postgres";
import { dialect as mysql } from "@sqlbraid/mysql";
import { dialect as mariadb } from "@sqlbraid/mariadb";
import { dialect as sqlite } from "@sqlbraid/sqlite";
import { dialect as oracle } from "@sqlbraid/oracle";
import { dialect as mssql } from "@sqlbraid/mssql";
import { splitMigrationSql } from "../packages/migrate/src/split.js";

const sourceError = { code: "BRAID_MIGRATE_SOURCE" };

test("migration splitting honors PostgreSQL dollar bodies, nested comments, and escaped strings", () => {
  const body = "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM ';'; END; $body$ LANGUAGE plpgsql";
  assert.deepEqual(splitMigrationSql(`${body}; SELECT 2;`, postgres).statements, [body, "SELECT 2"]);
  assert.deepEqual(
    splitMigrationSql("/* outer ; /* inner ; */ */ SELECT E'it\\'s;fine'; SELECT \"a;\";", postgres).statements,
    ["/* outer ; /* inner ; */ */ SELECT E'it\\'s;fine'", 'SELECT "a;"'],
  );
  assert.deepEqual(splitMigrationSql("SELECT $$line\nGO\n/\nDELIMITER //\n;$$; SELECT 2", postgres).statements, [
    "SELECT $$line\nGO\n/\nDELIMITER //\n;$$",
    "SELECT 2",
  ]);
});

test("PostgreSQL BEGIN ATOMIC routine bodies stay one statement", () => {
  const fn = "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END";
  const procedure = "CREATE OR REPLACE PROCEDURE p() LANGUAGE sql BEGIN ATOMIC INSERT INTO t VALUES (1); END";
  assert.deepEqual(splitMigrationSql(`${fn}; ${procedure}; SELECT 3;`, postgres).statements, [
    fn,
    procedure,
    "SELECT 3",
  ]);
});

test("PostgreSQL atomic bodies ignore quoted tokens and balance CASE endings", () => {
  const fn =
    "create function f() returns text language sql begin /* ; END */ atomic SELECT CASE WHEN true THEN CASE WHEN false THEN 'END;' ELSE $$BEGIN ATOMIC;$$ END ELSE \"END\" END; SELECT 'done'; end";
  assert.deepEqual(splitMigrationSql(`${fn}; BEGIN; SELECT 3; COMMIT;`, postgres).statements, [
    fn,
    "BEGIN",
    "SELECT 3",
    "COMMIT",
  ]);
  assert.throws(
    () =>
      splitMigrationSql(
        "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 ELSE 2 END;",
        postgres,
      ),
    sourceError,
  );
});

for (const dialect of [mysql, mariadb]) {
  test(`${dialect.id} DELIMITER preserves routines and resets normal splitting`, () => {
    const routine = "CREATE PROCEDURE p() BEGIN SELECT ';//'; SELECT `a;b`; END";
    assert.deepEqual(splitMigrationSql(`DELIMITER //\n${routine}//\nDELIMITER ;\nSELECT 2;`, dialect).statements, [
      routine,
      "SELECT 2",
    ]);
    assert.deepEqual(
      splitMigrationSql(
        "DELIMITER $$\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.x = 1; END$$",
        dialect,
      ).statements,
      ["CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.x = 1; END"],
    );
    assert.deepEqual(splitMigrationSql("SELECT 1--2; SELECT 3; # ;\nSELECT 4;", dialect).statements, [
      "SELECT 1--2",
      "SELECT 3",
      "# ;\nSELECT 4",
    ]);
  });
  test(`${dialect.id} rejects unsupported or incomplete separator commands`, () => {
    for (const source of [
      "DELIMITER // -- comment\nSELECT 1//",
      "DELIMITER '--'\nSELECT 1",
      "SELECT 1\nDELIMITER //",
      "CREATE PROCEDURE p() BEGIN SELECT 1; END;",
      "DELIMITER //\nSELECT 1;",
    ]) {
      assert.throws(() => splitMigrationSql(source, dialect), sourceError);
    }
  });
}

test("SQLite trigger CASE expressions do not close the BEGIN body", () => {
  const trigger =
    "CREATE TEMP TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO log VALUES (CASE WHEN NEW.n > 1 THEN CASE WHEN NEW.n > 2 THEN 3 ELSE 2 END ELSE 0 END); UPDATE x SET n = 2; END";
  assert.deepEqual(splitMigrationSql(`${trigger}; SELECT ';';`, sqlite).statements, [trigger, "SELECT ';'"]);
  assert.deepEqual(splitMigrationSql("BEGIN; UPDATE x SET n = 1; COMMIT;", sqlite).statements, [
    "BEGIN",
    "UPDATE x SET n = 1",
    "COMMIT",
  ]);
  assert.throws(
    () => splitMigrationSql("CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 1 THEN 2 END;", sqlite),
    sourceError,
  );
});

test("SQLite uses its LF-only line-comment terminator", () => {
  assert.deepEqual(splitMigrationSql("-- comment\rSELECT 1;\nSELECT 2;", sqlite).statements, [
    "-- comment\rSELECT 1;\nSELECT 2",
  ]);
});

test("Oracle slash terminates PL/SQL without reaching the driver", () => {
  const block = "DECLARE n NUMBER; BEGIN n := 1; DBMS_OUTPUT.PUT_LINE(q'[it's; fine]'); END;";
  const procedure = "CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;";
  assert.deepEqual(splitMigrationSql(`${block}\n/\n${procedure}\n/\nCREATE TABLE t (n NUMBER);`, oracle).statements, [
    block,
    procedure,
    "CREATE TABLE t (n NUMBER)",
  ]);
  assert.deepEqual(splitMigrationSql("SELECT q'{a;b}' FROM dual; SELECT q'!a;b!' FROM dual;", oracle).statements, [
    "SELECT q'{a;b}' FROM dual",
    "SELECT q'!a;b!' FROM dual",
  ]);
  for (const source of ["BEGIN NULL; END;", "BEGIN NULL; END;\n/ -- comment", "SELECT 1 FROM dual;\n/"]) {
    assert.throws(() => splitMigrationSql(source, oracle), sourceError);
  }
});

test("MSSQL GO splits batches, not semicolons, quoted text, or comments", () => {
  const batch = "CREATE PROCEDURE p AS BEGIN SELECT [a;b]; SELECT 'GO'; END;";
  assert.deepEqual(
    splitMigrationSql(`${batch}\nGO\nSELECT '\nGO\n';\nGO -- end\n/* GO */ SELECT 3;`, mssql).statements,
    [batch, "SELECT '\nGO\n';", "/* GO */ SELECT 3;"],
  );
  for (const separator of ["GO 2", "GO;", "GO /* comment */", "GO/*comment*/"]) {
    assert.throws(() => splitMigrationSql(`SELECT 1;\n${separator}\nSELECT 2;`, mssql), sourceError);
  }
});

test("migration directives override splitting and transaction independently", () => {
  const source =
    "-- @braid-migrate split=none\n-- @braid-migrate transaction=off\nCREATE PROCEDURE p() BEGIN SELECT 1; END;";
  assert.deepEqual(splitMigrationSql(source, mysql), { statements: [source], transaction: false });
  assert.equal(splitMigrationSql("# heading\n-- @braid-migrate transaction=off\nSELECT 1;", mysql).transaction, false);
  assert.deepEqual(splitMigrationSql("-- @braid-migrate transaction=off\nSELECT 1; SELECT 2;", postgres), {
    statements: ["-- @braid-migrate transaction=off\nSELECT 1", "SELECT 2"],
    transaction: false,
  });
  assert.throws(() => splitMigrationSql("-- @braid-migrate split=guess\nSELECT 1", postgres), sourceError);
  assert.throws(
    () => splitMigrationSql("SELECT 1;\n-- @braid-migrate transaction=off\nSELECT 2;", postgres),
    sourceError,
  );
});

test("comment-only files and empty statements are no-ops; unfinished tokens fail", () => {
  assert.deepEqual(splitMigrationSql("-- only comment\n/* another */ ; ;", postgres).statements, []);
  for (const source of ["SELECT 'unfinished", "/* unfinished", "SELECT $tag$unfinished", 'SELECT "unfinished']) {
    assert.throws(() => splitMigrationSql(source, postgres), sourceError);
  }
});

test("PostgreSQL multi-action rules keep their parenthesized action list as one statement", () => {
  const rule = "CREATE RULE r AS ON INSERT TO t DO ALSO (INSERT INTO a VALUES (1); INSERT INTO b VALUES (')'));";
  const replace = "create or replace rule s as on update to t do instead (update a set n = 1; notify t)";
  assert.deepEqual(splitMigrationSql(`${rule}\n${replace}; SELECT (1);`, postgres).statements, [
    rule.slice(0, -1),
    replace,
    "SELECT (1)",
  ]);
  assert.throws(() => splitMigrationSql("CREATE RULE r AS ON INSERT TO t DO ALSO (SELECT 1;", postgres), sourceError);
});

test("split=none sends exactly one PostgreSQL or SQLite statement", () => {
  for (const dialect of [postgres, sqlite]) {
    assert.throws(
      () => splitMigrationSql("-- @braid-migrate split=none\nCREATE TABLE a (x int); CREATE TABLE b (y int);", dialect),
      /exactly one statement/u,
    );
    assert.deepEqual(splitMigrationSql("-- @braid-migrate split=none\nCREATE TABLE a (x int);", dialect).statements, [
      "-- @braid-migrate split=none\nCREATE TABLE a (x int);",
    ]);
  }
  const trigger = "CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (1); INSERT INTO b VALUES (2); END;";
  assert.equal(splitMigrationSql(`-- @braid-migrate split=none\n${trigger}`, sqlite).statements.length, 1);
  const batch = "-- @braid-migrate split=none\nSELECT 1; SELECT 2;";
  assert.deepEqual(splitMigrationSql(batch, mssql).statements, [batch]);
});

test("split=none files without significant SQL are no-ops", () => {
  for (const dialect of [postgres, mysql, mariadb, sqlite, oracle, mssql]) {
    assert.deepEqual(splitMigrationSql("-- @braid-migrate split=none\n-- note\n/* more */\n", dialect).statements, []);
  }
  const versioned = "-- @braid-migrate split=none\n/*!40101 SET NAMES utf8mb4 */";
  assert.deepEqual(splitMigrationSql(versioned, mysql).statements, [versioned]);
});

test("unsupported directive forms are rejected, not ignored", () => {
  const forms: [string, typeof postgres][] = [
    ["# @braid-migrate split=none\nSELECT 1;", mysql],
    ["#@braid-migrate transaction=off\nSELECT 1;", mariadb],
    ["--@braid-migrate split=none\nSELECT 1;", mysql],
    ["--@braid-migrate split=none\nSELECT 1;", postgres],
    ["/* @braid-migrate split=none */\nSELECT 1;", sqlite],
    ["-- note about @braid-migrate\nSELECT 1;", postgres],
  ];
  for (const [source, dialect] of forms) assert.throws(() => splitMigrationSql(source, dialect), sourceError);
  assert.equal(splitMigrationSql("--\t@braid-migrate transaction=off\nSELECT 1;", mysql).transaction, false);
});
