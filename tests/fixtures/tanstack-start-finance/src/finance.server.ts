import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { selectFinanceRows } from "./queries";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
  CREATE TABLE "재무 거래" (
    "거래 ID" INTEGER PRIMARY KEY,
    "고객 이름" TEXT NOT NULL,
    "금액" REAL NOT NULL,
    "상태" TEXT NOT NULL,
    "메모" TEXT
  ) STRICT;
`);
sqlite.prepare('INSERT INTO "재무 거래" ("거래 ID", "고객 이름", "금액", "상태", "메모") VALUES (?, ?, ?, ?, ?)').run(
  9007199254740993n,
  "김하늘",
  1200.5,
  "완료",
  "정산 완료",
);
sqlite.prepare('INSERT INTO "재무 거래" ("거래 ID", "고객 이름", "금액", "상태", "메모") VALUES (?, ?, ?, ?, ?)').run(
  9007199254740995n,
  "이서준",
  42.25,
  "대기",
  null,
);

const db = createNodeSqliteDatabase(sqlite, { integerMode: "bigint" });

export async function readFinanceRows() {
  const rows = await db.all(selectFinanceRows(undefined, false));
  if (rows[0] === undefined || typeof rows[0].id !== "bigint") throw new Error("SQLite integerMode bigint was not applied");
  return rows.map((row) => ({
    id: row.id.toString(),
    customer: row.customer,
    amount: row.amount,
    status: row.status,
    memo: row.memo,
  }));
}
