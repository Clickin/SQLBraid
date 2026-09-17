import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import oracledb from "oracledb";
import { test } from "vitest";
import { UnsupportedFeatureError } from "@sqlbraid/core";
import { oracleParameter, sql, typePolicy } from "@sqlbraid/oracle";
import {
  createOracledbDatabase,
  createOracledbExecutor,
  createOracledbPoolDatabase,
  createOracledbPoolProvider,
  oracledbStatementBinding,
  type OracleExecuteOptionsLike,
} from "@sqlbraid/oracle/oracledb";
import { createOracleInspector } from "@sqlbraid/oracle/inspector";
import { containsError } from "./contracts/resources.faults.js";

test("Oracle renders positional binds and doubled quoted identifiers", () => {
  const rendered = sql`SELECT ${1}, ${2}`.render();
  assert.deepEqual(rendered.segments, ["SELECT ", ", ", ""]);
  assert.deepEqual(rendered.parameters, [
    { value: 1, interpolation: 0 },
    { value: 2, interpolation: 1 },
  ]);
  const binding = oracledbStatementBinding.describe(rendered, { dialectId: "oracle", requestedReuse: "auto" });
  assert.equal(binding.parameterizedSql, "SELECT :1, :2");
  assert.equal(sql`SELECT ${sql.ident('A"B')}`.render().segments[0], 'SELECT "A""B"');
});

test("Oracle lexical scanner preserves q literals, comments, and quoted text", () => {
  const query = sql`SELECT q'[/*@braid if \${false}*/hidden/*@braid end*/]' AS marker, '/*@braid end*/' AS quoted /*@braid where*/ AND id = ${7} /*@braid end*/`;
  const rendered = query.render();
  assert.equal(
    oracledbStatementBinding.describe(rendered, { dialectId: "oracle", requestedReuse: "auto" }).parameterizedSql,
    "SELECT q'[/*@braid if ${false}*/hidden/*@braid end*/]' AS marker, '/*@braid end*/' AS quoted WHERE id = :1",
  );
});

test("Oracle inspector keeps catalog-qualified object and domain type evidence", async () => {
  const statements: string[] = [];
  const connection = {
    async execute(statement: string) {
      statements.push(statement);
      if (statement.includes("v$version")) return { rows: [{ VERSION: "Oracle Database 23c" }] };
      if (statement.includes("all_users")) return { rows: [{ USERNAME: "APP" }] };
      if (statement.includes("all_tables"))
        return { rows: [{ OWNER: "APP", RELATION_NAME: "UDT_TABLE", RELATION_KIND: "TABLE" }] };
      if (statement.includes("all_tab_cols"))
        return {
          rows: [
            {
              OWNER: "APP",
              TABLE_NAME: "UDT_TABLE",
              COLUMN_NAME: "PAYLOAD",
              COLUMN_ID: 1,
              DATA_TYPE: "UDT_OBJECT",
              DATA_TYPE_OWNER: "TYPES",
              NULLABLE: "Y",
            },
            {
              OWNER: "APP",
              TABLE_NAME: "UDT_TABLE",
              COLUMN_NAME: "DOMAIN_VALUE",
              COLUMN_ID: 2,
              DATA_TYPE: "VARCHAR2",
              DOMAIN_OWNER: "APP",
              DOMAIN_NAME: "CUSTOM_DOMAIN",
              NULLABLE: "Y",
            },
            {
              OWNER: "APP",
              TABLE_NAME: "UDT_TABLE",
              COLUMN_NAME: "COUNT_VALUE",
              COLUMN_ID: 3,
              DATA_TYPE: "NUMBER",
              NULLABLE: "Y",
            },
            {
              OWNER: "APP",
              TABLE_NAME: "UDT_TABLE",
              COLUMN_NAME: "UNKNOWN_VALUE",
              COLUMN_ID: 4,
              DATA_TYPE: null,
              NULLABLE: "Y",
            },
          ],
        };
      if (statement.includes("all_procedures"))
        return {
          rows: [
            { OWNER: "APP", OBJECT_NAME: "USE_UDT", OBJECT_TYPE: "PROCEDURE", SUBPROGRAM_ID: 1 },
            { OWNER: "APP", OBJECT_NAME: "constructor", OBJECT_TYPE: "PROCEDURE", SUBPROGRAM_ID: 2 },
            { OWNER: "APP", OBJECT_NAME: "toString", OBJECT_TYPE: "PROCEDURE", SUBPROGRAM_ID: 3 },
            { OWNER: "APP", OBJECT_NAME: "__proto__", OBJECT_TYPE: "PROCEDURE", SUBPROGRAM_ID: 4 },
          ],
        };
      if (statement.includes("all_arguments"))
        return {
          rows: [
            {
              OWNER: "APP",
              OBJECT_NAME: "USE_UDT",
              SUBPROGRAM_ID: 1,
              ARGUMENT_NAME: "VALUE",
              POSITION: 1,
              SEQUENCE: 1,
              IN_OUT: "IN",
              DATA_TYPE: "OBJECT",
              TYPE_OWNER: "TYPES",
              TYPE_NAME: "UDT_OBJECT",
            },
          ],
        };
      throw new Error(`Unexpected Oracle catalog query: ${statement}`);
    },
  };
  const snapshot = await createOracleInspector(connection).inspect();
  const relation = snapshot.relations["APP.UDT_TABLE"];
  assert.ok(relation);
  assert.deepEqual(
    relation.columns.map((column) => column.type),
    ["TYPES.UDT_OBJECT", "APP.CUSTOM_DOMAIN", "NUMBER", "UNKNOWN"],
  );
  assert.deepEqual(snapshot.types["TYPES.UDT_OBJECT"], {
    identity: "TYPES.UDT_OBJECT",
    name: "UDT_OBJECT",
    kind: "composite",
  });
  assert.deepEqual(snapshot.types["APP.CUSTOM_DOMAIN"], {
    identity: "APP.CUSTOM_DOMAIN",
    name: "CUSTOM_DOMAIN",
    kind: "domain",
  });
  assert.equal(Object.hasOwn(snapshot.types, "SYS.NUMBER"), false);
  const routine = snapshot.routines.USE_UDT?.[0];
  assert.equal(routine?.arguments[0]?.type, "TYPES.UDT_OBJECT");
  assert.equal(snapshot.routines.constructor?.length, 1);
  assert.equal(snapshot.routines.toString?.length, 1);
  assert.equal(snapshot.routines.__proto__?.length, 1);
  assert.equal(statements.find((statement) => statement.includes("all_tab_cols"))?.includes("data_type_owner"), true);
});

