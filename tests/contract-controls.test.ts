import assert from "node:assert/strict";
import { test } from "vitest";
import type { Database } from "@sqlbraid/core";
import { sql as postgres } from "@sqlbraid/postgres";
import { createPgDatabase, createPgPoolDatabase, type PgClientLike } from "@sqlbraid/postgres/pg";
import { sql as mysql } from "@sqlbraid/mysql";
import { createMysql2Database, createMysql2PoolDatabase, type Mysql2ConnectionLike } from "@sqlbraid/mysql/mysql2";
import { sql as maria } from "@sqlbraid/mariadb";
import { createMariaDbDatabase, createMariaDbPoolDatabase } from "@sqlbraid/mariadb/mariadb";
import { sql as oracle } from "@sqlbraid/oracle";
import { createOracledbDatabase, createOracledbPoolDatabase } from "@sqlbraid/oracle/oracledb";
import { sql as mssql } from "@sqlbraid/mssql";
import { createTediousDatabase, createTediousPoolDatabase, type TediousRequestLike } from "@sqlbraid/mssql/tedious";
import { sql as sqlite } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { createBetterSqlite3Database } from "@sqlbraid/sqlite/better-sqlite3";
import { createLibsqlDatabase, type LibsqlClientLike, type LibsqlStatementLike } from "@sqlbraid/sqlite/libsql";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";
import {
  createBunSqlDatabase,
  type BunSqlClient,
  type BunSqlReservedClient,
  type BunSqlDialect,
} from "@sqlbraid/bun-sql";
import {
  assertControlFailure,
  assertUnusable,
  transactionFaultContracts,
  type Control,
  type Fault,
  type TransactionFaultHarness,
} from "./contracts/transaction.faults.js";

interface NativeState {
  readonly calls: Control[];
  readonly statements: string[];
  readonly releases: boolean[];
  readonly failure: Error;
  readonly statementFailure: Error;
  fail(control: Fault): void;
  swallowFailures(): void;
  control(control: Control): void;
  sql(text: string): string;
}

function nativeState(): NativeState {
  const calls: Control[] = [];
  const statements: string[] = [];
  const releases: boolean[] = [];
  const failure = new Error("injected native control failure");
  const statementFailure = new Error("native transaction-aborting statement");
  let fault: Fault | undefined;
  let aborted = false;
  let swallow = false;
  return {
    calls,
    statements,
    releases,
    failure,
    statementFailure,
    fail(control: Fault) {
      fault = control;
    },
    swallowFailures() {
      swallow = true;
    },
    control(control: Control) {
      calls.push(control);
      if (fault === control && !swallow) throw failure;
    },
    sql(text: string) {
      statements.push(text);
      if (text.includes("BROKEN")) {
        aborted = true;
        throw statementFailure;
      }
      const control: Control | undefined =
        text.startsWith("ROLLBACK TO") || text.startsWith("ROLLBACK TRANSACTION [")
          ? "rollback-to"
          : text.startsWith("RELEASE SAVEPOINT")
            ? "release-savepoint"
            : text.startsWith("SAVEPOINT")
              ? "savepoint"
              : text === "COMMIT"
                ? "commit"
                : text === "ROLLBACK"
                  ? "rollback"
                  : text.startsWith("BEGIN") || text.startsWith("START TRANSACTION")
                    ? "begin"
                    : undefined;
      if (control !== undefined) this.control(control);
      return text === "COMMIT" && aborted ? "ROLLBACK" : text.split(" ")[0];
    },
  };
}

function fixture(
  state: NativeState,
  db: Database,
  pooled: boolean,
  write: (db: Database) => Promise<unknown>,
): TransactionFaultHarness {
  return { ...state, db, pooled, write };
}

function pgFixture(pooled: boolean, state = nativeState()): TransactionFaultHarness {
  const client: PgClientLike & { release(discard?: boolean): void } = {
    async query(input) {
      const text = typeof input === "string" ? input : input.text;
      return { rows: [], fields: [], rowCount: 1, command: state.sql(text) };
    },
    escapeIdentifier: (value) => `"${value}"`,
    escapeLiteral: (value) => `'${value}'`,
    release(discard = false) {
      state.releases.push(discard);
    },
  };
  return fixture(
    state,
    pooled ? createPgPoolDatabase({ connect: async () => client }) : createPgDatabase(client),
    pooled,
    (db) => db.execute(postgres.command`UPDATE contract_rows SET value = 1`),
  );
}

