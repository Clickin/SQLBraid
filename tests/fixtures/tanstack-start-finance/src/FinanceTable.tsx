import { sql } from "@sqlbraid/sqlite";
import { financeSchema } from "./schema";

interface FinanceTableProps {
  readonly rows: readonly {
    readonly id: string;
    readonly customer: string;
    readonly amount: number;
    readonly status: string;
    readonly memo: string | null;
  }[];
  readonly queryText: string;
}

export function previewQuery(includePending: boolean) {
  return sql.rows(financeSchema)`
    SELECT "거래 ID" AS id, "고객 이름" AS customer, "금액" AS amount, "상태" AS status, "메모" AS memo
    FROM "재무 거래"
    /*@braid where*/
      /*@braid choose*/
        /*@braid when ${includePending}*/ AND "상태" IN ('완료', '대기')
        /*@braid otherwise*/ AND "상태" = '완료'
      /*@braid end*/
    /*@braid end*/
  `;
}

export function FinanceTable({ rows, queryText }: FinanceTableProps) {
  return (
    <section>
      <h1>재무 거래</h1>
      <code data-query-preview={queryText}>SQLBraid finance preview</code>
      <table>
        <thead>
          <tr><th>거래 ID</th><th>고객</th><th>금액</th><th>상태</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id.toString()}>
              <td>{row.id.toString()}</td>
              <td>{row.customer}</td>
              <td>{row.amount.toFixed(2)}</td>
              <td>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
