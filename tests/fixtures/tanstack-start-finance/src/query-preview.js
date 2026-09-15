import { sql } from "@sqlbraid/template";

export function previewJavaScript(includePending) {
  return sql`
    SELECT "거래 ID" AS id
    FROM "재무 거래"
    /*@braid where*/
      /*@braid if ${includePending}*/ AND "상태" IN ('완료', '대기') /*@braid end*/
    /*@braid end*/
  `;
}