function mysqlFixture(pooled: boolean, state = nativeState()): TransactionFaultHarness {
  const connection: Mysql2ConnectionLike & { release(): void; destroy(): void } = {
    async execute(input) {
      state.sql(typeof input === "string" ? input : input.sql);
      return [{ affectedRows: 1 }, undefined];
    },
    async beginTransaction() {
      state.control("begin");
    },
    async commit() {
      state.control("commit");
    },
    async rollback() {
      state.control("rollback");
    },
    release() {
      state.releases.push(false);
    },
    destroy() {
      state.releases.push(true);
    },
  };
  return fixture(
    state,
    pooled ? createMysql2PoolDatabase({ getConnection: async () => connection }) : createMysql2Database(connection),
    pooled,
    (db) => db.execute(mysql.command`UPDATE contract_rows SET value = 1`),
  );
}

function mariaFixture(pooled: boolean, state = nativeState()): TransactionFaultHarness {
  const connection = {
    async execute(input: string | { readonly sql: string }) {
      state.sql(typeof input === "string" ? input : input.sql);
      return { affectedRows: 1 };
    },
    async beginTransaction() {
      state.control("begin");
    },
    async commit() {
      state.control("commit");
    },
    async rollback() {
      state.control("rollback");
    },
    release() {
      state.releases.push(false);
    },
    destroy() {
      state.releases.push(true);
    },
  };
  return fixture(
    state,
    pooled ? createMariaDbPoolDatabase({ getConnection: async () => connection }) : createMariaDbDatabase(connection),
    pooled,
    (db) => db.execute(maria.command`UPDATE contract_rows SET value = 1`),
  );
}

function oracleFixture(pooled: boolean): TransactionFaultHarness {
  const state = nativeState();
  const connection = {
    async execute(text: string) {
      state.sql(text);
      return { rowsAffected: 1 };
    },
    async commit() {
      state.control("commit");
    },
    async rollback() {
      state.control("rollback");
    },
    async close(options?: { readonly drop?: boolean }) {
      state.releases.push(options?.drop === true);
    },
  };
  return fixture(
    state,
    pooled ? createOracledbPoolDatabase({ getConnection: async () => connection }) : createOracledbDatabase(connection),
    pooled,
    (db) => db.execute(oracle.command`UPDATE contract_rows SET value = 1`),
  );
}

function tediousFixture(pooled: boolean): TransactionFaultHarness {
  const state = nativeState();
  // Schedule native callbacks: a try/catch around execSql cannot catch these errors.
  const complete = (control: Control, callback: (error?: unknown) => void) => {
    queueMicrotask(() => {
      let failure: unknown;
      try {
        state.control(control);
      } catch (error) {
        failure = error;
      }
      callback(failure);
    });
  };
  const connection = {
    execSql(value: TediousRequestLike) {
      const request = value as TediousRequestLike & {
        readonly sqlTextOrProcedure: string;
        callback(error?: unknown, rowCount?: number): void;
      };
      queueMicrotask(() => {
        let failure: unknown;
        try {
          state.sql(request.sqlTextOrProcedure);
        } catch (error) {
          failure = error;
        }
        request.callback(failure, 1);
      });
    },
    beginTransaction(callback: (error?: unknown) => void) {
      complete("begin", callback);
    },
    commitTransaction(callback: (error?: unknown) => void) {
      complete("commit", callback);
    },
    rollbackTransaction(callback: (error?: unknown) => void) {
      complete("rollback", callback);
    },
    saveTransaction(callback: (error?: unknown) => void) {
      complete("savepoint", callback);
    },
  };
  const poolConnection = {
    ...connection,
    release() {
      state.releases.push(false);
    },
    destroy() {
      state.releases.push(true);
    },
  };
  return fixture(
    state,
    pooled ? createTediousPoolDatabase({ acquire: async () => poolConnection }) : createTediousDatabase(connection),
    pooled,
    (db) => db.execute(mssql.command`UPDATE contract_rows SET value = 1`),
  );
}

function sqliteFixture(kind: "node-sqlite" | "better-sqlite3" | "sqlite-wasm"): TransactionFaultHarness {
  const state = nativeState();
  const native = {
    exec(text: string) {
      state.sql(text);
    },
    prepare(text: string) {
      const statement = {
        reader: false,
        columnCount: 0,
        all() {
          return [];
        },
        *iterate() {},
        columns() {
          return [];
        },
        setReadBigInts() {},
        safeIntegers() {},
        run() {
          state.sql(text);
          return { changes: 1n, lastInsertRowid: 0n };
        },
        bind() {
          return statement;
        },
        step() {
          state.sql(text);
          return false;
        },
        reset() {
          return statement;
        },
        get() {
          throw new Error("command has no columns");
        },
        getColumnName() {
          throw new Error("command has no columns");
        },
        finalize() {},
      };
      return statement;
    },
    changes() {
      return 1n;
    },
  };
  const db =
    kind === "node-sqlite"
      ? createNodeSqliteDatabase(native)
      : kind === "better-sqlite3"
        ? createBetterSqlite3Database(native)
        : createSqliteWasmDatabase(native);
  return fixture(state, db, false, (db) => db.execute(sqlite.command`UPDATE contract_rows SET value = 1`));
}

