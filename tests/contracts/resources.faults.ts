import { EventEmitter } from "node:events";
import type { Database } from "@sqlbraid/core";
import {
  createPgDatabase,
  createPgPoolDatabase,
  type PgPoolClientLike,
  type PgCursorFactory,
} from "@sqlbraid/postgres/pg";
import { createMysql2Database, createMysql2PoolDatabase, type Mysql2PoolConnectionLike } from "@sqlbraid/mysql/mysql2";
import { createMariaDbDatabase, createMariaDbPoolDatabase } from "@sqlbraid/mariadb/mariadb";
import { createOracledbDatabase, createOracledbPoolDatabase } from "@sqlbraid/oracle/oracledb";
import { createTediousDatabase, createTediousPoolDatabase, type TediousRequestLike } from "@sqlbraid/mssql/tedious";
import {
  createBunSqlDatabase,
  type BunSqlClient,
  type BunSqlDialect,
  type BunSqlReservedClient,
} from "@sqlbraid/bun-sql";
import { createNodeSqliteDatabase, type SqliteDatabaseLike } from "@sqlbraid/sqlite/node-sqlite";
import { createBetterSqlite3Database } from "@sqlbraid/sqlite/better-sqlite3";
import { createLibsqlDatabase, type LibsqlResultSetLike } from "@sqlbraid/sqlite/libsql";
import { createD1Database, type D1ResultLike } from "@sqlbraid/sqlite/d1";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";
import { sql as postgres } from "@sqlbraid/postgres";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as mariadb } from "@sqlbraid/mariadb";
import { sql as oracle } from "@sqlbraid/oracle";
import { sql as mssql } from "@sqlbraid/mssql";
import { sql as sqlite } from "@sqlbraid/sqlite";

export const poolTransports = [
  "pg",
  "mysql2",
  "mariadb",
  "node-oracledb",
  "tedious",
  "bun-sql-postgres",
  "bun-sql-mysql",
  "bun-sql-mariadb",
] as const;
export const directTransports = [
  "node-sqlite",
  "better-sqlite3",
  "libsql",
  "sqlite-wasm",
  "cloudflare-d1",
  "bun-sql-sqlite",
] as const;
export const transports = [...poolTransports, ...directTransports] as const;
export type ResourceTransport = (typeof transports)[number];
export const streamTransports = [
  "pg",
  "mysql2",
  "mariadb",
  "node-oracledb",
  "node-sqlite",
  "better-sqlite3",
  "sqlite-wasm",
] as const;
export const exactIdTransports = [
  "mysql2",
  "mariadb",
  "node-sqlite",
  "better-sqlite3",
  "bun-sql-mysql",
  "bun-sql-mariadb",
  "bun-sql-sqlite",
] as const;

export function resourceOwnerships(id: ResourceTransport): readonly ("direct" | "pooled")[] {
  return directTransports.some((transport) => transport === id)
    ? ["direct"]
    : id.startsWith("bun-sql-")
      ? ["pooled"]
      : ["direct", "pooled"];
}

