import type { StandardSchemaV1 } from "@sqlbraid/core";

export interface FinanceRow {
  readonly id: string;
  readonly customer: string;
  readonly amount: number;
  readonly status: string;
  readonly memo: string | null;
}

function issue(message: string): StandardSchemaV1.FailureResult {
  return { issues: [{ message }] };
}

export const financeSchema: StandardSchemaV1<unknown, FinanceRow> = {
  "~standard": {
    version: 1,
    vendor: "sqlbraid-tanstack-start-finance",
    validate(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return issue("finance row must be an object");
      const row = value as Record<string, unknown>;
      if (typeof row.id !== "string") return issue("finance row id must be string");
      if (typeof row.customer !== "string") return issue("finance row customer must be string");
      if (typeof row.amount !== "number") return issue("finance row amount must be number");
      if (typeof row.status !== "string") return issue("finance row status must be string");
      if (row.memo !== null && typeof row.memo !== "string") return issue("finance row memo must be string or null");
      return {
        value: {
          id: row.id,
          customer: row.customer,
          amount: row.amount,
          status: row.status,
          memo: row.memo,
        },
      };
    },
  },
};
