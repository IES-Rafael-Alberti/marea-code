import { beforeEach, expect, it, vi } from "vitest";
import type { EditableSettings } from "../modules/server-settings/client.boundary.js";
import { change, control, text, tree } from "../modules/server-settings/forms.fixture.js";
import { present, setupInput, setupIdentity } from "./setup.fixture.js";
import { SetupWizard } from "./wizard.js";
import { serverSettingsMessages } from "../modules/server-settings/messages.js";
import { setupMessages } from "./messages.js";
type Value = object | string | number | boolean | null;
const hooks = vi.hoisted(() => ({
  values: [] as Value[],
  index: 0,
  effects: [] as (() => () => void)[],
  catalogs: {},
  models: vi.fn(),
  deps: [] as Value[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: Value) => {
    const i = hooks.index++;
    if (!(i in hooks.values)) hooks.values[i] = initial;
    return [
      hooks.values[i],
      (next: Value) => {
        hooks.values[i] = next;
      },
    ];
  },
  useEffect: (effect: () => () => void, deps: Value[]) => {
    hooks.deps = deps;
    hooks.effects.push(effect);
  },
}));
vi.mock("../modules/server-settings/provider-models.boundary.js", () => ({
  useProviderModels: (...args: object[]) => {
    hooks.models(...args);
    return { catalogs: hooks.catalogs, refresh: () => undefined };
  },
}));
const client = { fetch: vi.fn(), read: vi.fn(), finish: vi.fn() };
const openDashboard = vi.fn();
const m = setupMessages("en");
const settings: EditableSettings = {
  administrator: true,
  initialized: true,
  revision: 0,
  route: setupInput().route,
  education: {},
  legacyRoutes: [],
  useCommonRoute: true,
  providers: [
    {
      id: "org.marea.openrouter",
      supportsModels: true,
      configured: false,
      secrets: [],
      values: {},
      descriptor: {
        version: 1,
        name: { es: "Provider", en: "Provider", eu: "Provider" },
        fields: [],
      },
    },
  ],
};
function render() {
  hooks.index = 0;
  hooks.effects = [];
  return tree(<SetupWizard client={client} initialLocale="en" openDashboard={openDashboard} />);
}
const page = () => render().map(text).join("|");
function submit() {
  const event = { preventDefault: vi.fn() };
  (present(render().find((n) => n.type === "form")).props.onSubmit as (e: object) => void)(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
}
function click(label: string) {
  const button = render().find((n) => n.type === "button" && text(n) === label);
  expect(button).toBeDefined();
  (present(button).props.onClick as () => void)();
}
async function load(result: Promise<object> = Promise.resolve(settings)) {
  client.read.mockReturnValue(
    result.then((settings) => ({ settings, identityProviders: [setupIdentity] })),
  );
  render();
  const cleanup = present(hooks.effects[0])();
  await result.catch(() => undefined);
  await Promise.resolve();
  return cleanup;
}
beforeEach(() => {
  vi.clearAllMocks();
  hooks.values = [];
  hooks.index = 0;
  hooks.catalogs = { "org.marea.openrouter": { status: "ready", models: [] } };
  client.finish.mockResolvedValue("http://127.0.0.1:18793/dashboard/");
});
it("guides a school through all four steps and preserves edits when navigating back", async () => {
  expect(page()).toContain(m.loading);
  await load();
  for (const key of ["center", "classroom", "teacher", "login", "password"] as const)
    change(control(render(), m[key]), { value: setupInput()[key] });
  change(control(render(), m.confirmation), { value: "different-password" });
  submit();
  expect(page()).toContain(m.mismatch);
  change(control(render(), m.confirmation), { value: setupInput().password });
  submit();
  expect(page()).toContain(m.modelHelp);
  const modelLabel = serverSettingsMessages("en").model;
  change(control(render(), modelLabel), { value: "synthetic/other" });
  expect(control(render(), modelLabel).value).toBe("synthetic/other");
  change(control(render(), modelLabel), { value: setupInput().route.model });
  submit();
  change(control(render(), m.port), { value: "19876" });
  const radios = render().filter((n) => n.type === "input" && n.props.type === "radio");
  (radios[2]?.props.onChange as () => void)();
  change(control(render(), m.origin), { value: "https://school.test" });
  change(control(render(), setupIdentity.descriptor.name.en), { checked: true });
  for (const [key, value] of [
    ["domain", "school.test"],
    ["clientId", "synthetic-client"],
    ["clientSecret", "synthetic-secret"],
  ] as const)
    change(control(render(), key), { value });
  change(control(render(), m.testing), { checked: true });
  submit();
  expect(page()).toContain("Synthetic school");
  click(m.back);
  expect(control(render(), m.port).value).toBe(19876);
  submit();
  const pending = Promise.withResolvers<string>();
  client.finish.mockReturnValueOnce(pending.promise);
  submit();
  expect(page()).toContain(m.saving);
  submit();
  expect(client.finish).toHaveBeenCalledOnce();
  expect(client.finish).toHaveBeenCalledWith({
    ...setupInput(),
    port: 19876,
    access: "https",
    publicOrigin: "https://school.test",
    testingSkill: true,
    connections: { "org.marea.openrouter": {} },
    identityProviders: {
      [setupIdentity.id]: {
        domain: "school.test",
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      },
    },
  });
  pending.resolve("https://school.test/dashboard/");
  await pending.promise;
  expect(page()).toContain(m.ready);
  expect(openDashboard).toHaveBeenCalledWith("https://school.test/dashboard/");
});
it("requires a configured model and completed key check before advancing or finishing", async () => {
  await load();
  hooks.values[1] = 1;
  hooks.catalogs = {};
  submit();
  expect(page()).toContain(m.modelRequired);
  hooks.values[2] = { settings: { ...settings, route: null }, identityProviders: [setupIdentity] };
  submit();
  expect(page()).toContain(m.modelRequired);
  hooks.values[2] = {
    settings: { ...settings, providers: [] },
    identityProviders: [setupIdentity],
  };
  submit();
  expect(hooks.values[1]).toBe(1);
  hooks.values[1] = 3;
  hooks.values[2] = { settings: { ...settings, route: null }, identityProviders: [setupIdentity] };
  submit();
  expect(hooks.values[1]).toBe(1);
  hooks.values[1] = 3;
  hooks.values[2] = { settings: settings, identityProviders: [setupIdentity] };
  submit();
  expect(hooks.values[1]).toBe(1);
  expect(client.finish).not.toHaveBeenCalled();
});
it("supports providers without model catalogs and retries completion without discarding entered values", async () => {
  await load(
    Promise.resolve({
      ...settings,
      providers: settings.providers.map((provider) => ({ ...provider, supportsModels: false })),
    }),
  );
  hooks.values[1] = 3;
  hooks.values[4] = setupInput();
  client.finish.mockRejectedValueOnce(new Error("private"));
  submit();
  await Promise.resolve();
  expect(page()).toContain(m.error);
  expect(present(render().find((n) => n.type === "fieldset")).props.disabled).toBe(false);
  submit();
  await Promise.resolve();
  expect(client.finish.mock.lastCall?.[0]).toHaveProperty("identityProviders", {});
  expect(openDashboard).toHaveBeenCalledOnce();
});
it("handles loading failures, retry, nonadministrators and late reads after unmount", async () => {
  await load(Promise.reject(new Error("private")));
  expect(page()).toContain(m.retry);
  click(m.retry);
  expect(hooks.values[10]).toBe(1);
  await load(Promise.resolve({ ...settings, administrator: false }));
  expect(page()).toContain(m.error);
  for (const succeeds of [true, false]) {
    hooks.values[7] = null;
    const deferred = Promise.withResolvers<object>();
    client.read.mockReturnValue(deferred.promise);
    render();
    const cleanup = present(hooks.effects[0])();
    cleanup();
    if (succeeds) deferred.resolve({ settings, identityProviders: [] });
    else deferred.reject(new Error());
    await deferred.promise.catch(() => undefined);
    expect(hooks.values[2]).toBeNull();
    expect(hooks.values[7]).toBeNull();
  }
});
it("offers localized setup text and ignores an unknown locale", async () => {
  await load(Promise.resolve({ ...settings, providers: [] }));
  for (const locale of ["es", "eu", "en"] as const) {
    const before = setupMessages(hooks.values[0] as "es" | "en" | "eu");
    change(control(render(), before.language), { value: locale });
    expect(page()).toContain(setupMessages(locale).title);
  }
  change(control(render(), m.language), { value: "unknown" });
  expect(page()).toContain(m.title);
});
it("renders complete localized forms and keeps browser validation attributes", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  await load();
  for (const locale of ["es", "en", "eu"]) {
    hooks.values[0] = locale;
    for (const step of [0, 1, 2, 3]) {
      hooks.values[1] = step;
      hooks.index = 0;
      expect(
        renderToStaticMarkup(SetupWizard({ client, initialLocale: "en", openDashboard })),
      ).toMatchSnapshot(`${locale} step ${String(step)}`);
    }
  }
  hooks.values[1] = 2;
  hooks.values[6] = { [setupIdentity.id]: {} };
  hooks.values[4] = { ...setupInput(), access: "https" };
  hooks.index = 0;
  expect(
    renderToStaticMarkup(SetupWizard({ client, initialLocale: "en", openDashboard })),
  ).toMatchSnapshot("optional identity and HTTPS");
  expect(
    ["es", "en", "eu"].map((locale) => setupMessages(locale as "es" | "en" | "eu")),
  ).toMatchSnapshot("setup translations");
});
it("clears stale errors when reloading, advancing or going back", async () => {
  await load(Promise.reject(new Error()));
  await load();
  expect(hooks.values[7]).toBeNull();
  expect(hooks.deps).toEqual([client, 0]);
  hooks.values[7] = "mismatch";
  submit();
  expect(hooks.values[7]).toBeNull();
  hooks.values[7] = "modelRequired";
  click(m.back);
  expect(hooks.values[7]).toBeNull();
  hooks.values[1] = 3;
  hooks.values[2] = { settings: { ...settings, route: null }, identityProviders: [setupIdentity] };
  submit();
  expect(hooks.values[7]).toBe("modelRequired");
});
it("starts HTTPS with an empty origin and does not preselect among multiple providers", async () => {
  await load(
    Promise.resolve({
      ...settings,
      providers: [
        { ...present(settings.providers[0]), id: "another", supportsModels: false },
        ...settings.providers,
      ],
    }),
  );
  expect(hooks.values[3]).toEqual({});
  hooks.values[1] = 2;
  change(control(render(), m.https), {});
  expect(control(render(), m.origin).value).toBe("");
  hooks.values[1] = 1;
  hooks.catalogs = {};
  submit();
  expect(hooks.values[7]).toBe("modelRequired");
  expect(hooks.values[1]).toBe(1);
});

it("feeds the loaded provider settings into model discovery", async () => {
  render();
  expect(hooks.models).toHaveBeenLastCalledWith(client.fetch, null, {});
  await load();
  render();
  expect(hooks.models).toHaveBeenLastCalledWith(client.fetch, settings, {
    "org.marea.openrouter": {},
  });
});
