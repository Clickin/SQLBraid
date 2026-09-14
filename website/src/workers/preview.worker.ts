import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { StandardSchemaV1 } from "@sqlbraid/core";
import { sql } from "@sqlbraid/sqlite";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";

interface FinanceRow {
  readonly accountId: number;
  readonly accountName: string;
  readonly balance: number;
  readonly currency: string;
  readonly locale: string;
  readonly balanceLabel: string;
}

interface PreviewRequest {
  readonly type: "run";
  readonly koreanOnly: boolean;
  readonly minimumBalance: number;
}

interface PreviewSuccess {
  readonly type: "success";
  readonly source: string;
  readonly renderedSql: string;
  readonly binds: readonly unknown[];
  readonly rows: readonly FinanceRow[];
}

interface PreviewFailure {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

type PreviewResponse = PreviewSuccess | PreviewFailure;

const financeSchema = {
  "~standard": {
    version: 1,
    vendor: "SQLBraid browser preview",
    validate(value: unknown) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "Expected a finance row object." }] };
      }
      const row = value as Record<string, unknown>;
      if (
        typeof row.accountId !== "string"
        || typeof row.accountName !== "string"
        || typeof row.balance !== "string"
        || typeof row.currency !== "string"
        || typeof row.locale !== "string"
      ) {
        return { issues: [{ message: "Finance row columns have unexpected types." }] };
      }
      const accountId = Number(row.accountId);
      const balance = Number(row.balance);
      if (!Number.isSafeInteger(accountId) || !Number.isSafeInteger(balance)) {
        return { issues: [{ message: "Finance values exceed the application's safe integer range." }] };
      }
      return {
        value: {
          accountId,
          accountName: row.accountName,
          balance,
          currency: row.currency,
          locale: row.locale,
          balanceLabel: new Intl.NumberFormat("ko-KR", {
            style: "currency",
            currency: row.currency,
            maximumFractionDigits: 0,
          }).format(balance),
        },
      };
    },
  },
} satisfies StandardSchemaV1<unknown, FinanceRow>;

const source = `const accounts = sql.rows(financeSchema)\`
  SELECT account_id AS accountId,
         account_name AS accountName,
         balance,
         currency,
         locale
  FROM finance_accounts
  /*@braid where*/
    /*@braid if \${koreanOnly}*/
      AND locale = \${"ko-KR"}
    /*@braid end*/
    /*@braid if \${minimumBalance > 0}*/
      AND balance >= \${minimumBalance}
    /*@braid end*/
  /*@braid end*/
  ORDER BY account_id
\`;`;

let databasePromise: Promise<ReturnType<typeof createSqliteWasmDatabase>> | undefined;

async function getDatabase(): Promise<ReturnType<typeof createSqliteWasmDatabase>> {
  databasePromise ??= initializeDatabase();
  return databasePromise;
}

async function initializeDatabase(): Promise<ReturnType<typeof createSqliteWasmDatabase>> {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:");
  database.exec(`
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
  return createSqliteWasmDatabase(database, { sqlite3 });
}

function renderedSql(statement: {
  readonly segments: readonly string[];
  readonly parameters: readonly unknown[];
}): string {
  return statement.segments
    .map((segment, index) => `${segment}${index < statement.parameters.length ? "?" : ""}`)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

async function run(request: PreviewRequest): Promise<PreviewResponse> {
  if (request.type !== "run") {
    return { type: "error", code: "PREVIEW_MESSAGE", message: "Unsupported preview message." };
  }
  if (typeof request.koreanOnly !== "boolean") {
    return { type: "error", code: "PREVIEW_INPUT", message: "Korean-only filter must be a boolean." };
  }
  if (!Number.isFinite(request.minimumBalance) || request.minimumBalance < 0) {
    return { type: "error", code: "PREVIEW_INPUT", message: "Minimum balance must be a non-negative number." };
  }

  const accounts = sql.rows(financeSchema)`
    SELECT account_id AS accountId,
           account_name AS accountName,
           balance,
           currency,
           locale
    FROM finance_accounts
    /*@braid where*/
      /*@braid if ${request.koreanOnly}*/
        AND locale = ${"ko-KR"}
      /*@braid end*/
      /*@braid if ${request.minimumBalance > 0}*/
        AND balance >= ${request.minimumBalance}
      /*@braid end*/
    /*@braid end*/
    ORDER BY account_id
  `;
  const rendered = accounts.render();
  const database = await getDatabase();
  const rows = await database.all(accounts);
  return {
    type: "success",
    source,
    renderedSql: renderedSql(rendered),
    binds: rendered.parameters.map((parameter) => parameter.value),
    rows,
  };
}

self.addEventListener("message", (event: MessageEvent<PreviewRequest>) => {
  void run(event.data)
    .then((response) => self.postMessage(response))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "PREVIEW_EXECUTION";
      self.postMessage({ type: "error", code, message } satisfies PreviewFailure);
    });
});
