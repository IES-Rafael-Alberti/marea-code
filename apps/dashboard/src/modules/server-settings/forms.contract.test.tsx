import { expect, it, vi } from "vitest";
import type { EditableSettings } from "./client.boundary.js";
import { emptyBudget } from "./budget-fields.js";
import { change, control, options, text, tree } from "./forms.fixture.js";
import { serverSettingsMessages } from "./messages.js";
import { ModelSettings } from "./model-settings.js";
import { ProviderConnections } from "./provider-connections.js";

const m = serverSettingsMessages("en");
const one = { es: "Uno", en: "One", eu: "Bat" };
const policy = (maxInputTokens: number) => ({ ...emptyBudget(), maxInputTokens });
const budget = { inputTokenCeiling: 50, tutoring: policy(80), evaluation: policy(50) };
const field = { key: "token", label: one, kind: "secret" as const, required: true };
const provider = (id: string, secrets: string[] = []) => ({
  id,
  descriptor: { version: 1 as const, name: { ...one, en: `Name ${id}` }, fields: [field] },
  configured: true,
  values: {},
  secrets,
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
    { value: "p2", disabled: false, text: "p2" },
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
  expect(nodes.filter((node) => node.type === "details").map((node) => node.props.open)).toEqual([
    true,
    true,
    true,
    false,
    true,
  ]);
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