test("Oracle inspector keeps package and procedure identity segments distinct", async () => {
  const connection = {
    async execute(statement: string) {
      if (statement.includes("v$version")) return { rows: [{ VERSION: "Oracle Database 23c" }] };
      if (statement.includes("all_users")) return { rows: [] };
      if (statement.includes("all_tables")) return { rows: [] };
      if (statement.includes("all_tab_cols")) return { rows: [] };
      if (statement.includes("all_procedures"))
        return {
          rows: [
            {
              OWNER: "APP",
              OBJECT_NAME: "A.B",
              PROCEDURE_NAME: "C",
              OBJECT_TYPE: "FUNCTION",
              OBJECT_ID: 1,
              SUBPROGRAM_ID: 1,
            },
            {
              OWNER: "APP",
              OBJECT_NAME: "A",
              PROCEDURE_NAME: "B.C",
              OBJECT_TYPE: "FUNCTION",
              OBJECT_ID: 2,
              SUBPROGRAM_ID: 1,
            },
          ],
        };
      if (statement.includes("all_arguments")) return { rows: [] };
      throw new Error(`Unexpected Oracle catalog query: ${statement}`);
    },
  };
  const snapshot = await createOracleInspector(connection).inspect();
  assert.equal(snapshot.routines.C?.length, 1);
  assert.equal(snapshot.routines["B.C"]?.length, 1);
  assert.ok(snapshot.routines.C?.[0]?.identity !== snapshot.routines["B.C"]?.[0]?.identity);
  assert.equal(snapshot.routines.C?.[0]?.identity, "APP.A\\.B.C");
  assert.equal(snapshot.routines["B.C"]?.[0]?.identity, "APP.A.B\\.C");
});

test("Oracle parameter hints are aligned and NUMBER policy stays exact", () => {
  const query = sql`SELECT ${sql.bind(null, oracleParameter.number(38, -2))}, ${sql.bind("Ada", oracleParameter.nvarchar2(40))}`;
  const rendered = query.render();
  assert.deepEqual(
    rendered.parameters.map((parameter) => parameter.value),
    [null, "Ada"],
  );
  assert.deepEqual(
    rendered.parameters.map((parameter) => parameter.hint),
    [
      { databaseType: "NUMBER", precision: 38, scale: -2 },
      { databaseType: "NVARCHAR2", length: 40 },
    ],
  );
  assert.equal(typePolicy.decode("NUMBER", "123456789012345678901234567890.12"), "123456789012345678901234567890.12");
  assert.throws(() => typePolicy.encode("NUMBER", Number.NaN), /finite/u);
});

