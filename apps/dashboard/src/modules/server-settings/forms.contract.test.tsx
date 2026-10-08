import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { EditableSettings } from "./client.boundary.js";
import { BudgetFields, emptyBudget } from "./budget-fields.js";
import { change, control, options, text, tree } from "./forms.fixture.js";
import { serverSettingsMessages } from "./messages.js";
import { ModelSettings } from "./model-settings.js";
import { ProviderConnections } from "./provider-connections.js";

const m = serverSettingsMessages("en");
const one = { es: "Uno", en: "One", eu: "Bat" };
const policy = (maxInputTokens: number) => ({ ...emptyBudget(), unlimited: false, maxInputTokens });
const budget = { inputTokenCeiling: 50, tutoring: policy(80), evaluation: policy(50) };
const field = { key: "token", label: one, kind: "secret" as const, required: true };
const provider = (id: string, secrets: string[] = []) => ({
  id,
  descriptor: { version: 1 as const, name: { ...one, en: `Name ${id}` }, fields: [field] },
  configured: true,
  values: {},
  secrets,
});
const providerWithOptionalEndpoint = () => ({
  ...provider("p1"),
  descriptor: {
    ...provider("p1").descriptor,
    fields: [
      field,
      {
        key: "endpoint",
        label: { ...one, en: "Endpoint" },
        kind: "url" as const,
        required: false,
      },
    ],
  },
});
const task = (providerId: string) => ({
  providerId,
  model: "task-model",
  inputTokenCeiling: 1,
  budget: policy(1),
});
const settings = (overrides: Partial<EditableSettings> = {}): EditableSettings => ({
  administrator: true,
  initialized: true,
  revision: 1,
  useCommonRoute: false,
  route: null,
  education: {},
  legacyRoutes: [],
  providers: [
    provider("p1"),
    { id: "p2", descriptor: null, configured: true, values: {}, secrets: [] },
    provider("p3"),
  ],
  ...overrides,
});
const render = (state: EditableSettings, edit = vi.fn<(next: EditableSettings) => void>()) => ({
  edit,
  nodes: tree(
    <ModelSettings state={state} connections={{ p1: {}, p2: {} }} locale="en" edit={edit} />,
  ),
});

it("offers only connected providers, with a placeholder only for the main route", () => {
  const empty = render(settings()).nodes;
  expect(control(empty, m.provider).value).toBe("");
  expect(options(empty, m.provider)).toEqual([
    { value: "", disabled: true, text: m.provider },
    { value: "p1", disabled: false, text: "Name p1" },
    { value: "p2", disabled: true, text: "p2" },
  ]);
  const route = { providerId: "p1", model: "main", budget };
  const routed = render(settings({ route, education: { map: task("p2") } })).nodes;
  expect(control(routed, m.provider).value).toBe("p1");
  for (const index of [1, 2])
    expect(options(routed, m.provider, index).map((option) => option.value)).toEqual(["p1", "p2"]);
  expect(control(routed, m.enable).checked).toBe(true);
  expect(control(routed, m.enable, 1).checked).toBe(false);
});

it("keeps the shared input ceiling within the other purpose and removes disabled tasks", () => {
  const route = { providerId: "p1", model: "main", budget };
  const state = settings({ route, education: { map: task("p1") } });
  const { edit, nodes } = render(state);
  change(control(nodes, m.input), { valueAsNumber: 70 });
  expect(edit.mock.lastCall?.[0].route?.budget?.inputTokenCeiling).toBe(50);
  change(control(nodes, m.input, 1), { valueAsNumber: 90 });
  expect(edit.mock.lastCall?.[0].route?.budget?.inputTokenCeiling).toBe(80);
  change(control(nodes, m.enable), { checked: false });
  expect(edit.mock.lastCall?.[0].education).toStrictEqual({});
});

it("locks connections that any route, evaluation or task still selects", () => {
  const state = settings({
    route: {
      providerId: "p1",
      model: "main",
      budget,
      evaluation: { providerId: "p3", model: "judge" },
    },
    education: { reports: task("p4") },
    legacyRoutes: [{ classId: "class:a", route: { providerId: "p5", model: "legacy" } }],
    providers: [
      provider("p1"),
      provider("p3", ["token"]),
      provider("p4"),
      provider("p5"),
      provider("p6"),
    ],
  });
  const changed = vi.fn();
  const connected = { p1: {}, p3: {}, p4: {}, p6: {} };
  const nodes = tree(
    <ProviderConnections state={state} connections={connected} locale="en" change={changed} />,
  );
  // p5 is selected by an imported route but not connected, so it can still be connected.
  expect([0, 1, 2, 3, 4].map((index) => control(nodes, m.connect, index).disabled)).toEqual([
    true,
    true,
    true,
    false,
    false,
  ]);
  expect(nodes.filter((node) => text(node) === m.inUse && node.type === "p")).toHaveLength(3);
  expect(
    nodes
      .filter((node) => node.type === "details" && node.props.className === "workspace-advanced")
      .map((node) => node.props.open),
  ).toEqual([true, true, true, false, true]);
  expect(nodes.some((node) => text(node) === m.missing)).toBe(false);
  // A stored secret is optional to resend; a missing one is required.
  expect(control(nodes, "One").required).toBe(true);
  expect(control(nodes, "One", 1).required).toBe(false);
  change(control(nodes, m.connect, 4), { checked: false });
  expect(changed.mock.lastCall?.[0]).toStrictEqual({ p1: {}, p3: {}, p4: {} });
  const unrouted = settings({
    route: { providerId: "p1", model: "main", budget },
    providers: [provider("p1"), provider("p3")],
  });
  const plain = tree(
    <ProviderConnections
      state={unrouted}
      connections={{ p1: {}, p3: {} }}
      locale="en"
      change={changed}
    />,
  );
  expect([0, 1].map((index) => control(plain, m.connect, index).disabled)).toEqual([true, false]);
});

