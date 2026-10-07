import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ModelInput, pricedBudget } from "./model-input.js";
import { BudgetFields, emptyBudget } from "./budget-fields.js";
import { ModelSettings } from "./model-settings.js";
import { ProviderConnections } from "./provider-connections.js";
import { serverSettingsMessages } from "./messages.js";
import type { EditableSettings } from "./client.boundary.js";
import { tree, text, control, change } from "./forms.fixture.js";
const m = serverSettingsMessages("en");
const pricing = {
  costUnit: "nanoUSD",
  inputCostUnitsPerToken: 1250,
  outputCostUnitsPerToken: 5000,
};
const catalog = {
  p: { status: "ready" as const, models: [{ id: "org/model", name: "Model", pricing }] },
};
const budget = { inputTokenCeiling: 131072, tutoring: emptyBudget(), evaluation: emptyBudget() };
const state: EditableSettings = {
  administrator: true,
  initialized: true,
  revision: 0,
  useCommonRoute: false,
  legacyRoutes: [],
  route: { providerId: "p", model: "manual", budget },
  education: {
    map: { providerId: "p", model: "map", inputTokenCeiling: 131072, budget: emptyBudget() },
  },
  providers: [
    {
      id: "p",
      configured: true,
      descriptor: { version: 1, name: { es: "P", en: "P", eu: "P" }, fields: [] },
      values: {},
      secrets: [],
    },
  ],
};
it("offers catalog suggestions and preserves manual model IDs", () => {
  const changed = vi.fn();
  const nodes = tree(
    <ModelInput
      id="models-main"
      label={m.model}
      providerId="p"
      value=""
      catalogs={catalog}
      change={changed}
    />,
  );
  expect(nodes.find((node) => node.type === "input")?.props.list).toBe("models-main");
  expect(nodes.find((node) => node.type === "datalist")?.props.id).toBe("models-main");
  expect(nodes.find((node) => node.type === "option")?.props.value).toBe("org/model");
  change(control(nodes, m.model), { value: "org/model" });
  expect(changed).toHaveBeenLastCalledWith("org/model", pricing);
  change(control(nodes, m.model), { value: "my/manual-id" });
  expect(changed).toHaveBeenLastCalledWith("my/manual-id", undefined);
  expect(pricedBudget(emptyBudget(), null)).toEqual(emptyBudget());
});
it("applies catalog prices to the chosen purpose, leaving explicit evaluation overrides intact", () => {
  const edit = vi.fn<(next: EditableSettings) => void>();
  const render = (value: EditableSettings) =>
    tree(
      <ModelSettings
        state={value}
        connections={{ p: {} }}
        locale="en"
        edit={edit}
        catalogs={catalog}
      />,
    );
  const nodes = render(state);
  change(control(nodes, m.model), { value: "org/model" });
  expect(edit.mock.lastCall?.[0].route?.budget).toEqual({
    ...budget,
    tutoring: { ...budget.tutoring, ...pricing },
    evaluation: { ...budget.evaluation, ...pricing },
  });
  change(control(nodes, m.model, 1), { value: "org/model" });
  expect(edit.mock.lastCall?.[0].route?.budget).toEqual({
    ...budget,
    evaluation: { ...budget.evaluation, ...pricing },
  });
  change(control(nodes, m.model, 2), { value: "org/model" });
  expect(edit.mock.lastCall?.[0].education.map?.budget).toEqual({ ...emptyBudget(), ...pricing });
  const separate = {
    ...state,
    route: {
      providerId: "p",
      model: "manual",
      budget,
      evaluation: { providerId: "p", model: "separate" },
    },
  };
  change(control(render(separate), m.model), { value: "org/model" });
  expect(edit.mock.lastCall?.[0].route?.budget?.evaluation).toEqual(budget.evaluation);
  expect(nodes.filter((node) => node.type === "label" && text(node) === m.common)).toHaveLength(0);
  change(control(nodes, m.provider), { value: "p" });
  expect(edit.mock.lastCall?.[0].useCommonRoute).toBe(true);
});
it("shows editable USD per million prices and hides usage ceilings until enabled", () => {
  const changed = vi.fn();
  const value = { ...emptyBudget(), ...pricing };
  const nodes = tree(<BudgetFields m={m} value={value} change={changed} />);
  expect(control(nodes, m.unlimited).checked).toBe(true);
  expect(control(nodes, m.inputPriceUsd).value).toBe(1.25);
  expect(control(nodes, m.outputPriceUsd).value).toBe(5);
  expect(() => control(nodes, m.requests)).toThrow("Missing control");
  change(control(nodes, m.inputPriceUsd), { valueAsNumber: 2.125 });
  expect(changed).toHaveBeenLastCalledWith({ ...value, inputCostUnitsPerToken: 2125 });
  change(control(nodes, m.outputPriceUsd), { valueAsNumber: 0 });
  expect(changed).toHaveBeenLastCalledWith({ ...value, outputCostUnitsPerToken: 0 });
  change(control(nodes, m.unlimited), { checked: false });
  expect(changed).toHaveBeenLastCalledWith({ ...value, unlimited: false });
});
it.each(["loading", "ready", "invalid", "unavailable"] as const)(
  "shows connection catalog status and retry controls: %s",
  (status) => {
    const refresh = vi.fn();
    const nodes = tree(
      <ProviderConnections
        state={state}
        connections={{ p: {} }}
        locale="en"
        change={vi.fn()}
        catalogs={{ p: { ...catalog.p, status } }}
        refresh={refresh}
      />,
    );
    const message = nodes.find((node) => node.props.role === "status");
    expect(text(message)).toBe(
      status === "ready"
        ? `${m.modelsReady} (1)${m.modelsRefresh}`
        : status === "loading"
          ? m.modelsLoading
          : `${status === "invalid" ? m.modelsInvalid : m.modelsUnavailable}${m.modelsRefresh}`,
    );
    const retry = nodes.find((node) => node.type === "button");
    if (status === "loading") expect(retry).toBeUndefined();
    else {
      (retry?.props.onClick as () => void)();
      expect(refresh).toHaveBeenCalledOnce();
    }
  },
);

