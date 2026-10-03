// Ambient context for documentation snippets. Snippets are fragments, so the
// names they use without a declaration get concrete package or platform types.
// Prefer imported driver and platform types over permissive placeholders.
import type * as Core from "@sqlbraid/core";
import type * as V from "valibot";
import type * as Pg from "pg";
import type * as Mysql from "mysql2/promise";
import type { DatabaseSync } from "node:sqlite";
import type { MetadataSnapshot } from "@sqlbraid/metadata";
import type { Connection as MariaDbConnection, Pool as MariaDbPool } from "mariadb";
import type { SqliteWasmDatabaseLike, SqliteWasmExecutorOptions } from "@sqlbraid/sqlite/wasm";
import type { D1DatabaseLike } from "@sqlbraid/sqlite/d1";

type S<T> = Core.StandardSchemaV1<unknown, T>;
type InputRow = { id: string; amount: string };

declare global {
  const sql: typeof import("@sqlbraid/postgres").sql;
  const db: Core.Database;
  const v: typeof V;
  type UserRow = { id: string; name: string; display_name?: string };
  type User = UserRow;
  type Row = Record<string, unknown>;
  type Output = Record<string, unknown>;
  type Sets = readonly Core.RoutineResultSet<unknown>[];
  type ReturnValue = number;
  type Awaitable<T> = Core.Awaitable<T>;
  type StatementBindingDescription = Core.StatementBindingDescription;
  type StatementBindingAdapter = Core.StatementBindingAdapter;
  type StatementBindingContext = Core.StatementBindingContext;
  type RenderedStatement = Core.RenderedStatement;
  type RenderedParameter = Core.RenderedParameter;
  type RenderedBulk = Core.RenderedBulk;
  type ParameterTypeHint = Core.ParameterTypeHint;
  type ExecutionOptions = Core.ExecutionOptions;
  type TransactionOptions = Core.TransactionOptions;
  type DriverEnvironment = Core.DriverEnvironment;
  type BulkBindingDescription = Core.BulkBindingDescription;
  type BulkExecutionResult = Core.BulkExecutionResult;
  type QueryExecutor = Core.QueryExecutor;
  type ConnectionLease = Core.ConnectionLease;
  type QueryExecutionResult<R> = Core.QueryExecutionResult<R>;
  type DriverRoutineResult = Core.DriverRoutineResult;
  type RoutineProcedure = Core.RoutineProcedure;
  type RoutineCallResult<O = unknown, R = unknown, X = unknown> = Core.RoutineCallResult<O, R, X>;
  type QueryResultKind = Core.QueryResultKind;
  type ExecutionObserver = Core.ExecutionObserver;
  type ExecutionEvent = Core.ExecutionEvent;

  const UserSchema: S<{ id: string; name: string }>;
  const PaymentSchema: S<{ id: string; amount: string }>;
  const OutputSchema: S<{ generatedAt: Date; state: string; message: string }>;
  const ReturnCodeSchema: S<number>;
  const SummarySchema: S<{ total: string }>;
  const RefreshSchema: S<{ id: string }>;
  const ExtraSchema: S<{ id: number; payload: string }>;
  const AccountSchema: S<{ id: string }>;

  const accountId: number, accountNumber: number;
  const row: { id: string };
  const events: Core.RowQuery<{ id: number; payload: string }>;
  const sqlbraid: typeof import("@sqlbraid/vite").default;
  const userId: string, teamId: string | undefined, id: string, organizationId: string;
  const status: string, email: string, displayName: string, sortColumn: string, sortKey: string, sort: string;
  const sortDescending: boolean, descending: boolean, includePrivate: boolean;
  const signal: AbortSignal;
  function loadPrivatePolicy(): boolean;
  function consume(row: unknown): void;
  const query: Core.RowQuery<UserRow>;
  const first: Core.CommandQuery, second: Core.CommandQuery;
  const inputs: readonly InputRow[];
  const accounts: readonly InputRow[];
  const factory: (input: InputRow) => Core.CommandQuery;
  const pool: Pg.Pool, pgPool: Pg.Pool, mysqlPool: Mysql.Pool, mariadbPool: MariaDbPool;
  const client: Pg.Client, connection: Mysql.Connection, native: DatabaseSync;
  const wasmDatabase: SqliteWasmDatabaseLike, env: { DB: D1DatabaseLike };
  const sqlite3: NonNullable<SqliteWasmExecutorOptions["sqlite3"]>;
  const connectionProvider: Core.ConnectionProvider;
  const snapshot: MetadataSnapshot, metadata: MetadataSnapshot, typePolicy: Core.TypePolicy;
  const logger: { debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void };
  const slowQueryObserver: Core.ExecutionObserver, auditObserver: Core.ExecutionObserver;
  const Bun: typeof import("bun");

  const createPgPoolDatabase: typeof import("@sqlbraid/postgres/pg").createPgPoolDatabase;
  const createPgDatabase: typeof import("@sqlbraid/postgres/pg").createPgDatabase;
  const createMysql2PoolDatabase: typeof import("@sqlbraid/mysql/mysql2").createMysql2PoolDatabase;
  const createMysql2Database: typeof import("@sqlbraid/mysql/mysql2").createMysql2Database;
  const createMariaDbPoolDatabase: typeof import("@sqlbraid/mariadb/mariadb").createMariaDbPoolDatabase;
  const createNodeSqliteDatabase: typeof import("@sqlbraid/sqlite/node-sqlite").createNodeSqliteDatabase;
  const createPooledDatabase: typeof import("@sqlbraid/runtime").createPooledDatabase;
  const createOpenTelemetryObserver: typeof import("@sqlbraid/opentelemetry").createOpenTelemetryObserver;
  const generateModels: typeof import("@sqlbraid/codegen").generateModels;
  const typePolicyForProfile: typeof import("@sqlbraid/postgres").typePolicyForProfile;
  const mssqlParameter: typeof import("@sqlbraid/mssql").mssqlParameter;
}