function libsqlFixture(): TransactionFaultHarness {
  const state = nativeState();
  const execute = async (statement: string | LibsqlStatementLike) => {
    state.sql(typeof statement === "string" ? statement : statement.sql);
    return { columns: [], rows: [], rowsAffected: 1 };
  };
  const client: LibsqlClientLike = {
    execute,
    async batch(statements) {
      return Promise.all(statements.map((statement) => execute(Array.isArray(statement) ? statement[0] : statement)));
    },
    async transaction() {
      state.control("begin");
      return {
        execute,
        batch: client.batch,
        async commit() {
          state.control("commit");
        },
        async rollback() {
          state.control("rollback");
        },
        close() {},
      };
    },
  };
  return fixture(state, createLibsqlDatabase(client, { intMode: "string" }), false, (db) =>
    db.execute(sqlite.command`UPDATE contract_rows SET value = 1`),
  );
}

function bunFixture(dialect: BunSqlDialect, state = nativeState()): TransactionFaultHarness {
  const query = (text: string) =>
    Object.assign([], {
      command: state.sql(text),
      count: 1,
      affectedRows: 1,
      lastInsertRowid: null,
    });
  const client: BunSqlReservedClient = Object.assign(
    <T>(strings: TemplateStringsArray): Promise<T> => Promise.resolve(query(strings.join("")) as T),
    {
      unsafe: async <T>(text: string): Promise<T> => query(text) as T,
      release: () => {
        state.releases.push(false);
      },
      close: async () => {
        state.releases.push(true);
      },
    },
  );
  const pool: BunSqlClient = Object.assign(
    <T>(): Promise<T> => {
      throw new Error("unreserved pool execution");
    },
    {
      unsafe: client.unsafe,
      reserve: async () => client,
    },
  );
  const tag = dialect === "postgres" ? postgres : dialect === "mysql" ? mysql : dialect === "mariadb" ? maria : sqlite;
  return fixture(
    state,
    createBunSqlDatabase(dialect === "sqlite" ? client : pool, { dialect }),
    dialect !== "sqlite",
    (db) => db.execute(tag.command`UPDATE contract_rows SET value = 1`),
  );
}

for (const pooled of [false, true]) {
  const ownership = pooled ? "pooled" : "direct";
  transactionFaultContracts("pg", ownership, () => pgFixture(pooled));
  transactionFaultContracts("mysql2", ownership, () => mysqlFixture(pooled));
  transactionFaultContracts("mariadb", ownership, () => mariaFixture(pooled));
  transactionFaultContracts("node-oracledb", ownership, () => oracleFixture(pooled), false);
  transactionFaultContracts("tedious", ownership, () => tediousFixture(pooled), false);
}

for (const transport of ["pg", "mysql2", "mariadb"] as const) {
  for (const pooled of [false, true]) {
    test(`[contract:${transport}:transaction.access-mode:boundary] [ownership:${pooled ? "pooled" : "direct"}] native transaction access mode distinguishes omitted true and false`, async () => {
      for (const readOnly of [undefined, true, false]) {
        const state = nativeState();
        const harness =
          transport === "pg"
            ? pgFixture(pooled, state)
            : transport === "mysql2"
              ? mysqlFixture(pooled, state)
              : mariaFixture(pooled, state);
        const options = readOnly === undefined ? {} : { readOnly };
        assert.equal(await harness.db.tx(options, async () => "committed"), "committed");
        const mode = readOnly === true ? "READ ONLY" : readOnly === false ? "READ WRITE" : undefined;
        assert.deepEqual(
          state.statements,
          transport === "pg"
            ? [mode === undefined ? "BEGIN" : `BEGIN ${mode}`, "COMMIT"]
            : mode === undefined
              ? []
              : [transport === "mysql2" ? `START TRANSACTION ${mode}` : `SET TRANSACTION ${mode}`],
        );
        assert.deepEqual(state.calls, ["begin", "commit"]);
        if (pooled) assert.deepEqual(state.releases, [false]);
      }
    });
  }
}

