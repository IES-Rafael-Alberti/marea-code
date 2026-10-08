import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { tree, text, control, change } from "../server-settings/forms.fixture.js";
import { ObservabilityView } from "./view.js";
import type { ObservabilityState } from "./client.boundary.js";
const { hooks, mockReact } = await vi.hoisted(async () =>
  (await import("../server-settings/state-hooks.fixture.js")).stateHarness(),
);
vi.mock("react", async (original) => mockReact(original));
const label = (en: string) => ({ en, es: en, eu: en });
const state: ObservabilityState = {
  revision: 3,
  enabled: false,
  pluginId: null,
  status: {
    pending: 0,
    failed: 0,
    sent: 0,
    dropped: 0,
    lastSentAt: null,
    healthy: true,
    available: false,
  },
  plugins: [
    {
      id: "test",
      descriptor: {
        version: 1,
        name: label("Collector"),
        fields: [
          {
            key: "endpoint",
            kind: "url",
            label: label("URL"),
            required: true,
            defaultValue: "https://collector.test",
          },
          { key: "secret", kind: "secret", label: label("Key"), required: true },
          { key: "optional", kind: "text", label: label("Optional"), required: false },
        ],
      },
      values: {},
      secrets: ["secret"],
    },
  ],
};
const fetchRequest = vi.fn();
const sentBody = (body: object) => {
  expect(fetchRequest).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ body: JSON.stringify(body) }),
  );
};

const render = () => {
  hooks.index = 0;
  hooks.effects = [];
  hooks.dependencies = [];
  return tree(<ObservabilityView locale="en" fetchRequest={fetchRequest} />);
};
const click = (caption: string) => {
  const button = render().find((n) => n.type === "button" && text(n) === caption);
  const handler = button?.props.onClick as () => void;
  handler();
};
const submit = () => {
  const form = render().find((n) => n.type === "form");
  (form?.props.onChange as () => void)();
  const handler = form?.props.onSubmit as (e: object) => void;
  const preventDefault = vi.fn();
  handler({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
};
const load = async (value = state) => {
  fetchRequest.mockImplementation(() => Promise.resolve(Response.json(value)));
  render();
  expect(hooks.dependencies).toEqual([[fetchRequest], [false]]);
  hooks.effects[0]?.();
  sentBody({ operation: "read" });
  await vi.waitFor(() => {
    expect(hooks.values[0]).toEqual(value);
  });
};
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
  hooks.effects = [];
  hooks.dependencies = [];
  vi.clearAllMocks();
});
it("uses plugin fields and keeps saved secrets out of ordinary reads and unchanged writes", async () => {
  await load();
  hooks.index = 0;
  expect(
    renderToStaticMarkup(<ObservabilityView locale="en" fetchRequest={fetchRequest} />),
  ).toMatchSnapshot("inactive destination form");
  change(control(render(), "Destination"), { value: "test" });
  expect(control(render(), "URL").value).toBe("https://collector.test");
  expect(control(render(), "Key")).toMatchObject({
    type: "password",
    required: false,
    placeholder: "Already configured; leave empty to keep",
  });
  expect(control(render(), "Optional").type).toBe("text");
  change(control(render(), "URL"), { value: "https://private.test" });
  change(control(render(), "Key"), { value: "new-key" });
  expect(control(render(), "Key").value).toBe("new-key");
  change(control(render(), "Key"), { value: "" });
  change(control(render(), "Enable delivery"), { checked: true });
  click("Test connection");
  expect(render().some((n) => text(n) === "Working…")).toBe(true);
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("tested");
  });
  sentBody({
    operation: "test",
    pluginId: "test",
    values: { endpoint: "https://private.test" },
  });
  submit();
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("saved");
  });
  sentBody({
    operation: "save",
    pluginId: "test",
    values: { endpoint: "https://private.test" },
    enabled: true,
    expectedRevision: 3,
  });
  expect(render().some((n) => text(n) === "Settings saved.")).toBe(true);
  click("Refresh status");
  await vi.waitFor(() => {
    expect(hooks.values[4]).toBe(false);
  });
  expect(fetchRequest).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ body: '{"operation":"read"}' }),
  );
  change(control(render(), "Destination"), { value: "" });
  expect(hooks.values[2]).toEqual({});
});
it("shows paused and unhealthy destinations, permits disabling removed plugins and retries failures", async () => {
  const removed = {
    ...state,
    pluginId: "removed",
    enabled: true,
    plugins: [],
    status: {
      pending: 3,
      failed: 2,
      sent: 4,
      dropped: 1,
      lastSentAt: "2026-10-08T00:00:00.000Z",
      healthy: false,
      available: false,
    },
  };
  await load(removed);
  hooks.index = 0;
  expect(
    renderToStaticMarkup(<ObservabilityView locale="en" fetchRequest={fetchRequest} />),
  ).toMatchSnapshot("removed destination with queue status");
  hooks.values[0] = { ...removed, plugins: state.plugins };
  expect(text(render())).toContain("Plugin not installed");
  expect(text(render())).toContain("delivery paused");
  expect(text(render())).toContain("queue needs attention");
  expect(text(render())).toContain("2026-10-08");
  expect(control(render(), "Enable delivery").disabled).toBe(false);
  change(control(render(), "Enable delivery"), { checked: false });
  submit();
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("saved");
  });
  sentBody({
    operation: "save",
    pluginId: "removed",
    values: {},
    enabled: false,
    expectedRevision: 3,
  });
  click("Retry failed deliveries");
  await vi.waitFor(() => {
    expect(hooks.values[4]).toBe(false);
  });
  expect(fetchRequest).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ body: '{"operation":"retry"}' }),
  );
  hooks.values[0] = {
    ...removed,
    plugins: state.plugins,
    pluginId: "test",
    status: { ...removed.status, available: true },
  };
  hooks.values[1] = "test";
  expect(text(render())).not.toContain("delivery paused");
});
it("reports conflicts, transport failures and malformed responses without revealing secrets", async () => {
  await load({
    ...state,
    pluginId: "test",
    plugins: state.plugins.map((p) => ({
      ...p,
      values: { endpoint: "https://saved.test" },
      secrets: [],
    })),
  });
  expect(control(render(), "URL").value).toBe("https://saved.test");
  expect(control(render(), "Key").required).toBe(true);
  for (const [status, message] of [
    [409, "conflict"],
    [502, "error"],
  ] as const) {
    fetchRequest.mockImplementation(() => Promise.resolve(new Response("private", { status })));
    submit();
    await vi.waitFor(() => {
      expect(hooks.values[5]).toBe(message);
    });
  }
  fetchRequest.mockRejectedValue(new Error("private"));
  click("Test connection");
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("error");
  });
  expect(text(render())).not.toContain("private");
  hooks.values = [];
  render();
  hooks.effects[0]?.();
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("unavailable");
  });
});
it("ignores initial replies and failures after disposal", async () => {
  const pending = Promise.withResolvers<Response>();
  fetchRequest.mockReturnValue(pending.promise);
  render();
  hooks.effects[0]?.()?.();
  pending.resolve(Response.json(state));
  await pending.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hooks.values[0]).toBeNull();
  const failed = Promise.withResolvers<Response>();
  fetchRequest.mockReturnValue(failed.promise);
  render();
  hooks.effects[0]?.()?.();
  failed.reject(new Error("late"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hooks.values[5]).toBeNull();
});

