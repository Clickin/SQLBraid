import { sql } from "@sqlbraid/sqlite";
import { financeSchema, type FinanceRow } from "./schema";

export function selectFinanceRows(customer: string | undefined, includePending: boolean) {
  return sql.rows(financeSchema)`
    SELECT
      "거래 ID" AS id,
      "고객 이름" AS customer,
      "금액" AS amount,
      "상태" AS status,
      "메모" AS memo
    FROM "재무 거래"
    /*@braid where*/
      /*@braid if ${customer !== undefined}*/ AND "고객 이름" = ${customer.trim()} /*@braid end*/
      /*@braid choose*/
        /*@braid when ${includePending}*/ AND "상태" IN ('완료', '대기')
        /*@braid otherwise*/ AND "상태" = '완료'
      /*@braid end*/
    /*@braid end*/
    ORDER BY "거래 ID"
  `;
}

export function updateFinanceMemo(id: bigint, memo: string | undefined) {
  return sql.command`
    UPDATE "재무 거래"
    /*@braid set*/
      /*@braid if ${memo !== undefined}*/ "메모" = ${memo}, /*@braid end*/
    /*@braid end*/
    WHERE "거래 ID" = ${id}
  `;
}

export function trimFinanceFilter(customer: string | undefined) {
  return sql.rows(financeSchema)`
    SELECT
      "거래 ID" AS id,
      "고객 이름" AS customer,
      "금액" AS amount,
      "상태" AS status,
      "메모" AS memo
    FROM "재무 거래"
    /*@braid trim prefix="WHERE " prefixOverrides="AND|OR"*/
      /*@braid if ${customer !== undefined}*/ AND "고객 이름" = ${customer.trim()} /*@braid end*/
    /*@braid end*/
  `;
}

export type FinanceQuery = ReturnType<typeof selectFinanceRows>;
export type FinanceQueryRow = FinanceQuery extends import("@sqlbraid/core").Query<infer Row, "rows"> ? Row : never;
const _financeRowTypeCheck: FinanceRow | undefined = undefined as FinanceQueryRow | undefined;
void _financeRowTypeCheck;