for (const kind of ["node-sqlite", "better-sqlite3", "sqlite-wasm"] as const) {
  transactionFaultContracts(kind, "direct", () => sqliteFixture(kind));
}
transactionFaultContracts("libsql", "direct", libsqlFixture);
for (const dialect of ["postgres", "mysql", "mariadb", "sqlite"] as const) {
  transactionFaultContracts(`bun-sql-${dialect}`, dialect === "sqlite" ? "direct" : "pooled", () =>
    bunFixture(dialect),
  );
}

for (const [transport, pooled] of [
  ["pg", false],
  ["pg", true],
  ["bun-sql-postgres", true],
] as const) {
  test(`[contract:${transport}:transaction.commit-terminal-outcome:boundary] [ownership:${pooled ? "pooled" : "direct"}] caught statement error cannot turn native ROLLBACK into commit success`, async () => {
    const state = nativeState();
    const harness = transport === "pg" ? pgFixture(pooled, state) : bunFixture("postgres", state);
    await assert.rejects(
      () =>
        harness.db.tx(async (tx) => {
          await harness.write(tx);
          await assert.rejects(
            () => tx.execute(postgres.command`BROKEN`),
            (error: unknown) =>
              error === state.statementFailure || (error instanceof Error && error.cause === state.statementFailure),
          );
          return "must not escape";
        }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_NOT_COMMITTED",
    );
    assert.equal(state.calls.filter((control) => control === "commit").length, 1);
    await assertUnusable(harness);
  });
}

for (const fault of ["commit", "rollback", "savepoint", "rollback-to", "release-savepoint"] as const) {
  test(`fault harness rejects a native fixture that swallows ${fault} failure`, async () => {
    const state = nativeState();
    state.swallowFailures();
    await assert.rejects(() => assertControlFailure(pgFixture(false, state), fault), assert.AssertionError);
  });
}

for (const pooled of [false, true]) {
  for (const cleanupFails of [false, true]) {
    const scenario = cleanupFails ? "resource.cleanup-failure" : "resource.init-failure";
    test(`[contract:tedious:${scenario}:boundary] [contract:tedious:cancellation.before-handoff:boundary] [ownership:${pooled ? "pooled" : "direct"}] aborted successful prepare closes before handing back the lease${cleanupFails ? " and retains cleanup failure" : ""}`, async () => {
      const controller = new AbortController();
      const reason = new Error("abort while native prepare completes");
      const cleanupFailure = new Error("native unprepare failed");
      const events: string[] = [];
      const connection = {
        execSql() {
          throw new Error("bulk must use native prepare");
        },
        prepare(value: TediousRequestLike) {
          const request = value as TediousRequestLike & {
            preparing: boolean;
            callback(error?: unknown): void;
          };
          events.push("prepare");
          request.preparing = true;
          controller.abort(reason);
          // The server successfully prepared despite the cancellation race.
          queueMicrotask(() => request.callback());
        },
        execute() {
          events.push("execute");
          throw new Error("aborted bulk must not execute");
        },
        unprepare(value: TediousRequestLike) {
          events.push("unprepare");
          const request = value as TediousRequestLike & { canceled: boolean; callback(error?: unknown): void };
          // Mirror Tedious makeRequest(): a reused canceled Request is rejected
          // before the native unprepare operation can release its statement.
          queueMicrotask(() =>
            request.callback(
              request.canceled
                ? new Error("Canceled request cannot unprepare")
                : cleanupFails
                  ? cleanupFailure
                  : undefined,
            ),
          );
        },
        beginTransaction(callback: () => void) {
          callback();
        },
        commitTransaction(callback: () => void) {
          callback();
        },
        rollbackTransaction(callback: () => void) {
          callback();
        },
        saveTransaction(callback: () => void) {
          callback();
        },
      };
      const poolConnection = {
        ...connection,
        release() {
          events.push("release");
        },
        destroy() {
          events.push("discard");
        },
      };
      const db = pooled
        ? createTediousPoolDatabase({ acquire: async () => poolConnection })
        : createTediousDatabase(connection);
      await assert.rejects(
        () => db.bulk([1], () => mssql.command`UPDATE contract_rows SET value = 1`, { signal: controller.signal }),
        (error: unknown) => {
          if (!cleanupFails) return error === reason;
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, reason);
          assert.ok(error.errors.includes(reason));
          assert.ok(error.errors.includes(cleanupFailure));
          return true;
        },
      );
      assert.deepEqual(events, ["prepare", "unprepare", ...(pooled ? [cleanupFails ? "discard" : "release"] : [])]);
      if (!pooled && cleanupFails) {
        await assert.rejects(
          () => db.tx(async () => undefined),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_CONNECTION_POISONED",
        );
      }
    });
  }
}
