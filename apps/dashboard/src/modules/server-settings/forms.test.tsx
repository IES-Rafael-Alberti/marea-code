import { expect, it, vi } from "vitest";
import type { EditableSettings } from "./client.boundary.js";
import { BudgetFields, emptyBudget } from "./budget-fields.js";
import { serverSettingsMessages } from "./messages.js";
import { ModelSettings } from "./model-settings.js";
import { ProviderConnections } from "./provider-connections.js";
import { change, control, text, tree } from "./forms.fixture.js";

const m = serverSettingsMessages("en");
const label = { es: "Uno", en: "One", eu: "Bat" };
const policy = (maxInputTokens: number) => ({ ...emptyBudget(), maxInputTokens });
const budget = { inputTokenCeiling: 50, tutoring: policy(80), evaluation: policy(50) };
const settings = (overrides: Partial<EditableSettings> = {}): EditableSettings => ({
  administrator: true,
  initialized: true,
  revision: 1,
  useCommonRoute: false,
  route: null,
  education: {},
  legacyRoutes: [
    { classId: "class:a", route: { providerId: "p1", model: "legacy-model" } },
    { classId: "class:gone", route: { providerId: "unknown", model: "orphan-model" } },
  ],
  providers: [
    {
      id: "p1",
      descriptor: { version: 1, name: label, fields: [] },
      configured: true,
      values: {},
      secrets: [],
    },
    { id: "p2", descriptor: null, configured: true, values: {}, secrets: [] },
  ],
  ...overrides,
});
const connections = { p1: {}, p2: {} };
const model = (state: EditableSettings, edit = vi.fn()) => ({
  edit,
  nodes: tree(
    <ModelSettings
      state={state}
      connections={connections}
      locale="en"
      edit={edit}
      classNames={{ "class:a": "Physics" }}
    />,
  ),
});

it("starts a route from a selected connection with zeroed limits to complete", () => {
  const { edit, nodes } = model(settings());
  expect(nodes.some((node) => node.type === "input")).toBe(false);
  change(control(nodes, m.provider), { value: "p2" });
  expect(edit).toHaveBeenCalledWith(
    expect.objectContaining({
      route: {
        providerId: "p2",
        model: "",
        budget: { inputTokenCeiling: 1, tutoring: emptyBudget(), evaluation: emptyBudget() },
      },
    }),
  );
});

it("edits the main route, adoption, limits and a separate evaluation model", () => {
  const route = { providerId: "p1", model: "main-model", budget };
  const state = settings({ route });
  const { edit, nodes } = model(state);
  const html = nodes.map((node) => text(node)).join("|");
  expect(html).toContain("Physics");
  expect(html).toContain("class:gone · unknown · orphan-model");
  expect(html).toContain(m.commonOff);
  change(control(nodes, m.provider), { value: "p2" });
  expect(edit).toHaveBeenLastCalledWith({ ...state, route: { ...route, providerId: "p2" } });
  change(control(nodes, m.model), { value: "other-model" });
  expect(edit).toHaveBeenLastCalledWith({ ...state, route: { ...route, model: "other-model" } });
  change(control(nodes, m.common), { checked: true });
  expect(edit).toHaveBeenLastCalledWith({ ...state, useCommonRoute: true });
  // Changing one purpose keeps the shared input ceiling within both budgets.
  change(control(nodes, m.input), { valueAsNumber: 30 });
  expect(edit).toHaveBeenLastCalledWith({
    ...state,
    route: { ...route, budget: { ...budget, tutoring: policy(30), inputTokenCeiling: 30 } },
  });
  change(control(nodes, m.input, 1), { valueAsNumber: 90 });
  expect(edit).toHaveBeenLastCalledWith({
    ...state,
    route: { ...route, budget: { ...budget, evaluation: policy(90), inputTokenCeiling: 80 } },
  });
  // The evaluation model defaults to the main route until it is chosen separately.
  expect(control(nodes, m.model, 1).value).toBe("main-model");
  change(control(nodes, m.model, 1), { value: "judge-model" });
  expect(edit).toHaveBeenLastCalledWith({
    ...state,
    route: { ...route, evaluation: { providerId: "p1", model: "judge-model" } },
  });
  change(control(nodes, m.provider, 1), { value: "p2" });
  expect(edit).toHaveBeenLastCalledWith({
    ...state,
    route: { ...route, evaluation: { providerId: "p2", model: "main-model" } },
  });
  const separate = { ...route, evaluation: { providerId: "p2", model: "judge-model" } };
  const adopted = model(settings({ route: separate, useCommonRoute: true, legacyRoutes: [] }));
  expect(control(adopted.nodes, m.model, 1).value).toBe("judge-model");
  expect(adopted.nodes.map((node) => text(node)).join("|")).toContain(m.commonOn);
  expect(adopted.nodes.some((node) => node.type === "details" && text(node).includes("("))).toBe(
    false,
  );
});