it("shows a limited dollar budget in USD and retains exact stored nanodollars", () => {
  const changed = vi.fn();
  const value = { ...emptyBudget(), ...pricing, unlimited: false };
  const nodes = tree(<BudgetFields m={m} value={value} change={changed} />);
  expect(control(nodes, m.costUsd).value).toBe(10);
  change(control(nodes, m.costUsd), { valueAsNumber: 5.125 });
  expect(changed).toHaveBeenLastCalledWith({ ...value, maxCostUnits: 5125000000 });
});

it.each([false, true])(
  "preserves the complete model and pricing form with legacy routes=%s",
  (legacy) => {
    const selected: EditableSettings = {
      ...state,
      legacyRoutes: legacy
        ? [{ classId: "class:old", route: { providerId: "p", model: "old" } }]
        : [],
      route: {
        providerId: "p",
        model: "org/model",
        budget: {
          ...budget,
          tutoring: { ...emptyBudget(), ...pricing },
          evaluation: {
            ...emptyBudget(),
            unlimited: false,
            costUnit: "credits",
            inputCostUnitsPerToken: 2,
            outputCostUnitsPerToken: 3,
          },
        },
      },
    };
    expect(
      renderToStaticMarkup(
        <ModelSettings
          state={selected}
          connections={{ p: {} }}
          locale="en"
          edit={vi.fn()}
          catalogs={catalog}
        />,
      ),
    ).toMatchSnapshot();
  },
);
it("offers no suggestions for a provider without a catalog", () => {
  const nodes = tree(
    <ModelInput
      id="manual"
      label={m.model}
      providerId="unknown"
      value="custom/id"
      catalogs={{}}
      change={vi.fn()}
    />,
  );
  expect(nodes.filter((node) => node.type === "option")).toHaveLength(0);
});
it("edits token counts independently of the selected price currency", () => {
  const changed = vi.fn();
  const value = { ...emptyBudget(), ...pricing, unlimited: false };
  const nodes = tree(<BudgetFields m={m} value={value} change={changed} />);
  expect(control(nodes, m.input).value).toBe(131072);
  change(control(nodes, m.input), { valueAsNumber: 20 });
  expect(changed).toHaveBeenLastCalledWith({ ...value, maxInputTokens: 20 });
  const generic = {
    ...emptyBudget(),
    costUnit: "credits",
    inputCostUnitsPerToken: 2,
    outputCostUnitsPerToken: 3,
  };
  const prices = tree(<BudgetFields m={m} value={generic} change={changed} />);
  change(control(prices, m.inputPrice), { valueAsNumber: 5 });
  expect(changed).toHaveBeenLastCalledWith({ ...generic, inputCostUnitsPerToken: 5 });
});
