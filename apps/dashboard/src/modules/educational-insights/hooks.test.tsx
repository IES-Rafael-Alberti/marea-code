import { hooks, mocked, render, content } from "./hooks.fixture.js";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement } from "react";
import { EducationalSettings } from "./settings.js";
import { button, elements, model, props } from "./interactions.fixture.js";
const settings = {
  settings: { map: false, adaptive: false },
  revision: "v1",
  mapConfigured: false,
};
const settingsView = () => {
  const element = EducationalSettings({ ...props });
  if (!isValidElement(element)) throw new Error("Expected settings");
  return content(element);
};
it("loads, edits and saves educational settings", async () => {
  expect(EducationalSettings({ ...props, classId: null })).toBeNull();
  mocked.client.mockResolvedValue(settings);
  expect(renderToStaticMarkup(render(settingsView))).not.toContain('role="alert"');
  expect(hooks.values).toEqual([null, false, false, null, false, false]);
  expect(hooks.dependencies).toEqual([[props.classId, props.fetchRequest], [false]]);
  const dispose = hooks.effects[0]?.();
  expect(mocked.client.mock.lastCall?.[1]).toEqual({ kind: "settings" });
  await vi.advanceTimersByTimeAsync(1);
  let view = render(settingsView);
  for (const checkbox of elements(view).filter((e) => e.type === "input")) {
    checkbox.props.onChange?.({ currentTarget: { checked: true, value: "" } });
    view = render(settingsView);
  }
  // Each event is issued from the latest rendered form.
  elements(view)
    .find((e) => e.type === "input")
    ?.props.onChange?.({ currentTarget: { checked: true, value: "" } });
  view = render(settingsView);
  mocked.client.mockResolvedValueOnce({ ...settings, revision: "v2" });
  const preventDefault = vi.fn();
  elements(view)
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(mocked.client.mock.lastCall?.[1]).toMatchObject({
    kind: "configure",
    settings: { map: true, adaptive: true },
    expectedRevision: "v1",
  });
  expect(button(render(settingsView), model().m.save).disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(button(render(settingsView), model().m.save).disabled).toBe(true);
  expect(hooks.values[0]).toEqual({ ...settings, revision: "v2" });
  if (typeof dispose === "function") dispose();
});
it.each([false, true])("ignores settings load after disposal (failure: %s)", async (failure) => {
  const pending = Promise.withResolvers<object>();
  mocked.client.mockReturnValue(pending.promise);
  void render(settingsView);
  const dispose = hooks.effects[0]?.();
  if (typeof dispose === "function") dispose();
  if (failure) pending.reject(new Error("offline"));
  else pending.resolve(settings);
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[0]).toBeNull();
  expect(hooks.values[1]).toBe(false);
});
it("shows settings read and write errors and ignores a disposed save", async () => {
  mocked.client.mockRejectedValueOnce(new Error("offline"));
  void render(settingsView);
  hooks.effects[0]?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[1]).toBe(true);
  expect(renderToStaticMarkup(render(settingsView))).toContain('role="alert"');
  mocked.client.mockResolvedValue(settings);
  void render(settingsView);
  const dispose = hooks.effects[0]?.();
  await vi.advanceTimersByTimeAsync(1);
  mocked.client.mockRejectedValueOnce(new Error("conflict"));
  elements(render(settingsView))
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[1]).toBe(true);
  expect(renderToStaticMarkup(render(settingsView))).toContain('role="alert"');
  const pending = Promise.withResolvers<object>();
  mocked.client.mockReturnValueOnce(pending.promise);
  elements(render(settingsView))
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault: vi.fn() });
  expect(hooks.values[1]).toBe(false);
  if (typeof dispose === "function") dispose();
  pending.resolve({ ...settings, revision: "v2" });
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[0]).toEqual(settings);
});
it("uses an aborted signal if a settings form outlives its pending controller", async () => {
  mocked.client.mockResolvedValue(settings);
  void render(settingsView);
  hooks.effects[0]?.();
  await vi.advanceTimersByTimeAsync(1);
  const ref = hooks.refs[0];
  if (!ref) throw new Error("missing pending controller");
  ref.current = null;
  mocked.client.mockResolvedValueOnce({ ...settings, revision: "v3" });
  elements(render(settingsView))
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault: vi.fn() });
  expect((mocked.client.mock.lastCall?.[3] as AbortSignal).aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[1]).toBe(false);
  expect(hooks.values[0]).toEqual({ ...settings, revision: "v3" });
});

it.each([false, true, undefined])(
  "warns only when the map is explicitly unconfigured (%s)",
  (configured) => {
    hooks.values = [{ ...settings, mapConfigured: configured }, false, false];
    expect(renderToStaticMarkup(render(settingsView)).includes(model().m.unconfigured)).toBe(
      configured === false,
    );
  },
);
it("clears the previous class settings while loading a new class", () => {
  mocked.client.mockReturnValue(new Promise(() => undefined));
  hooks.values = [settings, true, false];
  void render(settingsView);
  hooks.effects[0]?.();
  expect(hooks.values[0]).toBeNull();
  expect(hooks.values[1]).toBe(false);
});

it("discards feature changes, reports configured reports and blocks a duplicate save", async () => {
  const loaded = { ...settings, reportsConfigured: true };
  mocked.client.mockResolvedValue(loaded);
  void render(settingsView);
  hooks.effects[0]?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(renderToStaticMarkup(render(settingsView))).toContain(model().m.reportsReady);
  elements(render(settingsView))
    .find((e) => e.type === "input")
    ?.props.onChange?.({ currentTarget: { checked: true, value: "" } });
  expect(hooks.values[4]).toBe(true);
  button(render(settingsView), model().m.discard).onClick?.();
  expect(hooks.values).toMatchObject({ 0: loaded, 4: false, 5: false });
  hooks.values[2] = true;
  mocked.client.mockClear();
  elements(render(settingsView))
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault: vi.fn() });
  expect(mocked.client).not.toHaveBeenCalled();
});

it("keeps feature save, discard and feedback in sync throughout editing and saving", async () => {
  mocked.client.mockResolvedValue(settings);
  void render(settingsView);
  hooks.values[4] = true;
  hooks.effects[0]?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[4]).toBe(false);
  const snapshot = (name: string) => {
    expect(renderToStaticMarkup(render(settingsView))).toMatchSnapshot(name);
  };
  snapshot("clean features");
  for (const index of [0, 1]) {
    hooks.values[5] = true;
    const input = elements(render(settingsView)).filter((e) => e.type === "input")[index];
    input?.props.onChange?.({ currentTarget: { checked: true, value: "" } });
    expect(hooks.values).toMatchObject({ 4: true, 5: false });
  }
  snapshot("dirty features");
  for (const busy of [true, false]) {
    hooks.values[2] = busy;
    expect(button(render(settingsView), model().m.discard).disabled).toBe(busy);
  }
  const pending = Promise.withResolvers<object>();
  mocked.client.mockReturnValue(pending.promise);
  hooks.values[5] = true;
  elements(render(settingsView))
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault: vi.fn() });
  expect(hooks.values[5]).toBe(false);
  const updated = { ...settings, revision: "saved", settings: { map: true, adaptive: true } };
  pending.resolve(updated);
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values).toMatchObject({ 3: updated, 4: false, 5: true });
  snapshot("saved features");
  expect(button(render(settingsView), model().m.discard).disabled).toBe(true);
});