it("seeds limits for a route captured without a budget", () => {
  const route = { providerId: "p1", model: "main-model" };
  const { edit, nodes } = model(settings({ route }));
  change(control(nodes, m.requests), { valueAsNumber: 4 });
  expect(edit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      route: {
        ...route,
        budget: {
          inputTokenCeiling: 1,
          tutoring: { ...emptyBudget(), maxRequests: 4 },
          evaluation: emptyBudget(),
        },
      },
    }),
  );
});

it("enables, edits and disables the optional map and report tasks", () => {
  const route = { providerId: "p1", model: "main-model", budget };
  const reports = {
    providerId: "p1",
    model: "report-model",
    inputTokenCeiling: 50,
    budget: policy(50),
  };
  const state = settings({ route, education: { reports } });
  const { edit, nodes } = model(state);
  change(control(nodes, m.enable), { checked: true });
  expect(edit).toHaveBeenLastCalledWith({
    ...state,
    education: {
      reports,
      map: { providerId: "p1", model: "main-model", inputTokenCeiling: 50, budget: policy(50) },
    },
  });
  change(control(nodes, m.enable, 1), { checked: false });
  expect(edit).toHaveBeenLastCalledWith({ ...state, education: {} });
  change(control(nodes, m.model, 2), { value: "summary-model" });
  expect(edit).toHaveBeenLastCalledWith({
    ...state,
    education: { reports: { ...reports, model: "summary-model" } },
  });
  change(control(nodes, m.provider, 2), { value: "p2" });
  expect(edit).toHaveBeenLastCalledWith({
    ...state,
    education: { reports: { ...reports, providerId: "p2" } },
  });
  change(control(nodes, m.input, 2), { valueAsNumber: 20 });
  expect(edit).toHaveBeenLastCalledWith({
    ...state,
    education: { reports: { ...reports, budget: policy(20), inputTokenCeiling: 20 } },
  });
});

it("edits numeric limits and the configured cost unit", () => {
  const changed = vi.fn();
  const nodes = tree(<BudgetFields m={m} value={emptyBudget()} change={changed} />);
  change(control(nodes, m.unit), { value: "credits" });
  expect(changed).toHaveBeenLastCalledWith({ ...emptyBudget(), costUnit: "credits" });
});

it("connects, edits and protects provider connections", () => {
  const descriptor = {
    version: 1 as const,
    name: label,
    fields: [
      { key: "token", label, kind: "secret" as const, required: true },
      {
        key: "endpoint",
        label: { ...label, en: "Endpoint" },
        kind: "url" as const,
        required: false,
        defaultValue: "https://default.test",
      },
    ],
  };
  const state = settings({
    route: { providerId: "p1", model: "main-model", budget },
    legacyRoutes: [],
    education: {
      map: { providerId: "p3", model: "map-model", inputTokenCeiling: 1, budget: policy(1) },
    },
    providers: [
      { id: "p1", descriptor, configured: true, values: {}, secrets: ["token"] },
      {
        id: "p3",
        descriptor,
        configured: false,
        values: { endpoint: "https://kept.test" },
        secrets: [],
      },
      { id: "p2", descriptor: null, configured: true, values: {}, secrets: [] },
    ],
  });
  const changed = vi.fn();
  const values = { p1: { endpoint: "https://custom.test" }, p2: {} };
  const nodes = tree(
    <ProviderConnections state={state} connections={values} locale="en" change={changed} />,
  );
  const html = nodes.map((node) => text(node)).join("|");
  expect(html).toContain(m.inUse);
  expect(html).toContain(m.unavailable);
  const locked = control(nodes, m.connect);
  expect(locked.disabled).toBe(true);
  const token = control(nodes, "One");
  expect(token).toMatchObject({
    type: "password",
    required: false,
    placeholder: m.configured,
    value: "",
  });
  change(token, { value: "synthetic-rotated-secret" });
  expect(changed).toHaveBeenLastCalledWith({
    ...values,
    p1: { endpoint: "https://custom.test", token: "synthetic-rotated-secret" },
  });
  change(control(nodes, "Endpoint"), { value: "" });
  expect(changed).toHaveBeenLastCalledWith({ ...values, p1: {} });
  change(control(nodes, m.connect, 1), { checked: true });
  expect(changed).toHaveBeenLastCalledWith({ ...values, p3: { endpoint: "https://kept.test" } });
  change(locked, { checked: false });
  expect(changed).toHaveBeenLastCalledWith({ p2: {} });
  expect(
    tree(
      <ProviderConnections
        state={settings({ providers: [] })}
        connections={{}}
        locale="en"
        change={changed}
      />,
    )
      .map((node) => text(node))
      .join("|"),
  ).toContain(m.missing);
});
