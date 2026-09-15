import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sql } from "@sqlbraid/sqlite";
import {
  createSqliteWasmDatabase,
  type SqliteWasmDatabaseLike,
  type SqliteWasmStatementLike,
} from "@sqlbraid/sqlite/wasm";

interface PreviewRunRequest {
  readonly type: "run";
  readonly sql: string;
}

interface PreviewSchemaRequest {
  readonly type: "schema";
}

type PreviewRequest = PreviewRunRequest | PreviewSchemaRequest;

interface PreviewRow {
  readonly [key: string]: unknown;
}

interface PreviewSuccess {
  readonly type: "success";
  readonly sql: string;
  readonly kind: "rows" | "command";
  readonly columns: readonly string[];
  readonly rows: readonly PreviewRow[];
  readonly rowCount: number;
  readonly truncated?: boolean;
  readonly affectedRows?: number;
}

interface PreviewFailure {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

interface PreviewSchemaTable {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

interface PreviewSchemaSuccess {
  readonly type: "schema";
  readonly tables: readonly PreviewSchemaTable[];
}

type PreviewResponse = PreviewSuccess | PreviewFailure | PreviewSchemaSuccess;

interface PreviewDatabase {
  readonly native: SqliteWasmDatabaseLike;
  readonly db: ReturnType<typeof createSqliteWasmDatabase>;
}

let databasePromise: Promise<PreviewDatabase> | undefined;

function rawQuery(text: string) {
  // The preview intentionally executes user-authored SQL as raw text in a disposable database.
  return sql.command`${sql.raw(text)}`;
}

function rawRowsQuery(text: string) {
  return sql.rows`${sql.raw(text)}`;
}

async function getDatabase(): Promise<PreviewDatabase> {
  databasePromise ??= initializeDatabase();
  return databasePromise;
}

async function initializeDatabase(): Promise<PreviewDatabase> {
  const sqlite3 = await sqlite3InitModule();
  const native = new sqlite3.oo1.DB(":memory:");
  native.exec(`
    CREATE TABLE finance_accounts (
      account_id INTEGER PRIMARY KEY,
      account_name TEXT NOT NULL,
      balance INTEGER NOT NULL,
      currency TEXT NOT NULL,
      locale TEXT NOT NULL
    );
    INSERT INTO finance_accounts (account_id, account_name, balance, currency, locale)
    VALUES
      (1, '한빛증권', 1250000, 'KRW', 'ko-KR'),
      (2, '푸른은행', 820000, 'KRW', 'ko-KR'),
      (3, '東京パートナーズ', 2400000, 'JPY', 'ja-JP'),
      (4, 'Seoul Capital', 5100000, 'KRW', 'en-KR');
  `);
  return {
    native,
    db: createSqliteWasmDatabase(native, { sqlite3 }),
  };
}

function statementColumns(native: SqliteWasmDatabaseLike, text: string): readonly string[] {
  const statement: SqliteWasmStatementLike = native.prepare(text);
  try {
    const columns: string[] = [];
    for (let index = 0; index < statement.columnCount; index += 1) {
      columns.push(statement.getColumnName(index));
    }
    return columns;
  } finally {
    statement.finalize();
  }
}

async function runSql(request: PreviewRunRequest): Promise<PreviewResponse> {
  if (typeof request.sql !== "string" || request.sql.trim().length === 0) {
    return { type: "error", code: "PREVIEW_INPUT", message: "Enter a SQL statement to run." };
  }
  if (request.sql.length > 100_000) {
    return { type: "error", code: "PREVIEW_INPUT", message: "SQL is limited to 100,000 characters in this preview." };
  }

  const text = request.sql.trim();
  const database = await getDatabase();
  const columns = statementColumns(database.native, text);
  if (columns.length > 0) {
    const rows: PreviewRow[] = [];
    let truncated = false;
    for await (const row of database.db.stream(rawRowsQuery(text))) {
      if (rows.length >= 1_000) {
        truncated = true;
        break;
      }
      rows.push(row as PreviewRow);
    }
    return {
      type: "success",
      sql: text,
      kind: "rows",
      columns,
      rows,
      rowCount: rows.length,
      truncated,
    };
  }
  const execution = await database.db.execute(rawQuery(text));
  return {
    type: "success",
    sql: text,
    kind: "command",
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows: execution.command.affectedRows,
  };
}

async function inspectSchema(): Promise<PreviewSchemaSuccess> {
  const database = await getDatabase();
  const rows = await database.db.all(rawRowsQuery(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE type IN ('table', 'view')
    ORDER BY type, name
  `));
  const tables = rows.flatMap((row) => {
    const value = row as PreviewRow;
    return typeof value.type === "string" && typeof value.name === "string" && typeof value.sql === "string"
      ? [{ type: value.type, name: value.name, sql: value.sql }]
      : [];
  });
  return { type: "schema", tables };
}

async function handle(request: PreviewRequest): Promise<PreviewResponse> {
  if (request.type === "run") return runSql(request);
  if (request.type === "schema") return inspectSchema();
  return { type: "error", code: "PREVIEW_MESSAGE", message: "Unsupported preview message." };
}

let operation = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<PreviewRequest>) => {
  operation = operation.then(async () => {
    try {
      self.postMessage(await handle(event.data));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "PREVIEW_EXECUTION";
      self.postMessage({ type: "error", code, message } satisfies PreviewFailure);
    }
  });
});