test("Oracle rejects custom exact-number decimal text for IN binds before execution", async () => {
  let executions = 0;
  const connection = {
    async execute() {
      executions += 1;
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, {
    typePolicy: {
      ...typePolicy,
      encode: () => "1.25",
    },
  });
  await assert.rejects(
    async () => executor.query(sql`SELECT ${sql.bind(1, oracleParameter.number())}`.render()),
    (error: unknown) =>
      error instanceof UnsupportedFeatureError &&
      error.feature === "statement.bind-hint" &&
      error.code === "BRAID_BIND_HINT_UNSUPPORTED",
  );
  assert.equal(executions, 0);
});

test("Oracle adapter honors hints, rejects untyped null, and closes an aborted ResultSet", async () => {
  const calls: { readonly sql: string; readonly binds?: readonly unknown[] }[] = [];
  let closed = 0;
  let breaks = 0;
  let rowIndex = 0;
  const driver = {
    BIND_IN: 1,
    OUT_FORMAT_OBJECT: 2,
    DB_TYPE_NUMBER: 3,
    DB_TYPE_VARCHAR: 4,
  };
  const connection = {
    async execute(text: string, binds?: readonly unknown[], options?: { readonly resultSet?: boolean }) {
      calls.push({ sql: text, binds });
      if (text === "SELECT :1" && options?.resultSet !== true)
        return { rows: [{ VALUE: "7" }], metaData: [{ name: "VALUE", dbTypeName: "NUMBER" }] };
      return {
        resultSet: {
          async getRow() {
            rowIndex += 1;
            return rowIndex === 1 ? { VALUE: "1" } : null;
          },
          async close() {
            closed += 1;
          },
        },
        metaData: [{ name: "VALUE", dbTypeName: "NUMBER" }],
      };
    },
    async break() {
      breaks += 1;
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection, { driver });
  const rendered = sql`SELECT ${sql.bind(7, oracleParameter.number())}`.render();
  const result = await executor.query(rendered);
  assert.deepEqual(result, { kind: "rows", rows: [{ VALUE: "7" }], rowCount: 1 });
  assert.deepEqual(calls[0]?.binds, [{ dir: 1, val: 7, type: 3 }]);
  await assert.rejects(async () => executor.query(sql`SELECT ${null}`.render()), /BRAID_BIND_TYPE_REQUIRED/u);
  const callsBeforeUnsupportedFacet = calls.length;
  await assert.rejects(
    async () => executor.query(sql`SELECT ${sql.bind(7, oracleParameter.number(38, 2))}`.render()),
    /BRAID_BIND_HINT_UNSUPPORTED/u,
  );
  assert.equal(calls.length, callsBeforeUnsupportedFacet);
  const controller = new AbortController();
  const iterator = executor.stream!(sql`SELECT ${1}`.render(), undefined, { signal: controller.signal })[
    Symbol.asyncIterator
  ]();
  assert.deepEqual(await iterator.next(), { done: false, value: { VALUE: "1" } });
  controller.abort();
  await assert.rejects(() => iterator.next());
  assert.equal(closed, 1);
  assert.equal(breaks, 0);
});

test("Oracle streaming closes async iterators before result sets on abort", async () => {
  const order: string[] = [];
  let yielded = false;
  const resultIterator: AsyncIterator<{ readonly VALUE: string }> = {
    async next() {
      if (yielded) return { done: true, value: undefined };
      yielded = true;
      return { done: false, value: { VALUE: "1" } };
    },
    async return() {
      order.push("iterator-return");
      return { done: true, value: undefined };
    },
  };
  const connection = {
    async execute() {
      return {
        resultSet: {
          [Symbol.asyncIterator]() {
            return resultIterator;
          },
          async close() {
            order.push("result-set-close");
          },
        },
        metaData: [{ name: "VALUE", dbTypeName: "VARCHAR2" }],
      };
    },
    async break() {},
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection);
  const controller = new AbortController();
  const reason = new Error("oracle async iterator abort");
  const iterator = executor.stream!(sql`SELECT 1`.render(), undefined, { signal: controller.signal })[
    Symbol.asyncIterator
  ]();
  assert.deepEqual(await iterator.next(), { done: false, value: { VALUE: "1" } });
  controller.abort(reason);
  await assert.rejects(
    () => iterator.next(),
    (error: unknown) => error === reason,
  );
  assert.deepEqual(order, ["iterator-return", "result-set-close"]);
});

test("Oracle streaming breaks an active native row fetch", async () => {
  let releaseRow: ((value: unknown) => void) | undefined;
  let breaks = 0;
  let closed = 0;
  const started = Promise.withResolvers<void>();
  const connection = {
    async execute() {
      return {
        resultSet: {
          async getRow() {
            started.resolve();
            return new Promise((resolve) => {
              releaseRow = resolve;
            });
          },
          async close() {
            closed += 1;
          },
        },
        metaData: [{ name: "VALUE", dbTypeName: "VARCHAR2" }],
      };
    },
    async break() {
      breaks += 1;
      releaseRow?.(null);
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection);
  const controller = new AbortController();
  const reason = new Error("oracle active row abort");
  const pending = executor.stream!(sql`SELECT 1`.render(), undefined, { signal: controller.signal })
    [Symbol.asyncIterator]()
    .next();
  await started.promise;
  assert.ok(releaseRow);
  controller.abort(reason);
  assert.equal(breaks, 1);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(closed, 1);
});

test("Oracle numeric result transport keeps NUMBER exact and BINARY_FLOAT approximate", async () => {
  let mode: "number" | "float" = "number";
  const connection = {
    async execute() {
      return mode === "number"
        ? { rows: [{ VALUE: "12345678901234567890.12" }], metaData: [{ name: "VALUE", dbTypeName: "NUMBER" }] }
        : { rows: [{ VALUE: 1.25 }], metaData: [{ name: "VALUE", dbTypeName: "BINARY_FLOAT" }] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection);
  assert.deepEqual(await executor.query(sql.rows`SELECT value FROM t`.render()), {
    kind: "rows",
    rows: [{ VALUE: "12345678901234567890.12" }],
    rowCount: 1,
  });
  mode = "float";
  assert.deepEqual(await executor.query(sql.rows`SELECT value FROM t`.render()), {
    kind: "rows",
    rows: [{ VALUE: 1.25 }],
    rowCount: 1,
  });
  mode = "number";
  const lossyConnection = {
    ...connection,
    async execute() {
      return { rows: [{ VALUE: 1.25 }], metaData: [{ name: "VALUE", dbTypeName: "NUMBER" }] };
    },
  };
  await assert.rejects(
    async () => createOracledbExecutor(lossyConnection).query(sql.rows`SELECT value FROM t`.render()),
    { code: "BRAID_RESULT_EXACTNESS" },
  );
});

test("Oracle NUMBER-family metadata treats FLOAT and ANSI aliases as exact strings", async () => {
  const exactTypes = new Map(
    typePolicy.mappings
      .filter((mapping) => mapping.numeric?.semantics === "exact-decimal")
      .map((mapping) => [mapping.databaseType, mapping.numeric]),
  );
  assert.deepEqual(exactTypes.get("NUMBER"), {
    semantics: "exact-decimal",
    representation: "string",
    fidelity: "lossless",
  });
  assert.deepEqual(exactTypes.get("FLOAT"), {
    semantics: "exact-decimal",
    representation: "string",
    fidelity: "lossless",
  });
  assert.deepEqual(exactTypes.get("DOUBLE PRECISION"), {
    semantics: "exact-decimal",
    representation: "string",
    fidelity: "lossless",
  });
  assert.deepEqual(typePolicy.mappings.find((mapping) => mapping.databaseType === "INTEGER")?.numeric, {
    semantics: "exact-integer",
    representation: "string",
    fidelity: "lossless",
  });
  assert.equal(typePolicy.decode("FLOAT", "9007199254740993"), "9007199254740993");
  assert.equal(typePolicy.decode("NUMERIC", "12345678901234567890.123"), "12345678901234567890.123");

  const connection = {
    async execute() {
      return {
        rows: [{ VALUE: "9007199254740993" }],
        metaData: [{ name: "VALUE", dbTypeName: "FLOAT" }],
      };
    },
    async commit() {},
    async rollback() {},
  };
  assert.deepEqual(await createOracledbExecutor(connection).query(sql.rows`SELECT value FROM t`.render()), {
    kind: "rows",
    rows: [{ VALUE: "9007199254740993" }],
    rowCount: 1,
  });
});

test("Oracle preserves BINARY non-finite input after Thin-mode verification", () => {
  assert.ok(Number.isNaN(typePolicy.encode("BINARY_FLOAT", Number.NaN)));
  assert.equal(typePolicy.encode("BINARY_DOUBLE", Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  assert.throws(() => typePolicy.encode("BINARY_DOUBLE", "Infinity"), /JavaScript number/u);
});

test("Oracle environment does not overclaim NLS, JSON, or temporal fidelity", () => {
  const connection = {
    async execute() {
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
  };
  const capabilities = createOracledbExecutor(connection).environment?.capabilities;
  assert.equal(capabilities?.["numeric.bind-exact"]?.status, "unsupported");
  assert.equal(capabilities?.["data.json-parsed"]?.status, "guaranteed");
  assert.equal(capabilities?.["data.json-lossless-text"]?.status, "unsupported");
  assert.equal(capabilities?.["data.temporal-native"]?.status, "guarded");
  assert.equal(capabilities?.["data.temporal-lossless"]?.status, "unsupported");
});

test("Oracle rejects narrowed command counts and exact numeric OUT values", async () => {
  const countConnection = {
    async execute() {
      return { rowsAffected: Number.MAX_SAFE_INTEGER + 1 };
    },
    async commit() {},
    async rollback() {},
  };
  await assert.rejects(
    async () => createOracledbExecutor(countConnection).query(sql.command`DELETE FROM account`.render()),
    { code: "BRAID_RESULT_EXACTNESS" },
  );

  const outConnection = {
    async execute() {
      return { outBinds: [1] };
    },
    async commit() {},
    async rollback() {},
  };
  const driver = {
    BIND_OUT: "out",
    OUT_FORMAT_OBJECT: "object",
    DB_TYPE_VARCHAR: "varchar",
    DB_TYPE_NUMBER: "number",
  };
  await assert.rejects(
    async () =>
      createOracledbExecutor(outConnection, { driver }).call(
        sql.call`BEGIN answer(${sql.out("answer", oracleParameter.number())}); END;`.render(),
      ),
    { code: "BRAID_RESULT_EXACTNESS" },
  );
});

test("Oracle validates transaction options before control SQL", async () => {
  let executions = 0;
  const connection = {
    async execute() {
      executions += 1;
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection);
  await assert.rejects(
    async () => executor.begin!({ isolation: "invalid" as never }),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  await assert.rejects(
    async () => executor.begin!({ readOnly: "yes" as never }),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  await assert.rejects(
    async () => executor.begin!({ unsupported: true } as never),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  assert.equal(executions, 0);
});

test("[contract:node-oracledb:transaction.autocommit-ownership:boundary] [ownership:direct] Oracle explicit transactions suppress autoCommit for execute and executeMany and restore root options", async () => {
  const executions: { method: string; autoCommit: unknown; keepInStmtCache: unknown }[] = [];
  let commits = 0;
  let rollbacks = 0;
  const connection = {
    async execute(_text: string, _binds: readonly unknown[], options: OracleExecuteOptionsLike) {
      executions.push({ method: "execute", autoCommit: options.autoCommit, keepInStmtCache: options.keepInStmtCache });
      return { rowsAffected: 1 };
    },
    async executeMany(_text: string, binds: readonly unknown[], options: OracleExecuteOptionsLike) {
      executions.push({
        method: "executeMany",
        autoCommit: options.autoCommit,
        keepInStmtCache: options.keepInStmtCache,
      });
      return { rowsAffected: binds.length };
    },
    async commit() {
      commits += 1;
    },
    async rollback() {
      rollbacks += 1;
    },
  };
  const executeOptions = Object.freeze({ autoCommit: true, keepInStmtCache: false });
  const db = createOracledbDatabase(connection, { executeOptions });
  const insert = (id: number) => sql.command`INSERT INTO audit_test (id) VALUES (${id})`;
  const rollback = new Error("rollback requested");

  await db.execute(insert(1));
  await db.bulk([2, 3], insert);
  await assert.rejects(
    () =>
      db.tx(async (tx) => {
        await tx.execute(insert(4));
        await tx.bulk([5, 6], insert);
        throw rollback;
      }),
    (error: unknown) => error === rollback,
  );
  await db.execute(insert(7));
  await db.bulk([8, 9], insert);
  await db.tx(async (tx) => {
    await tx.execute(insert(10));
    await tx.bulk([11, 12], insert);
  });
  await db.execute(insert(13));
  await db.bulk([14, 15], insert);

  assert.equal(commits, 1);
  assert.equal(rollbacks, 1);
  assert.deepEqual(
    executions,
    [true, false, true, false, true].flatMap((autoCommit) => [
      { method: "execute", autoCommit, keepInStmtCache: false },
      { method: "executeMany", autoCommit, keepInStmtCache: false },
    ]),
  );
  assert.equal(executeOptions.autoCommit, true);
});

test("[contract:node-oracledb:transaction.autocommit-ownership:boundary] [ownership:pooled] Oracle session transactions retain commit ownership through nested savepoints", async () => {
  const executions: { text: string; autoCommit: unknown }[] = [];
  let acquired = 0;
  let closed = 0;
  let commits = 0;
  let rollbacks = 0;
  const db = createOracledbPoolDatabase(
    {
      async getConnection() {
        acquired += 1;
        return {
          async execute(text: string, _binds: readonly unknown[], options: OracleExecuteOptionsLike) {
            executions.push({ text, autoCommit: options.autoCommit });
            return { rowsAffected: 1 };
          },
          async executeMany(text: string, binds: readonly unknown[], options: OracleExecuteOptionsLike) {
            executions.push({ text, autoCommit: options.autoCommit });
            return { rowsAffected: binds.length };
          },
          async commit() {
            commits += 1;
          },
          async rollback() {
            rollbacks += 1;
          },
          async close() {
            closed += 1;
          },
        };
      },
    },
    { executeOptions: { autoCommit: true } },
  );
  const insert = (id: number) => sql.command`INSERT INTO audit_test (id) VALUES (${id})`;
  const nestedFailure = new Error("rollback nested");
  await db.session(async (session) => {
    await session.execute(insert(1));
    await session.tx({ readOnly: false }, async (tx) => {
      await tx.execute(insert(2));
      await assert.rejects(
        () =>
          tx.tx(async (nested) => {
            await nested.bulk([3, 4], insert);
            throw nestedFailure;
          }),
        (error: unknown) => error === nestedFailure,
      );
      await tx.execute(insert(5));
    });
    await session.execute(insert(6));
    await assert.rejects(
      () =>
        session.tx(async (tx) => {
          await tx.execute(insert(7));
          await tx.bulk([8, 9], insert);
          throw nestedFailure;
        }),
      (error: unknown) => error === nestedFailure,
    );
    await session.execute(insert(10));
  });
  assert.equal(acquired, 1);
  assert.equal(closed, 1);
  assert.equal(commits, 1);
  assert.equal(rollbacks, 1);
  assert.deepEqual(
    executions.map(({ autoCommit }) => autoCommit),
    [true, false, false, false, false, false, false, true, false, false, true],
  );
  assert.equal(executions[1]?.text, "SET TRANSACTION READ WRITE");
  const savepoint = executions[3]?.text;
  assert.match(savepoint ?? "", /^SAVEPOINT [A-Za-z_][A-Za-z0-9_]*$/u);
  assert.equal(executions[5]?.text, `ROLLBACK TO ${savepoint}`);
});

test("Oracle pool validates streamFetchSize before checkout", async () => {
  let acquired = 0;
  let closed = 0;
  const pool = {
    async getConnection() {
      acquired += 1;
      return {
        async execute() {
          return { rowsAffected: 0 };
        },
        async commit() {},
        async rollback() {},
        async close() {
          closed += 1;
        },
      };
    },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(async () => createOracledbPoolProvider(pool, { streamFetchSize: 0 }).acquire(), RangeError);
  }
  assert.equal(acquired, 0);
  assert.equal(closed, 0);
});

for (const cleanupFails of [false, true]) {
  test(`[contract:node-oracledb:pool.checkout-init-failure:boundary] [ownership:pooled] Oracle pool closes failed post-checkout wrappers once${cleanupFails ? " and preserves cleanup errors" : ""}`, async () => {
    const initError = new Error("native cancellation accessor failed");
    const cleanupError = new Error("native close failed");
    const failures: unknown[] = [];
    let acquired = 0;
    let closeAttempts = 0;
    let closed = 0;
    const provider = createOracledbPoolProvider({
      async getConnection() {
        acquired += 1;
        return {
          async execute() {
            return { rowsAffected: 0 };
          },
          async commit() {},
          async rollback() {},
          get break(): () => Promise<void> {
            throw initError;
          },
          async close() {
            closeAttempts += 1;
            if (cleanupFails) throw cleanupError;
            closed += 1;
          },
        };
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        () => provider.acquire(),
        (error: unknown) => {
          failures.push(error);
          return true;
        },
      );
    }
    assert.equal(acquired, 3);
    assert.equal(closeAttempts, acquired);
    assert.equal(closed, cleanupFails ? 0 : acquired);
    for (const error of failures) {
      if (!cleanupFails) {
        assert.equal(error, initError);
      } else {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, initError);
        assert.deepEqual(error.errors, [initError, cleanupError]);
        assert.equal("code" in error && error.code, "BRAID_RESOURCE_CLEANUP");
      }
    }
  });
}

test("Oracle rejects isolation/readOnly combinations before control SQL", async () => {
  let executions = 0;
  const connection = {
    async execute() {
      executions += 1;
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection);
  for (const isolation of ["read-uncommitted", "read-committed", "repeatable-read", "serializable"] as const) {
    await assert.rejects(
      async () => {
        await executor.begin!({ isolation, readOnly: true });
      },
      (error: unknown) =>
        error instanceof Error &&
        (error as { readonly code?: string }).code === "BRAID_TX_OPTION_UNSUPPORTED" &&
        (error as { readonly feature?: string }).feature === `transaction.isolation.${isolation}`,
    );
    await assert.rejects(
      async () => {
        await executor.begin!({ isolation, readOnly: false });
      },
      (error: unknown) =>
        error instanceof Error &&
        (error as { readonly code?: string }).code === "BRAID_TX_OPTION_UNSUPPORTED" &&
        (error as { readonly feature?: string }).feature === `transaction.isolation.${isolation}`,
    );
  }
  assert.equal(executions, 0);
});

test("Oracle query rows preserve hostile labels as own data properties", async () => {
  const labels = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"] as const;
  const connection = {
    async execute() {
      const row = Object.fromEntries(labels.map((label, index) => [label, index + 1]));
      return { rows: [row], metaData: labels.map((name) => ({ name })) };
    },
    async commit() {},
    async rollback() {},
  };
  const row = (await createOracledbExecutor(connection).query(sql.rows`SELECT 1 FROM dual`.render())).rows[0] as Record<
    string,
    unknown
  >;
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  for (const [index, label] of labels.entries()) {
    assert.equal(Object.hasOwn(row, label), true);
    assert.equal(row[label], index + 1);
  }
});

test("Oracle pre-aborted executions preserve a null AbortSignal reason", async () => {
  let executions = 0;
  const connection = {
    async execute() {
      executions += 1;
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection);
  await assert.rejects(
    async () => executor.query(sql`SELECT 1`.render(), undefined, { signal: AbortSignal.abort(null) }),
    (error: unknown) => error === null,
  );
  assert.equal(executions, 0);
});

test("Oracle rejects active cancellation before execution without break support", async () => {
  let executions = 0;
  const connection = {
    async execute() {
      executions += 1;
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection);
  const controller = new AbortController();
  await assert.rejects(
    async () => executor.query(sql`SELECT 1`.render(), undefined, { signal: controller.signal }),
    (error: unknown) => (error as { readonly code?: string }).code === "BRAID_CANCEL_UNSUPPORTED",
  );
  assert.equal(executions, 0);
});

test("Oracle custom type profiles retain raw break cancellation", async () => {
  let release: (() => void) | undefined;
  let breaks = 0;
  const started = Promise.withResolvers<void>();
  const connection = {
    async execute() {
      return new Promise((resolve) => {
        release = () => resolve({ rows: [] });
        started.resolve();
      });
    },
    async break() {
      breaks += 1;
    },
    async commit() {},
    async rollback() {},
  };
  const customPolicy = { ...typePolicy, id: "oracle-test-custom", hash: "oracle-test-custom-v1" };
  const executor = createOracledbExecutor(connection, { typePolicy: customPolicy });
  assert.equal(executor.environment?.capabilities["statement.cancel"]?.status, "guarded");
  const db = createOracledbDatabase(connection, { typePolicy: customPolicy });
  const controller = new AbortController();
  const reason = new Error("oracle custom cancellation");
  const pending = db.execute(sql.command`BEGIN NULL; END;`, { signal: controller.signal });
  const rejected = assert.rejects(pending, (error: unknown) => error === reason);
  await started.promise;
  controller.abort(reason);
  release?.();
  await rejected;
  assert.equal(breaks, 1);
});

test("Oracle cancellation remains active while reading an OUT cursor", async () => {
  let releaseRead: ((value: unknown) => void) | undefined;
  let breaks = 0;
  let closed = 0;
  const connection = {
    async execute() {
      return {
        outBinds: [
          {
            async getRow() {
              return new Promise((resolve) => {
                releaseRead = resolve;
              });
            },
            async close() {
              closed += 1;
            },
          },
        ],
      };
    },
    async break() {
      breaks += 1;
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection);
  const controller = new AbortController();
  let settled = false;
  const reason = new Error("oracle cursor cancelled");
  const pending = Promise.resolve(
    executor.call(
      sql.call`BEGIN read_cursor(${sql.out("cursor", oracleParameter.refCursor())}); END;`.render(),
      undefined,
      { signal: controller.signal },
    ),
  ).finally(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.ok(releaseRead);
  controller.abort(reason);
  await Promise.resolve();
  assert.equal(breaks, 1);
  assert.equal(settled, false);
  releaseRead?.(null);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(closed, 1);
});

test("Oracle cancellation remains active while materializing an OUT LOB", async () => {
  let releaseData: ((value: unknown) => void) | undefined;
  let onClose: (() => void) | undefined;
  let breaks = 0;
  let closed = 0;
  const lob = {
    async getData() {
      return new Promise((resolve) => {
        releaseData = resolve;
      });
    },
    destroy() {
      closed += 1;
      onClose?.();
    },
    once(event: string, listener: () => void) {
      if (event === "close") onClose = listener;
      return this;
    },
    removeListener() {
      return this;
    },
  };
  const connection = {
    async execute() {
      return { outBinds: [lob] };
    },
    async break() {
      breaks += 1;
    },
    async commit() {},
    async rollback() {},
  };
  const executor = createOracledbExecutor(connection);
  const controller = new AbortController();
  const reason = new Error("oracle lob cancelled");
  let settled = false;
  const pending = Promise.resolve(
    executor.call(sql.call`BEGIN read_lob(${sql.out("body", oracleParameter.clob())}); END;`.render(), undefined, {
      signal: controller.signal,
    }),
  ).finally(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.ok(releaseData);
  controller.abort(reason);
  await Promise.resolve();
  assert.equal(breaks, 1);
  assert.equal(settled, false);
  releaseData?.("body");
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(closed, 1);
});

for (const ownership of ["direct", "pooled"] as const) {
  test(`[contract:node-oracledb:transaction.access-mode:boundary] [ownership:${ownership}] omitted and explicit access modes retain distinct native boundaries`, async () => {
    const statements: string[] = [];
    let commits = 0;
    let released = 0;
    const connection = {
      async execute(text: string) {
        statements.push(text);
        return {};
      },
      async commit() {
        commits++;
      },
      async rollback() {},
      async close() {
        released++;
      },
    };
    const db =
      ownership === "direct"
        ? createOracledbDatabase(connection)
        : createOracledbPoolDatabase({
            async getConnection() {
              return connection;
            },
          });
    for (const readOnly of [undefined, true, false]) await db.tx({ readOnly }, async () => undefined);
    assert.deepEqual(statements, ["SET TRANSACTION READ ONLY", "SET TRANSACTION READ WRITE"]);
    assert.equal(commits, 3);
    assert.equal(released, ownership === "pooled" ? 3 : 0);
  });

  test(`[contract:node-oracledb:transaction.autocommit-ownership:boundary] [ownership:${ownership}] global autoCommit cannot persist callback-failed command, bulk or routine writes`, async () => {
    const previous = oracledb.autoCommit;
    oracledb.autoCommit = true;
    try {
      for (const sessionScoped of [false, true]) {
        const durable: number[] = [];
        const staged: number[] = [];
        const insertNative = (value: number, options: OracleExecuteOptionsLike) => {
          ((options.autoCommit ?? oracledb.autoCommit) ? durable : staged).push(value);
        };
        const connection = {
          async execute(text: string, binds: readonly number[], options: OracleExecuteOptionsLike) {
            if (text.startsWith("INSERT") || text.startsWith("BEGIN write_contract")) insertNative(binds[0]!, options);
            else assert.equal(options.autoCommit, false, "native transaction-control SQL must never auto-commit");
            return { rowsAffected: 1 };
          },
          async executeMany(_text: string, binds: readonly (readonly number[])[], options: OracleExecuteOptionsLike) {
            for (const row of binds) insertNative(row[0]!, options);
            return { rowsAffected: binds.length };
          },
          async commit() {
            durable.push(...staged.splice(0));
          },
          async rollback() {
            staged.length = 0;
          },
          async close() {},
        };
        const db =
          ownership === "direct"
            ? createOracledbDatabase(connection)
            : createOracledbPoolDatabase({
                async getConnection() {
                  return connection;
                },
              });
        const insert = (id: number) => sql.command`INSERT INTO contract_auto (id) VALUES (${id})`;
        const failure = new Error("callback rollback");
        for (const fail of [true, false]) {
          const callback = async (tx: typeof db) => {
            await tx.execute(insert(1));
            await tx.bulk([2, 3], insert);
            await tx.call(sql.call`BEGIN write_contract(${4}); END;`);
            await tx.tx(async (nested) => {
              await nested.execute(insert(5));
            });
            if (fail) throw failure;
          };
          const pending = sessionScoped ? db.session((session) => session.tx(callback)) : db.tx(callback);
          if (fail) await assert.rejects(pending, (error) => error === failure);
          else await pending;
          assert.deepEqual(durable, fail ? [] : [1, 2, 3, 4, 5]);
          assert.deepEqual(staged, []);
        }
        await db.execute(insert(6));
        assert.deepEqual(durable, [1, 2, 3, 4, 5, 6], "root execution must retain the native global policy");
      }
    } finally {
      oracledb.autoCommit = previous;
    }
  });

  for (const kind of ["stream", "routine", "returning"] as const)
    for (const cleanupFails of [false, true]) {
      test(`[contract:node-oracledb:cancellation.before-handoff:boundary] [contract:node-oracledb:resource.init-failure:boundary] [ownership:${ownership}] ${kind} registers all created resources before cancellation${cleanupFails ? " and preserves close failure" : ""}`, async () => {
        const controller = new AbortController();
        const reason = new Error("cancel after native resources exist");
        const cleanup = new Error("native cleanup failed");
        let created = 0;
        let closed = 0;
        let reads = 0;
        let released = 0;
        let discarded = 0;
        class Lob extends EventEmitter {
          constructor() {
            super();
            created++;
          }
          async getData() {
            reads++;
            return "body";
          }
          destroy() {
            closed++;
            if (cleanupFails) this.emit("error", cleanup);
            this.emit("close");
          }
        }
        const cursor = () => {
          created++;
          return {
            async getRow() {
              reads++;
              return null;
            },
            async close() {
              closed++;
              if (cleanupFails) throw cleanup;
            },
          };
        };
        const connection = {
          async execute() {
            const result =
              kind === "stream"
                ? { resultSet: cursor() }
                : kind === "routine"
                  ? { outBinds: [cursor(), new Lob()] }
                  : { outBinds: [[new Lob()]], rowsAffected: 1 };
            controller.abort(reason);
            return result;
          },
          async break() {},
          async commit() {},
          async rollback() {},
          async close(options?: { readonly drop?: boolean }) {
            if (options?.drop) discarded++;
            else released++;
          },
        };
        const db =
          ownership === "direct"
            ? createOracledbDatabase(connection)
            : createOracledbPoolDatabase({
                async getConnection() {
                  return connection;
                },
              });
        const run = async () => {
          if (kind === "stream") {
            for await (const row of db.stream(sql.rows`SELECT body FROM contract_data`, { signal: controller.signal }))
              void row;
          } else if (kind === "routine") {
            await db.call(
              sql.call`BEGIN read_contract(${sql.out("cursor", oracleParameter.refCursor())}, ${sql.out("body", oracleParameter.clob())}); END;`,
              { signal: controller.signal },
            );
          } else {
            await db.execute(
              sql.rows`INSERT INTO contract_data (body) VALUES ('body') RETURNING body INTO ${sql.out("body", oracleParameter.clob())}`,
              { signal: controller.signal },
            );
          }
        };
        await assert.rejects(
          run(),
          (error) => containsError(error, reason) && (!cleanupFails || containsError(error, cleanup)),
        );
        assert.equal(created, kind === "routine" ? 2 : 1);
        assert.equal(closed, created);
        assert.equal(reads, 0);
        assert.equal(released, 0);
        assert.equal(discarded, ownership === "pooled" ? 1 : 0);
        if (cleanupFails && ownership === "direct") {
          await assert.rejects(db.execute(sql.command`UPDATE contract_data SET body = 'x'`), {
            code: "BRAID_CONNECTION_POISONED",
          });
          assert.equal(closed, created);
        }
      });
    }
}
