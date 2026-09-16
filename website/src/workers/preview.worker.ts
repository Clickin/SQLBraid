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

interface PreviewBraidRequest {
  readonly type: "run-braid";
  readonly projection: "full" | "compact";
  readonly currency: "" | "KRW" | "JPY";
  readonly minBalance: number | null;
  readonly search: string;
  readonly order: "account-id" | "balance-desc";
}

interface PreviewSchemaRequest {
  readonly type: "schema";
}

type PreviewRequest = PreviewRunRequest | PreviewBraidRequest | PreviewSchemaRequest;

interface PreviewRow {
  readonly [key: string]: unknown;
}

interface PreviewSuccess {
  readonly type: "success";
  readonly mode: "raw" | "braid";
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly variantFingerprint?: string;
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
  // The scratchpad intentionally executes user-authored SQL as raw text in a disposable database.
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

function sqliteStatementText(rendered: { readonly segments: readonly string[]; readonly parameters: readonly unknown[] }): string {
  let text = rendered.segments[0] ?? "";
  for (let index = 0; index < rendered.parameters.length; index += 1) {
    text += `?${index + 1}${rendered.segments[index + 1] ?? ""}`;
  }
  return text.trim();
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
      mode: "raw",
      sql: text,
      parameters: [],
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
    mode: "raw",
    sql: text,
    parameters: [],
    kind: "command",
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows: execution.command.affectedRows,
  };
}

async function runBraid(request: PreviewBraidRequest): Promise<PreviewResponse> {
  if (request.projection !== "full" && request.projection !== "compact") {
    return { type: "error", code: "PREVIEW_INPUT", message: "Choose a supported projection." };
  }
  if (request.currency !== "" && request.currency !== "KRW" && request.currency !== "JPY") {
    return { type: "error", code: "PREVIEW_INPUT", message: "Choose a supported currency filter." };
  }
  if (request.order !== "account-id" && request.order !== "balance-desc") {
    return { type: "error", code: "PREVIEW_INPUT", message: "Choose a supported sort order." };
  }
  if (request.minBalance !== null && (!Number.isFinite(request.minBalance) || request.minBalance < 0)) {
    return { type: "error", code: "PREVIEW_INPUT", message: "Minimum balance must be a non-negative finite number or blank." };
  }
  if (typeof request.search !== "string" || request.search.length > 200) {
    return { type: "error", code: "PREVIEW_INPUT", message: "Account-name search is limited to 200 characters." };
  }

  const projection = request.projection === "compact"
    ? sql.fragment`account_id, account_name, balance`
    : sql.fragment`account_id, account_name, balance, currency, locale`;
  const order = request.order === "balance-desc"
    ? sql.fragment`balance DESC, account_id ASC`
    : sql.fragment`account_id ASC`;
  const hasCurrency = request.currency !== "";
  const hasMinimum = request.minBalance !== null;
  const search = request.search.trim();
  const hasSearch = search.length > 0;
  const searchPattern = `%${search}%`;

  const query = sql.rows`
    SELECT ${projection}
    FROM finance_accounts
    /*@braid where*/
      /*@braid if ${hasCurrency} */
        AND currency = ${request.currency}
      /*@braid end*/
      /*@braid if ${hasMinimum} */
        AND balance >= ${request.minBalance}
      /*@braid end*/
      /*@braid if ${hasSearch} */
        AND account_name LIKE ${searchPattern}
      /*@braid end*/
    /*@braid end*/
    ORDER BY ${order};
  `;

  const rendered = query.render();
  const text = sqliteStatementText(rendered);
  const database = await getDatabase();
  const columns = statementColumns(database.native, text);
  const rows: PreviewRow[] = [];
  let truncated = false;
  for await (const row of database.db.stream(query)) {
    if (rows.length >= 1_000) {
      truncated = true;
      break;
    }
    rows.push(row as PreviewRow);
  }
  return {
    type: "success",
    mode: "braid",
    sql: text,
    parameters: rendered.parameters.map((parameter) => parameter.value),
    variantFingerprint: rendered.variantFingerprint,
    kind: "rows",
    columns,
    rows,
    rowCount: rows.length,
    truncated,
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
  if (request.type === "run-braid") return runBraid(request);
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
