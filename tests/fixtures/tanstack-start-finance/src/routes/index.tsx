import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { FinanceTable, previewQuery } from "../FinanceTable";

const loadFinance = createServerFn({ method: "GET" }).handler(async () => {
  const { readFinanceRows } = await import("../finance.server");
  return {
    rows: await readFinanceRows(),
    queryText: previewQuery(false).render().segments.join(""),
  };
});

export const Route = createFileRoute("/")({
  loader: () => loadFinance(),
  component: FinancePage,
});

function FinancePage() {
  const { rows, queryText } = Route.useLoaderData();
  return <FinanceTable rows={rows} queryText={queryText} />;
}