it("retains selected public fields and exposes accurate action availability and live regions", async () => {
  render();
  expect(hooks.values[1]).toBe("");
  expect(hooks.values[3]).toBe(false);
  const selected = {
    ...state,
    enabled: true,
    pluginId: "second",
    plugins: [
      ...state.plugins,
      {
        ...state.plugins[0],
        id: "second",
        values: { endpoint: "https://second.test" },
        secrets: [],
      },
    ],
  } as ObservabilityState;
  await load(selected);
  expect(hooks.values[2]).toStrictEqual({ endpoint: "https://second.test" });
  expect(
    render().some((n) => n.type === "option" && n.props.children === "Plugin not installed"),
  ).toBe(false);
  change(control(render(), "Destination"), { value: "test" });
  expect(hooks.values[3]).toBe(false);
  expect(hooks.values[2]).toStrictEqual({ endpoint: "https://collector.test" });
  expect(control(render(), "URL").type).toBe("url");
  expect(control(render(), "Key").value).toBe("");
  expect(control(render(), "Enable delivery").disabled).toBe(false);
  expect(
    render().find((n) => n.type === "button" && text(n) === "Test connection")?.props.disabled,
  ).toBe(false);
  change(control(render(), "Optional"), { value: "" });
  expect(hooks.values[2]).toStrictEqual({ endpoint: "https://collector.test", optional: "" });
  hooks.values[5] = "saved";
  click("Refresh status");
  expect(hooks.values[5]).toBeNull();
  await vi.waitFor(() => {
    expect(hooks.values[4]).toBe(false);
  });
  expect(hooks.values[5]).toBeNull();
  expect(hooks.values[1]).toBe("second");
  for (const message of ["saved", "tested", "error", "conflict", "unavailable"]) {
    hooks.values[5] = message;
    const roles = render()
      .filter((n) => n.type === "p" && n.props.role)
      .map((n) => n.props.role);
    expect(roles).toEqual([message === "saved" || message === "tested" ? "status" : "alert"]);
  }
});

it("refreshes delivery status without overwriting an edited destination and can discard it", async () => {
  await load({ ...state, pluginId: "test" });
  change(control(render(), "URL"), { value: "https://draft.test" });
  (render().find((node) => node.type === "form")?.props.onChange as () => void)();
  fetchRequest.mockResolvedValue(
    Response.json({ ...state, pluginId: "test", status: { ...state.status, pending: 7 } }),
  );
  click("Refresh status");
  await vi.waitFor(() => {
    expect(hooks.values[4]).toBe(false);
  });
  expect(control(render(), "URL").value).toBe("https://draft.test");
  expect(hooks.values[0]).toMatchObject({ status: { pending: 7 } });
  expect(hooks.values[6]).toBe(true);
  hooks.values[5] = "error";
  click("Discard changes");
  expect(hooks.values[5]).toBeNull();
  expect(control(render(), "URL").value).toBe("");
  expect(hooks.values[6]).toBe(false);
});

it("enables delivery saving only for a selected edited destination and clears feedback on edits", async () => {
  await load();
  const save = () =>
    render().find((node) => node.type === "button" && node.props.type === "submit")?.props.disabled;
  expect(save()).toBe(true);
  (render().find((node) => node.type === "form")?.props.onChange as () => void)();
  expect(save()).toBe(true);
  change(control(render(), "Destination"), { value: "test" });
  expect(save()).toBe(false);
  expect(
    render().find((node) => node.type === "input" && node.props.type === "url")?.props.autoComplete,
  ).toBe("off");
  hooks.values[5] = "saved";
  (render().find((node) => node.type === "form")?.props.onChange as () => void)();
  expect(hooks.values[5]).toBeNull();
  hooks.index = 0;
  expect(
    renderToStaticMarkup(<ObservabilityView locale="en" fetchRequest={fetchRequest} />),
  ).toMatchSnapshot("pending destination draft");
  submit();
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("saved");
  });
  expect(hooks.values[6]).toBe(false);
  expect(hooks.values[1]).toBe("");
});