it("restores catalogue pricing without resetting usage limits", () => {
  const changeBudget = vi.fn();
  const value = policy(42);
  const pricing = {
    costUnit: "nanoUSD",
    inputCostUnitsPerToken: 100,
    outputCostUnitsPerToken: 300,
  };
  const nodes = tree(<BudgetFields value={value} pricing={pricing} change={changeBudget} m={m} />);
  expect(text(nodes)).toContain(m.manualPrices);
  (
    nodes.find((node) => node.type === "button" && text(node) === m.restorePrices)?.props
      .onClick as () => void
  )();
  expect(changeBudget).toHaveBeenCalledWith({ ...value, ...pricing });
  expect(
    text(
      tree(
        <BudgetFields
          value={{ ...value, ...pricing }}
          pricing={pricing}
          change={changeBudget}
          m={m}
        />,
      ),
    ),
  ).toContain(m.automaticPrices);
});
it("keeps optional provider fields under connection options during onboarding", () => {
  const providerWithOptions = providerWithOptionalEndpoint();
  const changed = vi.fn();
  const nodes = tree(
    <ProviderConnections
      state={settings({ providers: [providerWithOptions] })}
      connections={{ p1: {} }}
      locale="en"
      change={changed}
      onboarding
    />,
  );
  expect(
    nodes.find((node) => node.type === "details" && text(node).includes("Endpoint"))?.props.open,
  ).not.toBe(true);
  change(control(nodes, "Endpoint"), { value: "https://private.test" });
  expect(changed).toHaveBeenCalledWith({ p1: { endpoint: "https://private.test" } });
});

it("groups models, limits and optional model routes into separate sections", () => {
  const route = { providerId: "p1", model: "main", budget };
  const state = settings({ route });
  for (const section of ["all", "models", "limits", "features"] as const)
    expect(
      renderToStaticMarkup(
        <ModelSettings
          state={state}
          connections={{ p1: {}, p2: {} }}
          locale="en"
          edit={vi.fn()}
          section={section}
        />,
      ),
    ).toMatchSnapshot(section);
});
it("keeps imported class routes unless the common model was already selected", () => {
  for (const useCommonRoute of [false, true]) {
    const state = settings({
      useCommonRoute,
      legacyRoutes: [{ classId: "class:old", route: { providerId: "p2", model: "old" } }],
    });
    const { nodes, edit } = render(state);
    change(control(nodes, m.provider), { value: "p1" });
    expect(edit.mock.lastCall?.[0].useCommonRoute).toBe(useCommonRoute);
  }
});
it("distinguishes a manual override in either input or output prices", () => {
  const pricing = { costUnit: "nanoUSD", inputCostUnitsPerToken: 2, outputCostUnitsPerToken: 3 };
  for (const override of [{ inputCostUnitsPerToken: 7 }, { outputCostUnitsPerToken: 8 }]) {
    const nodes = tree(
      <BudgetFields
        value={{ ...emptyBudget(), ...pricing, ...override }}
        pricing={pricing}
        change={vi.fn()}
        m={m}
      />,
    );
    expect(text(nodes)).toContain(m.manualPrices);
    expect(text(nodes)).not.toContain(m.automaticPrices);
  }
});
it.each([false, true])(
  "preserves provider fields and their disclosure during setup: %s",
  (onboarding) => {
    const p = providerWithOptionalEndpoint();
    expect(
      renderToStaticMarkup(
        <ProviderConnections
          state={settings({ providers: [p] })}
          connections={{ p1: {} }}
          locale="en"
          change={vi.fn()}
          onboarding={onboarding}
        />,
      ),
    ).toMatchSnapshot(String(onboarding));
  },
);

it("chooses the shared route for a fresh server and hides empty connection options", () => {
  const { nodes, edit } = render(settings());
  change(control(nodes, m.provider), { value: "p1" });
  expect(edit.mock.lastCall?.[0].useCommonRoute).toBe(true);
  const requiredOnly = tree(
    <ProviderConnections
      state={settings({ providers: [provider("p1")] })}
      connections={{ p1: {} }}
      locale="en"
      change={vi.fn()}
      onboarding
    />,
  );
  expect(
    requiredOnly.some((node) => node.type === "summary" && text(node) === m.connectionOptions),
  ).toBe(false);
});
