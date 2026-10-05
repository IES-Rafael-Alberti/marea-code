import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditableSettings } from "./client.boundary.js";
import { emptyBudget } from "./budget-fields.js";
import { change, control, text, tree } from "./forms.fixture.js";
import { serverSettingsMessages } from "./messages.js";
import { ServerSettingsView } from "./view.js";

type HookValue = object | string | number | boolean | null;
const hooks = vi.hoisted(() => ({
  values: [] as HookValue[],
  index: 0,
  effects: [] as (() => undefined | (() => void))[],
  dependencies: [] as (readonly HookValue[])[],
}));
const client = vi.hoisted(() => ({ settingsRequest: vi.fn(), saveSettings: vi.fn() }));
vi.mock("./client.boundary.js", () => client);
/** Each slot keeps its value across renders; setters write the slot directly. */
function slot(initial: HookValue): [HookValue, (value: HookValue) => void] {
  const position = hooks.index;
  hooks.index += 1;
  if (!(position in hooks.values)) hooks.values[position] = initial;
  const write = (value: HookValue) => {
    hooks.values[position] = value;
  };
  return [hooks.values[position] ?? null, write];
}
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const effect = (run: () => undefined | (() => void), dependencies: readonly HookValue[]) => {
    hooks.effects.push(run);
    hooks.dependencies.push(dependencies);
  };
  return { ...react, useEffect: effect, useState: slot };
});
const m = serverSettingsMessages("en");
const fetchRequest = vi.fn();
function render() {
  hooks.index = 0;
  hooks.effects = [];
  hooks.dependencies = [];
  return tree(<ServerSettingsView fetchRequest={fetchRequest} locale="en" />);
}
const page = () =>
  render()
    .map((node) => text(node))
    .join("|");
