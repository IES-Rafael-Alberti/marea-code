import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AnalysisBudget } from "./budget-view.js";
it("renders unlimited ceilings without hiding recorded usage", () => {
  const html = renderToStaticMarkup(
    <AnalysisBudget
      locale="en"
      budget={{
        requests: 2,
        tokens: 100,
        costUnits: 30,
        maxRequests: null,
        maxTokens: null,
        maxCostUnits: null,
        costUnit: "nanoUSD",
      }}
    />,
  );
  expect(html).toContain("2/∞");
  expect(html).toContain("100/∞");
  expect(html).toContain("30/∞ nanoUSD");
});