// These are native driver surfaces only. Database, adapters, binding and runtime are real.
export function resourceFixture(id: ResourceTransport, ownership: "direct" | "pooled" = "pooled") {
  const state = {
    acquired: 0,
    released: 0,
    discarded: 0,
    io: 0,
    created: 0,
    closed: 0,
    cancelled: 0,
    count: 1 as unknown,
    insertId: 1n as unknown,
    executeFailure: undefined as Error | undefined,
    initFailure: undefined as Error | undefined,
    readFailure: undefined as Error | undefined,
    cleanupFailure: undefined as Error | undefined,
    terminalFailure: undefined as Error | undefined,
    onCreate: undefined as (() => void) | undefined,
    onExecute: undefined as (() => void | Promise<void>) | undefined,
    onRead: undefined as (() => void | Promise<void>) | undefined,
  };
  const release = async () => {
    state.released++;
  };
  const discard = () => {
    state.discarded++;
  };
  const close = () => {
    state.closed++;
    if (state.cleanupFailure) throw state.cleanupFailure;
  };
  const control = async () => {
    if (state.terminalFailure) throw state.terminalFailure;
  };
  const execute = async () => {
    state.io++;
    await state.onExecute?.();
    if (state.executeFailure) throw state.executeFailure;
  };
  const open = () => {
    state.created++;
    state.onCreate?.();
  };
  const rows = [{ value: "one" }, { value: "two" }];
  const sql =
    id === "pg" || id === "bun-sql-postgres"
      ? postgres
      : id === "mysql2" || id === "bun-sql-mysql"
        ? mysql
        : id === "mariadb" || id === "bun-sql-mariadb"
          ? mariadb
          : id === "node-oracledb"
            ? oracle
            : id === "tedious"
              ? mssql
              : sqlite;
  let db: Database;
  class NativeStream extends EventEmitter {
    readableEnded = false;
    destroyed = false;
    private done = false;
    constructor() {
      super();
      open();
    }
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        this.close();
      }
      return this;
    }
    close() {
      if (!this.done) {
        this.done = true;
        close();
      }
    }
    resume() {
      return this;
    }
    [Symbol.asyncIterator]() {
      if (state.initFailure) throw state.initFailure;
      let index = 0;
      return {
        next: async () => {
          if (index === 0) this.emit("fields", [{ name: "value", type: "VARCHAR" }]);
          await state.onRead?.();
          if (state.readFailure) {
            if (id === "mysql2" && index++ > 0) {
              this.readableEnded = true;
              this.close();
              return { done: true as const, value: undefined };
            }
            throw state.readFailure;
          }
          if (index < rows.length) return { done: false as const, value: rows[index++] };
          this.readableEnded = true;
          this.close();
          return { done: true as const, value: undefined };
        },
      };
    }
  }
  if (id === "pg") {
    let activeCursor: Cursor | undefined;
    class Cursor {
      private index = 0;
      constructor() {
        open();
      }
      read(_size: number, callback: (error: unknown, rows?: unknown[]) => void) {
        void (async () => {
          await state.onRead?.();
          if (state.readFailure) callback(state.readFailure);
          else callback(null, this.index < rows.length ? [rows[this.index++]] : []);
        })();
      }
      close(callback: (error?: unknown) => void) {
        try {
          close();
          callback();
        } catch (error) {
          callback(error);
        }
      }
    }
    const client = {
      query(value: unknown) {
        if (value instanceof Cursor) {
          activeCursor = value;
          if (state.initFailure) throw state.initFailure;
          return value;
        }
        const text = typeof value === "string" ? value : (value as { readonly text: string }).text;
        const terminal = text === "COMMIT" || text === "ROLLBACK";
        return (terminal ? control() : execute()).then(() => ({
          rows: [],
          fields: [],
          rowCount: state.count,
          command: text.split(" ")[0],
        }));
      },
      escapeIdentifier: (value: string) => `"${value}"`,
      escapeLiteral: (value: string) => `'${value}'`,
      release(error?: unknown) {
        if (error) discard();
        else state.released++;
      },
      async end() {
        state.cancelled++;
        if (activeCursor) close();
      },
    } as unknown as PgPoolClientLike;
    const options = { cursor: Cursor as unknown as PgCursorFactory, streamBatchSize: 1 };
    db =
      ownership === "direct"
        ? createPgDatabase(client, options)
        : createPgPoolDatabase(
            {
              async connect() {
                state.acquired++;
                return client;
              },
            },
            options,
          );
  } else if (id === "mysql2") {
    let activeStream: NativeStream | undefined;
    const raw = {
      execute() {
        return { stream: () => (activeStream = new NativeStream()) };
      },
      destroy() {
        state.cancelled++;
        activeStream?.destroy();
      },
    };
    const connection = {
      connection: raw,
      async execute() {
        await execute();
        return [{ affectedRows: state.count, insertId: state.insertId }, []];
      },
      beginTransaction: async () => {},
      commit: control,
      rollback: control,
      release,
      destroy() {
        discard();
        activeStream?.destroy();
      },
    } as unknown as Mysql2PoolConnectionLike;
    db =
      ownership === "direct"
        ? createMysql2Database(connection)
        : createMysql2PoolDatabase({
            async getConnection() {
              state.acquired++;
              return connection;
            },
          });
  } else if (id === "mariadb") {
    let activeStream: NativeStream | undefined;
    let destroyed = false;
    const connection = {
      async execute(options: string | { readonly insertIdAsNumber?: boolean }) {
        await execute();
        const insertId =
          typeof options !== "string" && options.insertIdAsNumber === false ? state.insertId : Number(state.insertId);
        return { affectedRows: state.count, insertId };
      },
      query: async () => [],
      queryStream: () => (activeStream = new NativeStream()),
      beginTransaction: async () => {},
      commit: control,
      rollback: control,
      release,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        state.cancelled++;
        if (ownership === "pooled") discard();
        activeStream?.destroy();
      },
    };
    db =
      ownership === "direct"
        ? createMariaDbDatabase(connection)
        : createMariaDbPoolDatabase({
            async getConnection() {
              state.acquired++;
              return connection;
            },
          });
  } else if (id === "node-oracledb") {
    const connection = {
      async execute(_text: string, _binds: readonly unknown[], options: { readonly resultSet?: boolean }) {
        await execute();
        if (!options.resultSet) return { rowsAffected: state.count };
        open();
        let index = 0;
        return {
          resultSet: {
            get metaData() {
              if (state.initFailure) throw state.initFailure;
              return [{ name: "value" }];
            },
            async getRow() {
              await state.onRead?.();
              if (state.readFailure) throw state.readFailure;
              return rows[index++];
            },
            close,
          },
        };
      },
      async break() {
        state.cancelled++;
      },
      commit: control,
      rollback: control,
      async close(options?: { readonly drop?: boolean }) {
        if (options?.drop) discard();
        else await release();
      },
    };
    db =
      ownership === "direct"
        ? createOracledbDatabase(connection)
        : createOracledbPoolDatabase({
            async getConnection() {
              state.acquired++;
              return connection;
            },
          });
  } else if (id === "tedious") {
    const connection = {
      execSql(request: TediousRequestLike) {
        const native = request as unknown as EventEmitter & { callback(error: unknown, count?: unknown): void };
        void execute().then(
          () => {
            native.emit("done", state.count);
            native.callback(null, state.count);
          },
          (error) => {
            native.callback(error);
          },
        );
      },
      beginTransaction(callback: (error?: unknown) => void) {
        callback();
      },
      commitTransaction(callback: (error?: unknown) => void) {
        callback(state.terminalFailure);
      },
      rollbackTransaction(callback: (error?: unknown) => void) {
        callback(state.terminalFailure);
      },
      saveTransaction(callback: (error?: unknown) => void) {
        callback();
      },
      destroy: discard,
    };
    db =
      ownership === "direct"
        ? createTediousDatabase(connection)
        : createTediousPoolDatabase({
            async acquire() {
              state.acquired++;
              return Object.assign(connection, { release });
            },
          });
  } else if (id.startsWith("bun-sql-")) {
    const dialect = id.slice("bun-sql-".length) as BunSqlDialect;
    const client = (async () => {
      await execute();
      return Object.assign([], { command: "UPDATE", affectedRows: state.count, lastInsertRowid: state.insertId });
    }) as unknown as BunSqlReservedClient;
    client.unsafe = async <T>(text: string): Promise<T> => {
      await control();
      return Object.assign([], { command: text.split(" ")[0] }) as T;
    };
    client.release = release;
    client.close = async () => {
      discard();
    };
    Object.defineProperty(client, "options", { value: { bigint: true, prepare: true } });
    client.reserve = async () => {
      state.acquired++;
      return client;
    };
    db = createBunSqlDatabase(client as BunSqlClient, { dialect });
  } else if (id === "libsql") {
    const result = async (): Promise<LibsqlResultSetLike> => {
      await execute();
      return {
        columns: [],
        rows: [],
        rowsAffected: state.count,
        lastInsertRowid: state.insertId,
      } as LibsqlResultSetLike;
    };
    db = createLibsqlDatabase(
      {
        execute: result,
        batch: async () => [await result()],
        transaction: async () => ({
          execute: result,
          batch: async () => [await result()],
          commit: control,
          rollback: control,
        }),
      },
      { intMode: "string" },
    );
  } else if (id === "cloudflare-d1") {
    db = createD1Database({
      prepare() {
        state.io++;
        return {
          bind() {
            return this;
          },
          async raw() {
            return [];
          },
        };
      },
      async batch<Row>() {
        await execute();
        return [{ success: true, meta: { changes: state.count } }] as D1ResultLike<Row>[];
      },
    });
  } else if (id === "sqlite-wasm") {
    db = createSqliteWasmDatabase(
      {
        prepare(text) {
          open();
          let index = 0;
          return {
            pointer: 1,
            get columnCount() {
              if (state.initFailure) throw state.initFailure;
              return text.startsWith("SELECT") ? 1 : 0;
            },
            bind() {
              if (state.initFailure) throw state.initFailure;
              return this;
            },
            step() {
              state.io++;
              if (state.readFailure) throw state.readFailure;
              if (state.executeFailure) throw state.executeFailure;
              return index++ < rows.length;
            },
            reset() {
              return this;
            },
            get() {
              return "one";
            },
            getColumnName() {
              return "value";
            },
            finalize: close,
          };
        },
        exec() {},
        changes(_total?: boolean, sixtyFour?: boolean) {
          return (sixtyFour ? state.count : Number(state.count) | 0) as number;
        },
      },
      { sqlite3: { capi: { SQLITE_INTEGER: 1, sqlite3_column_type: () => 3, sqlite3_column_int64: () => 0n } } },
    );
  } else {
    const native = {
      exec() {},
      prepare(text: string) {
        let exact = false;
        return {
          columns: () => (text.startsWith("SELECT") ? [{ name: "value" }] : []),
          setReadBigInts(value: boolean) {
            exact = value;
          },
          safeIntegers(value = true) {
            exact = value;
          },
          all: () => rows,
          run() {
            state.io++;
            if (state.executeFailure) throw state.executeFailure;
            return { changes: state.count, lastInsertRowid: exact ? state.insertId : Number(state.insertId) };
          },
          iterate() {
            open();
            let index = 0;
            return {
              [Symbol.iterator]() {
                return this;
              },
              next() {
                state.io++;
                if (state.readFailure) throw state.readFailure;
                return index < rows.length
                  ? { done: false as const, value: rows[index++] }
                  : { done: true as const, value: undefined };
              },
              return() {
                close();
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    };
    db =
      id === "node-sqlite"
        ? createNodeSqliteDatabase(native as SqliteDatabaseLike)
        : createBetterSqlite3Database(native as Parameters<typeof createBetterSqlite3Database>[0]);
  }
  return {
    db,
    state,
    command: () => sql.command`UPDATE contract_rows SET value = 'changed'`,
    insert: () => sql.command`INSERT INTO contract_rows DEFAULT VALUES`,
    remove: () => sql.command`DELETE FROM contract_rows`,
    rows: () => sql.rows<{ value: string }>`SELECT value FROM contract_rows`,
  };
}

export function containsError(error: unknown, expected: unknown): boolean {
  return (
    error === expected ||
    (error instanceof Error &&
      (containsError(error.cause, expected) ||
        (error instanceof AggregateError && error.errors.some((entry) => containsError(entry, expected)))))
  );
}
