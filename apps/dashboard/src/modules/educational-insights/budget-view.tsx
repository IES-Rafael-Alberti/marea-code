import type * as z from "zod";
import type { DashboardLocale } from "../../messages.js";
import type { budgetSchema } from "./schemas.js";
import { insightsMessages } from "./messages.js";
export function AnalysisBudget({
  budget,
  locale,
}: {
  readonly budget: z.infer<typeof budgetSchema> | null | undefined;
  readonly locale: DashboardLocale;
}) {
  if (budget == null) return null;
  const m = insightsMessages(locale);
  return (
    <details>
      <summary>{m.budget}</summary>
      <p>
        {m.requests}: {budget.requests}/{budget.maxRequests} · {m.tokens}: {budget.tokens}/
        {budget.maxTokens}
      </p>
      <p>
        {budget.costUnits}/{budget.maxCostUnits} {budget.costUnit}
      </p>
    </details>
  );
}
