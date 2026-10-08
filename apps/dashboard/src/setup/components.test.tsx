import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { tree, text, control, change } from "../modules/server-settings/forms.fixture.js";
import type { EditableSettings } from "../modules/server-settings/client.boundary.js";
import { setupInput } from "./setup.fixture.js";
import { setupMessages } from "./messages.js";
import { SchoolFields, AccessFields } from "./fields.js";
import { SetupFeatures } from "./features.js";
import { SetupReview } from "./review.js";
import { SetupModel, isSetupModelReady } from "./model.js";
const m = setupMessages("en");
afterEach(() => {
  vi.unstubAllGlobals();
});
it("validates passwords and confirmation at the field and responds when touched values change", () => {
  class Input {
    dataset: Record<string, string> = {};
    validity = { valid: false };
    validationMessage = "Invalid";
    setAttribute = vi.fn();
    setCustomValidity = vi.fn();
    closest = () => null;
  }
  vi.stubGlobal("HTMLInputElement", Input);
  for (const [password, confirmation, error] of [
    ["tiny", "other", m.passwordHelp],
    ["x".repeat(257), "different", m.passwordHelp],
    ["valid-password", "valid-password", ""],
    ["x".repeat(12), "different", ""],
    ["x".repeat(256), "different", ""],
  ] as const) {
    const nodes = tree(
      <SchoolFields
        value={setupInput({ password })}
        change={vi.fn()}
        confirmation={confirmation}
        confirm={vi.fn()}
        m={m}
        locale="en"
      />,
    );
    expect(control(nodes, m.password).value).toBe(password);
    expect(control(nodes, m.confirmation).value).toBe(confirmation);
    const inputs = nodes.filter((node) => node.type === "input");
    for (const node of inputs) {
      const ref = node.props.ref as (input: Input | null) => void;
      ref(null);
      const input = new Input();
      ref(input);
      expect(input.setAttribute).not.toHaveBeenCalled();
      input.dataset.touched = "true";
      ref(input);
      expect(input.setAttribute).toHaveBeenCalledWith("aria-invalid", "true");
      if (node.props["aria-label"] === m.password)
        expect(input.setCustomValidity).toHaveBeenLastCalledWith(error);
      if (node.props["aria-label"] === m.confirmation)
        expect(input.setCustomValidity).toHaveBeenLastCalledWith(
          password === confirmation ? "" : m.mismatch,
        );
    }
    const blur = nodes.find((node) => node.props.className === "setup-grid")?.props.onBlur as (
      event: object,
    ) => void;
    blur({ target: {} });
    const input = new Input();
    blur({ target: input });
    expect(input.dataset.touched).toBe("true");
  }
});
it("offers local addresses without showing an editable port until connection options are opened", () => {
  const value = setupInput();
  const edit = vi.fn();
  const render = (addresses?: string[]) =>
    tree(<AccessFields value={value} change={edit} m={m} addresses={addresses} />);
  expect(text(render())).toContain(m.noAddress);
  expect(text(render(["192.168.1.20"]))).toContain(`http://192.168.1.20:${String(value.port)}`);
  expect(
    renderToStaticMarkup(
      <AccessFields value={value} change={edit} m={m} addresses={["192.168.1.20", "10.0.0.2"]} />,
    ),
  ).toMatchSnapshot("available LAN interfaces");
  const nodes = render(["192.168.1.20", "10.0.0.2"]);
  expect(text(nodes)).toContain("http://10.0.0.2:18793");
  expect(nodes.some((node) => node.type === "select")).toBe(false);
  expect(nodes.some((node) => node.type === "details" && node.props.open !== true)).toBe(true);
});
it("optional features preserve each other's settings and the testing skill is independent", () => {
  const edit = vi.fn();
  const value = setupInput();
  for (const label of [m.map, m.reports, m.evaluation, m.testing]) {
    const nodes = tree(<SetupFeatures value={value} change={edit} m={m} />);
    expect(control(nodes, label).checked).toBe(false);
    change(control(nodes, label), { checked: true });
    const next = edit.mock.lastCall?.[0] as typeof value;
    expect(control(tree(<SetupFeatures value={next} change={edit} m={m} />), label).checked).toBe(
      true,
    );
  }
  const enabled = {
    ...value,
    testingSkill: true,
    features: { map: true, reports: true, automaticEvaluation: true },
  };
  expect(
    renderToStaticMarkup(<SetupFeatures value={enabled} change={edit} m={m} />),
  ).toMatchSnapshot("enabled optional features");
  change(control(tree(<SetupFeatures value={enabled} change={edit} m={m} />), m.map), {
    checked: false,
  });
  expect(edit).toHaveBeenLastCalledWith({
    ...enabled,
    features: { ...enabled.features, map: false },
  });
});
it("review lists only enabled features and each change action targets the owning step", () => {
  const edit = vi.fn<(step: number) => void>();
  const empty = tree(<SetupReview value={setupInput()} model="custom/model" m={m} edit={edit} />);
  expect(text(empty)).toContain(m.none);
  for (const button of empty.filter((node) => node.type === "button"))
    (button.props.onClick as () => void)();
  expect(edit.mock.calls.map((call) => call[0])).toEqual([0, 0, 1, 2, 3]);
  const full = tree(
    <SetupReview
      value={setupInput({
        access: "https",
        publicOrigin: "https://school.test",
        testingSkill: true,
        features: { map: true, reports: true, automaticEvaluation: true },
      })}
      model="model"
      m={m}
      edit={edit}
    />,
  );
  expect(text(full)).toContain([m.map, m.reports, m.evaluation, m.testing].join(" · "));
  for (const caption of [m.map, m.reports, m.evaluation, m.testing, "https://school.test"])
    expect(text(full)).toContain(caption);
});
it("selects a provider once, starts an unlimited route and requires its actual model check", () => {
  const edit = vi.fn();
  const changeConnections = vi.fn();
  const state: EditableSettings = {
    administrator: true,
    initialized: true,
    revision: 0,
    useCommonRoute: true,
    legacyRoutes: [],
    route: null,
    education: {},
    providers: [
      {
        id: "one",
        values: {},
        secrets: [],
        configured: false,
        descriptor: { version: 1, name: { en: "One", es: "Uno", eu: "Bat" }, fields: [] },
      },
      { id: "missing", values: {}, secrets: [], configured: false, descriptor: null },
    ],
  };
  const nodes = tree(
    <SetupModel
      settings={state}
      connections={{}}
      changeConnections={changeConnections}
      edit={edit}
      locale="en"
      catalogs={{}}
      refresh={vi.fn()}
    />,
  );
  expect(
    renderToStaticMarkup(
      <SetupModel
        settings={state}
        connections={{}}
        changeConnections={changeConnections}
        edit={edit}
        locale="en"
        catalogs={{}}
        refresh={vi.fn()}
      />,
    ),
  ).toMatchSnapshot("multiple providers awaiting selection");
  change(control(nodes, m.steps[1]), { value: "one" });
  expect(changeConnections).toHaveBeenCalledWith({ one: {} });
  expect(edit.mock.lastCall?.[0]).toMatchObject({ route: { model: "" } });
  expect(edit.mock.lastCall?.[0]).toMatchObject({
    route: {
      providerId: "one",
      budget: { tutoring: { unlimited: true }, evaluation: { unlimited: true } },
    },
  });
  expect(isSetupModelReady(null, state.providers, {})).toBe(false);
  expect(isSetupModelReady({ providerId: "one", model: "x" }, state.providers, {})).toBe(false);
  const route = { ...setupInput().route, providerId: "one" };
  expect(isSetupModelReady(route, state.providers, {})).toBe(true);
  const available = state.providers.map((p) => ({ ...p, supportsModels: true }));
  expect(isSetupModelReady(route, available, {})).toBe(false);
  expect(isSetupModelReady(route, [], {})).toBe(false);
  expect(isSetupModelReady(route, available, { one: { status: "ready", models: [] } })).toBe(true);
});

it("edits the password and its confirmation independently", () => {
  const edit = vi.fn();
  const confirm = vi.fn();
  const value = setupInput();
  const nodes = tree(
    <SchoolFields
      value={value}
      change={edit}
      confirmation=""
      confirm={confirm}
      m={m}
      locale="en"
    />,
  );
  change(control(nodes, m.password), { value: "new-password" });
  expect(edit).toHaveBeenCalledWith({ ...value, password: "new-password" });
  expect(confirm).not.toHaveBeenCalled();
  change(control(nodes, m.confirmation), { value: "different-confirmation" });
  expect(confirm).toHaveBeenCalledWith("different-confirmation");
  expect(edit).toHaveBeenCalledOnce();
});
