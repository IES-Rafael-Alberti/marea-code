import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tree, text, control, change } from "./forms.fixture.js";
import { serverSettingsMessages } from "./messages.js";
import { IdentitySettingsView } from "./identity-view.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { setupIdentity, present } from "../../setup/setup.fixture.js";
const { hooks, mockReact } = await vi.hoisted(async () =>
  (await import("./state-hooks.fixture.js")).stateHarness(),
);
vi.mock("react", async (original) => mockReact(original));
const fetchRequest = vi.fn<DashboardFetch>();
const state = {
  revision: 3,
  restart: false,
  providers: [
    {
      ...setupIdentity,
      configured: true,
      values: { clientId: "public", domain: "school.test" },
      secrets: ["clientSecret"],
    },
  ],
};
function render() {
  hooks.index = 0;
  hooks.effects = [];
  hooks.dependencies = [];
  return tree(<IdentitySettingsView locale="en" fetchRequest={fetchRequest} />);
}
const click = (caption: string) => {
  const button = render().find((node) => node.type === "button" && text(node) === caption);
  if (!button) throw new Error(`Missing ${caption}`);
  (button.props.onClick as () => void)();
};
async function load(value = state) {
  fetchRequest.mockResolvedValue(Response.json(value));
  render();
  hooks.effects[1]?.();
  await vi.waitFor(() => {
    expect(hooks.values[0]).toEqual(value);
  });
}
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it("shows saved credentials as presence, preserves the draft on failed save, discards and confirms restart", async () => {
  await load();
  hooks.index = 0;
  expect(
    renderToStaticMarkup(<IdentitySettingsView locale="en" fetchRequest={fetchRequest} />),
  ).toMatchSnapshot("stored credential form");
  expect(control(render(), "clientSecret").value).toBe("");
  expect(control(render(), "clientSecret").required).toBe(false);
  change(control(render(), "domain"), { value: "changed.test" });
  expect(hooks.values[4]).toBe(true);
  const submit = () => {
    (render().find((node) => node.type === "form")?.props.onSubmit as (event: object) => void)({
      preventDefault: vi.fn(),
    });
  };
  fetchRequest.mockResolvedValueOnce(new Response("private", { status: 400 }));
  submit();
  submit();
  await vi.waitFor(() => {
    expect(hooks.values[2]).toBe(false);
  });
  expect(hooks.values[3]).toBe(true);
  const m = serverSettingsMessages("en");
  expect(text(render().find((node) => node.props.role === "alert"))).toBe(`${m.error} ${m.reload}`);
  expect(control(render(), "domain").value).toBe("changed.test");
  click("Discard changes");
  expect(control(render(), "domain").value).toBe("school.test");
  change(control(render(), "clientId"), { value: "new-client" });
  fetchRequest.mockResolvedValueOnce(Response.json({ ...state, revision: 4, restart: true }));
  submit();
  await vi.waitFor(() => {
    expect(hooks.values[0]).toMatchObject({ revision: 4 });
  });
  hooks.index = 0;
  expect(
    renderToStaticMarkup(<IdentitySettingsView locale="en" fetchRequest={fetchRequest} />),
  ).toMatchSnapshot("saved pending restart");
  expect(text(render())).toContain("Restart marea-teacher");
  expect(hooks.values[4]).toBe(false);
  expect(JSON.parse(fetchRequest.mock.lastCall?.[1].body as string)).toEqual({
    operation: "identity-save",
    expectedRevision: 3,
    connections: { [setupIdentity.id]: { clientId: "new-client", domain: "school.test" } },
  });
});
it("supports unconfigured or removed providers and retries failed reads", async () => {
  await load({ ...state, providers: [] });
  expect(render().filter((node) => node.type === "input")).toHaveLength(0);
  expect(text(render())).toContain("No providers installed.");
  hooks.values = [];
  fetchRequest.mockRejectedValue(new Error("private"));
  render();
  hooks.effects[1]?.();
  await vi.waitFor(() => {
    expect(hooks.values[3]).toBe(true);
  });
  click("Reload");
  expect(hooks.values[5]).toBe(1);
  await load({ ...state, providers: [{ ...present(state.providers[0]), configured: false }] });
  expect(hooks.values[1]).toEqual({});
});
it.each([false, true])("ignores reads after disposal, failure=%s", async (failure) => {
  const promise = Promise.withResolvers<Response>();
  fetchRequest.mockReturnValue(promise.promise);
  render();
  hooks.effects[1]?.()?.();
  if (failure) promise.reject(new Error("private"));
  else promise.resolve(Response.json(state));
  await promise.promise.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hooks.values[0]).toBeNull();
  expect(hooks.values[3]).toBe(false);
  expect(hooks.values[2]).toBe(true);
});