const settings: EditableSettings = {
  administrator: true,
  initialized: true,
  revision: 2,
  useCommonRoute: false,
  route: null,
  education: {},
  legacyRoutes: [],
  providers: [
    {
      id: "p1",
      descriptor: { version: 1, name: { es: "P", en: "P", eu: "P" }, fields: [] },
      configured: true,
      values: { endpoint: "https://kept.test" },
      secrets: [],
    },
    { id: "p2", descriptor: null, configured: false, values: {}, secrets: [] },
  ],
};
const window = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  confirm: vi.fn(),
};
/** Runs the initial read effect and waits for its settled callbacks. */
async function load(result: Promise<object>) {
  client.settingsRequest.mockReturnValue(result);
  render();
  const cleanup = hooks.effects[0]?.();
  await result.catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  return cleanup;
}
const submit = (preventDefault = vi.fn()) => {
  const form = render().find((node) => node.type === "form");
  (form?.props.onSubmit as (event: object) => void)({ preventDefault });
  return preventDefault;
};
beforeEach(() => {
  hooks.values = [];
  vi.clearAllMocks();
  vi.stubGlobal("window", window);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("loads the editable projection and keeps only configured connections", async () => {
  expect(page()).toContain(m.loading);
  await load(Promise.resolve(settings));
  expect(client.settingsRequest).toHaveBeenCalledWith(
    fetchRequest,
    { operation: "read" },
    expect.any(AbortSignal),
  );
  expect(hooks.values[1]).toEqual({ p1: { endpoint: "https://kept.test" } });
  expect(page()).toContain(m.roleAdmin);
});

it("explains access for other teachers and before the offline grant", async () => {
  await load(Promise.resolve({ administrator: false, initialized: true }));
  expect(page()).toContain(m.access);
  hooks.values = [];
  await load(Promise.resolve({ administrator: false, initialized: false }));
  expect(page()).toContain(m.setup);
  expect(hooks.values[1]).toEqual({});
});

it("reports an unavailable read with a retry and ignores results after unmount", async () => {
  await load(Promise.reject(new Error("synthetic-read-failure")));
  expect(page()).toContain(m.error);
  const retry = render().find((node) => node.type === "button");
  (retry?.props.onClick as () => void)();
  expect(hooks.values[6]).toBe(1);
  hooks.values = [];
  let resolve: (value: EditableSettings) => void = () => undefined;
  client.settingsRequest.mockReturnValue(
    new Promise((settle) => {
      resolve = settle;
    }),
  );
  render();
  hooks.effects[0]?.()?.();
  resolve(settings);
  await Promise.resolve();
  await Promise.resolve();
  expect(hooks.values[0]).toBeNull();
  hooks.values = [];
  let reject: (reason: Error) => void = () => undefined;
  client.settingsRequest.mockReturnValue(
    new Promise((_settle, refuse) => {
      reject = refuse;
    }),
  );
  render();
  hooks.effects[0]?.()?.();
  reject(new Error("synthetic-late-failure"));
  await Promise.resolve();
  await Promise.resolve();
  expect(hooks.values[2]).toBeNull();
  // An abandoned read never clears the busy marker of the read that replaced it.
  expect(hooks.values[3]).toBe(true);
});

it("tracks unsaved edits, guards leaving and confirms a reload that would discard them", async () => {
  await load(Promise.resolve(settings));
  hooks.values[2] = "invalid";
  change(control(render(), m.provider), { value: "p1" });
  expect(hooks.values[2]).toBeNull();
  expect(hooks.values[4]).toBe(true);
  hooks.values[2] = "invalid";
  hooks.values[5] = true;
  change(control(render(), m.connect), { checked: false });
  expect(hooks.values).toMatchObject({ 1: {}, 2: null, 4: true, 5: false });
  change(control(render(), m.connect), { checked: true });
  expect(hooks.values[1]).toEqual({ p1: { endpoint: "https://kept.test" } });
  change(control(render(), m.provider), { value: "p1" });
  expect(page()).toContain(m.pending);
  render();
  const remove = hooks.effects[1]?.();
  const prevent = window.addEventListener.mock.lastCall?.[1] as (event: object) => void;
  const preventDefault = vi.fn();
  prevent({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  remove?.();
  expect(window.removeEventListener).toHaveBeenCalledWith("beforeunload", prevent);
  hooks.values[4] = false;
  render();
  hooks.effects[1]?.();
  (window.addEventListener.mock.lastCall?.[1] as (event: object) => void)({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  hooks.values[4] = true;
  const reload = render().find((node) => node.type === "button" && text(node) === m.reload)?.props
    .onClick as () => void;
  window.confirm.mockReturnValueOnce(false);
  reload();
  expect(hooks.values[6]).toBe(0);
  window.confirm.mockReturnValueOnce(true);
  reload();
  expect(hooks.values[6]).toBe(1);
});

it("saves with the read revision and shows the confirmed or refused outcome", async () => {
  await load(Promise.resolve(settings));
  const confirmed = { ...settings, revision: 3, useCommonRoute: true };
  client.saveSettings.mockResolvedValueOnce({ ok: true, value: confirmed });
  expect(submit()).toHaveBeenCalledOnce();
  expect(client.saveSettings).toHaveBeenCalledWith(
    fetchRequest,
    {
      operation: "save",
      expectedRevision: 2,
      connections: { p1: { endpoint: "https://kept.test" } },
      route: null,
      education: {},
      useCommonRoute: false,
    },
    expect.any(AbortSignal),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(hooks.values).toMatchObject({ 0: confirmed, 3: false, 5: true });
  expect(page()).toContain(m.saved);
  for (const [reason, message] of [
    ["conflict", m.conflict],
    ["invalid", m.invalid],
    ["unavailable", m.error],
  ] as const) {
    hooks.values[2] = null;
    client.saveSettings.mockResolvedValueOnce({ ok: false, reason });
    submit();
    await Promise.resolve();
    await Promise.resolve();
    expect(page()).toContain(message);
  }
  // An unresolved problem or a pending save blocks another write.
  submit();
  hooks.values[2] = null;
  hooks.values[3] = true;
  submit();
  expect(client.saveSettings).toHaveBeenCalledTimes(4);
});

it("lists limits for a configured route", async () => {
  const route = {
    providerId: "p1",
    model: "main",
    budget: { inputTokenCeiling: 1, tutoring: emptyBudget(), evaluation: emptyBudget() },
  };
  await load(Promise.resolve({ ...settings, route }));
  expect(page()).toContain(m.limitsStep);
});

it("starts idle, marks reads busy and clears an earlier problem once loaded", async () => {
  render();
  expect(hooks.values).toEqual([null, {}, null, false, false, false, 0]);
  expect(hooks.dependencies).toEqual([[fetchRequest, 0], [false]]);
  hooks.values[2] = "unavailable";
  hooks.values[4] = true;
  client.settingsRequest.mockResolvedValue(settings);
  hooks.effects[0]?.();
  expect(hooks.values[3]).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(hooks.values).toMatchObject({ 2: null, 3: false, 4: false });
  window.addEventListener.mockClear();
  render();
  hooks.effects[1]?.();
  expect(window.addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
});

it("names an unavailable read next to its retry", async () => {
  await load(Promise.reject(new Error("synthetic-read-failure")));
  expect(hooks.values[2]).toBe("unavailable");
  const alert = render().find((node) => node.props.role === "alert");
  expect(text(alert)).toBe(`${m.error} ${m.reload}`);
});

it("keeps unrelated problems while editing and records every edit", async () => {
  await load(Promise.resolve(settings));
  hooks.values[2] = "conflict";
  change(control(render(), m.provider), { value: "p1" });
  expect(hooks.values[2]).toBe("conflict");
  expect(hooks.values[0]).toMatchObject({ route: { providerId: "p1" } });
  change(control(render(), m.connect), { checked: false });
  expect(hooks.values[2]).toBe("conflict");
  expect(hooks.values[1]).toEqual({});
});

it("enables saving only for an idle, unsaved draft without problems, and marks it busy", async () => {
  await load(Promise.resolve(settings));
  const save = () =>
    render().find((node) => node.type === "button" && node.props.type === "submit")?.props.disabled;
  expect(save()).toBe(true);
  hooks.values[4] = true;
  expect(save()).toBe(false);
  hooks.values[3] = true;
  expect(save()).toBe(true);
  hooks.values[3] = false;
  hooks.values[2] = "conflict";
  expect(save()).toBe(true);
  hooks.values[2] = null;
  hooks.values[5] = true;
  client.saveSettings.mockReturnValue(new Promise(() => undefined));
  submit();
  expect(hooks.values).toMatchObject({ 3: true, 5: false });
});

it("offers matching preview installation commands only to the server administrator", async () => {
  vi.stubGlobal("window", { ...window, location: { origin: "https://school.test" } });
  vi.stubEnv("VITE_MAREA_PREVIEW_REPOSITORY", "school/marea");
  vi.stubEnv("VITE_MAREA_PREVIEW_VERSION", "0.1.0-preview.1");
  await load(Promise.resolve(settings));
  expect(page()).toContain("Install Marea for students");
  hooks.values = [];
  await load(Promise.resolve({ administrator: false, initialized: true }));
  expect(page()).not.toContain("Install Marea for students");
});