it("confirms losing a failed draft on reload and acknowledges changes needing no restart", async () => {
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.stubGlobal("window", { confirm });
  await load();
  change(control(render(), "domain"), { value: "draft.test" });
  hooks.values[3] = true;
  click("Reload");
  expect(hooks.values[5]).toBe(0);
  expect(control(render(), "domain").value).toBe("draft.test");
  click("Reload");
  expect(hooks.values[5]).toBe(1);
  fetchRequest.mockResolvedValue(Response.json(state));
  (render().find((node) => node.type === "form")?.props.onSubmit as (event: object) => void)({
    preventDefault: vi.fn(),
  });
  await vi.waitFor(() => {
    expect(hooks.values[6]).toBe(true);
  });
  expect(text(render())).toContain("Changes saved.");
  expect(text(render())).not.toContain("Restart marea-teacher");
});

it("exposes accurate pending, idle and busy controls and passes the read capability", async () => {
  render();
  expect(hooks.values).toEqual([null, {}, false, false, false, 0, false]);
  await load();
  expect(hooks.dependencies[1]).toEqual([fetchRequest, 0]);
  expect(fetchRequest).toHaveBeenCalledWith(
    "/api/v1/dashboard/server-settings",
    expect.objectContaining({
      body: '{"operation":"identity-read"}',
      signal: expect.any(AbortSignal) as AbortSignal,
    }),
  );
  const button = (label: string) =>
    render().find((node) => node.type === "button" && text(node) === label)?.props;
  expect(button("Save configuration")?.disabled).toBe(true);
  change(control(render(), "clientId"), { value: "draft" });
  expect(hooks.values[6]).toBe(false);
  for (const busy of [true, false]) {
    hooks.values[2] = busy;
    expect(button("Save configuration")?.disabled).toBe(busy);
    expect(button("Discard changes")?.disabled).toBe(busy);
  }
  hooks.index = 0;
  expect(
    renderToStaticMarkup(<IdentitySettingsView locale="en" fetchRequest={fetchRequest} />),
  ).toMatchSnapshot("dirty identity form");
  hooks.values[3] = true;
  hooks.values[6] = true;
  const pending = Promise.withResolvers<Response>();
  fetchRequest.mockReturnValue(pending.promise);
  const submit = () => {
    const preventDefault = vi.fn();
    (render().find((node) => node.type === "form")?.props.onSubmit as (event: object) => void)({
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  };
  submit();
  const calls = fetchRequest.mock.calls.length;
  submit();
  expect(fetchRequest).toHaveBeenCalledTimes(calls);
  expect(hooks.values).toMatchObject({ 2: true, 3: false, 6: false });
  pending.resolve(Response.json(state));
  await vi.waitFor(() => {
    expect(hooks.values[2]).toBe(false);
  });
  expect(hooks.values).toMatchObject({ 3: false, 4: false, 6: true });
  change(control(render(), "clientId"), { value: "other" });
  click("Discard changes");
  expect(hooks.values[6]).toBe(false);
});

it("accepts another form's saved revision without resetting drafts and reports its own save", async () => {
  await load();
  change(control(render(), "domain"), { value: "draft.test" });
  const onSaved = vi.fn();
  const redraw = (revisionChange: { before: number; after: number } | null) => {
    hooks.index = 0;
    hooks.effects = [];
    return tree(
      <IdentitySettingsView
        locale="en"
        fetchRequest={fetchRequest}
        revisionChange={revisionChange}
        onSaved={onSaved}
      />,
    );
  };
  redraw(null);
  hooks.effects[2]?.();
  expect(hooks.values[0]).toEqual(state);
  const revisionChange = { before: 3, after: 4 };
  redraw(revisionChange);
  expect(hooks.dependencies.at(-1)).toEqual([revisionChange]);
  hooks.effects[2]?.();
  expect(hooks.values[0]).toEqual({ ...state, revision: 4 });
  expect(control(render(), "domain").value).toBe("draft.test");
  fetchRequest.mockResolvedValueOnce(Response.json({ ...state, revision: 5 }));
  (
    redraw(revisionChange).find((node) => node.type === "form")?.props.onSubmit as (
      event: object,
    ) => void
  )({ preventDefault: vi.fn() });
  await vi.waitFor(() => {
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ before: 4, after: 5 });
  });
  expect(JSON.parse(fetchRequest.mock.lastCall?.[1].body as string)).toMatchObject({
    expectedRevision: 4,
  });
});
