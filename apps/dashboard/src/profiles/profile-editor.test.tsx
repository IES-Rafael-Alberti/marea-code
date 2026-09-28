import type { ProfileSelection } from "./profile-catalog.js";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ProfileEditor } from "./profile-editor.js";
import { CompositionEditor } from "./composition-editor.js";
import { ProfileController } from "./profile-controller.js";
import { catalog, clientFixture, release, selection, state, value } from "./profile.fixture.js";
import { moduleLabel, profileMessages } from "./profile-messages.js";
import { reviewElements, reviewButton } from "../modules/evaluation/react-tree.fixture.js";
interface Input {
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly value: string;
  readonly onChange?: (event: { currentTarget: { checked: boolean; value: string } }) => void;
}
function controls(node: ReturnType<typeof ProfileEditor>) {
  return reviewElements(node) as readonly ReactElement<Input>[];
}
it.each(["es", "en", "eu"] as const)(
  "localizes every profile state and inheritance control in %s",
  async (locale) => {
    const c = new ProfileController(clientFixture(), release, vi.fn());
    expect(
      renderToStaticMarkup(<ProfileEditor controller={c} locale={locale} canChange={() => true} />),
    ).toContain(profileMessages(locale).title);
    await c.select({ kind: "class", classId: "class:a" });
    for (const problem of [
      null,
      "invalid",
      "conflict",
      "uncertain",
      "catalog",
      "unavailable",
      "recovery",
    ] as const) {
      c.problem = problem;
      c.dirty = true;
      c.recovery = state(c.scope);
      c.matched = true;
      c.current = { ...state(c.scope), warnings: [{ code: "theme-unavailable" }] };
      const html = renderToStaticMarkup(
        <ProfileEditor controller={c} locale={locale} canChange={() => true} />,
      );
      expect(html).toMatchSnapshot(`class-editor-${locale}-${String(problem)}`);
      expect(html).toContain(profileMessages(locale).inheritTheme);
      if (problem !== null) expect(html).toContain(profileMessages(locale)[problem]);
      expect(html).toContain(profileMessages(locale).warning);
    }
  },
);
it("edits inheritance, themes, discard consent and revision reconciliation without implicit writes", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  await c.select({ kind: "class", classId: "class:a" });
  const guard = vi.fn().mockReturnValue(true);
  const render = () => ProfileEditor({ controller: c, locale: "en", canChange: guard });
  const check = (at: number, checked: boolean) => {
    controls(render())
      .filter((item) => item.type === "input")
      .at(at)
      ?.props.onChange?.({ currentTarget: { checked, value: "" } });
  };
  check(0, false);
  expect(c.draft?.themeId).toBe(value.themeId);
  check(0, true);
  expect(c.draft?.themeId).toBeUndefined();
  check(1, false);
  expect(c.draft?.modules).toEqual(value.modules);
  check(1, true);
  expect(c.draft?.modules).toBeUndefined();
  guard.mockReturnValueOnce(false);
  check(1, false);
  expect(c.draft?.modules).toBeUndefined();
  controls(render())
    .find((item) => item.type === "select")
    ?.props.onChange?.({
      currentTarget: { checked: false, value: "org.marea.theme.high-contrast" },
    });
  expect(c.draft?.themeId).toBe("org.marea.theme.high-contrast");
  controls(render())
    .filter((item) => item.type === "input")
    .at(-1)
    ?.props.onChange?.({ currentTarget: { checked: true, value: "" } });
  expect(c.discardUnavailable).toBe(true);
  expect(c.draft).toEqual({ themeId: "org.marea.theme.high-contrast" });
  const save = vi.spyOn(c, "write").mockResolvedValue();
  const read = vi.spyOn(c, "read").mockResolvedValue();
  reviewButton(reviewElements(render()), "Save").props.onClick?.();
  expect(save).toHaveBeenCalledWith();
  reviewButton(reviewElements(render()), "Read current state").props.onClick?.();
  expect(read).toHaveBeenCalled();
  vi.stubGlobal("window", { confirm: vi.fn().mockReturnValue(false) });
  reviewButton(reviewElements(render()), "Reset this scope").props.onClick?.();
  expect(save).toHaveBeenCalledTimes(1);
  (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(true);
  guard.mockReturnValueOnce(false);
  reviewButton(reviewElements(render()), "Reset this scope").props.onClick?.();
  expect(save).toHaveBeenCalledTimes(1);
  reviewButton(reviewElements(render()), "Reset this scope").props.onClick?.();
  expect(save).toHaveBeenLastCalledWith(true);
  c.recovery = state(c.scope);
  guard.mockReturnValueOnce(false);
  reviewButton(reviewElements(render()), "Accept current state").props.onClick?.();
  expect(c.recovery).not.toBeNull();
  c.dirty = false;
  reviewButton(reviewElements(render()), "Keep draft against current revision").props.onClick?.();
  expect(c.recovery).toBeNull();
  expect(c.dirty).toBe(true);
  c.recovery = state(c.scope);
  reviewButton(reviewElements(render()), "Accept current state").props.onClick?.();
  expect(c.dirty).toBe(false);
  c.current = {
    ...state(),
    personal: { revision: "r:1", updatedAt: "2026-09-22T00:00:00.000Z", status: "valid", value },
  };
  expect(renderToStaticMarkup(render())).toContain("Marea");
  vi.unstubAllGlobals();
});
it("guides visibility, order, supported placement and re-enabling an empty composition", () => {
  const change = vi.fn<(modules: ProfileSelection[]) => void>();
  const guard = vi.fn().mockReturnValue(true);
  const modules = [selection, { ...selection, moduleId: "org.marea.module.second" }];
  const render = (items = modules, available = catalog()) =>
    CompositionEditor({
      modules: items,
      catalog: available,
      disabled: false,
      messages: profileMessages("en"),
      change,
      canChange: guard,
    });
  expect(renderToStaticMarkup(render())).toMatchSnapshot("composition-controls");
  const nodes = () => controls(render());
  nodes()
    .find((item) => item.type === "input")
    ?.props.onChange?.({ currentTarget: { checked: false, value: "" } });
  expect(change.mock.lastCall?.[0]).toEqual([{ ...selection, enabled: false }, modules[1]]);
  guard.mockReturnValueOnce(false);
  nodes()
    .find((item) => item.type === "input")
    ?.props.onChange?.({ currentTarget: { checked: false, value: "" } });
  expect(change).toHaveBeenCalledOnce();
  reviewButton(reviewElements(render()), "Move down").props.onClick?.();
  expect(change.mock.lastCall?.[0][1]).toEqual(selection);
  const up = reviewElements(render()).filter(
    (item) => item.type === "button" && item.props.children === "Move up",
  );
  change.mockClear();
  up[1]?.props.onClick?.();
  expect(change.mock.lastCall?.[0][0]).toEqual(modules[1]);
  const selects = nodes().filter((item) => item.type === "select");
  const choose = (at: number, selected: string) => {
    selects.at(at)?.props.onChange?.({ currentTarget: { checked: false, value: selected } });
  };
  choose(0, "aside");
  expect(change.mock.lastCall?.[0][0]?.placement.slot).toBe("aside");
  choose(1, "standard");
  expect(change.mock.lastCall?.[0][0]?.placement).toEqual({ slot: "main", size: "standard" });
  const count = change.mock.calls.length;
  for (const item of selects)
    item.props.onChange?.({ currentTarget: { checked: false, value: "invalid" } });
  expect(change).toHaveBeenCalledTimes(count);
  reviewElements(render([]))
    .find((item) => item.type === "button")
    ?.props.onClick?.();
  expect(change.mock.lastCall?.[0]).toEqual([selection]);
});
it("updates the whole module field from composition controls", async () => {
  const c = new ProfileController(clientFixture(), release, vi.fn());
  await c.read();
  const inputs = controls(
    ProfileEditor({ controller: c, locale: "en", canChange: () => true }),
  ).filter((item) => item.type === "input");
  inputs[0]?.props.onChange?.({ currentTarget: { checked: false, value: "" } });
  expect(c.draft?.modules?.[0]?.enabled).toBe(false);
});
it("preserves the other whole field when inheritance changes and renders partial recovery safely", async () => {
  const c = new ProfileController(clientFixture(), release, vi.fn());
  await c.select({ kind: "class", classId: "class:a" });
  const render = () => ProfileEditor({ controller: c, locale: "en", canChange: () => true });
  const change = (at: number) => {
    controls(render())
      .filter((item) => item.type === "input")
      .at(at)
      ?.props.onChange?.({ currentTarget: { checked: true, value: "" } });
  };
  c.edit({ themeId: "org.marea.theme.high-contrast", modules: [] });
  change(0);
  expect(c.draft).toEqual({ modules: [] });
  c.edit({ themeId: "org.marea.theme.high-contrast", modules: [] });
  change(1);
  expect(c.draft).toEqual({ themeId: "org.marea.theme.high-contrast" });
  for (const partial of ["draft", "catalog", "current"] as const) {
    await c.select({ kind: "teacher" });
    c[partial] = null;
    expect(renderToStaticMarkup(render())).toMatchSnapshot(`partial-${partial}`);
  }
  await c.select({ kind: "teacher" });
  c.busy = true;
  expect(renderToStaticMarkup(render())).toMatchSnapshot("busy-personal-editor");
});
it("shows class field controls enabled only for explicitly overridden fields", async () => {
  const c = new ProfileController(clientFixture(), release, vi.fn());
  await c.select({ kind: "class", classId: "class:a" });
  for (const draft of [
    { themeId: "org.marea.theme.high-contrast" },
    { modules: [selection] },
    { ...value },
  ]) {
    c.edit(draft);
    expect(
      renderToStaticMarkup(<ProfileEditor controller={c} locale="en" canChange={() => true} />),
    ).toMatchSnapshot(JSON.stringify(Object.keys(draft)));
  }
});
it("honors asymmetric placement support and offers only missing catalog modules", () => {
  const c = catalog();
  const descriptor = c.modules[0];
  if (descriptor === undefined) throw new Error("missing descriptor");
  const second = { ...selection, moduleId: "org.marea.module.second" };
  const available = {
    ...c,
    modules: [
      {
        ...descriptor,
        supportedPlacements: [
          { slot: "main", size: "standard" },
          { slot: "main", size: "wide" },
          { slot: "aside", size: "compact" },
        ] satisfies ProfileSelection["placement"][],
      },
    ],
    releaseDefaults: { ...value, modules: [selection, second] },
  };
  const change = vi.fn<(items: ProfileSelection[]) => void>();
  const node = CompositionEditor({
    modules: [{ ...selection, placement: { slot: "aside", size: "compact" } }],
    catalog: available,
    disabled: false,
    messages: profileMessages("en"),
    change,
    canChange: () => true,
  });
  expect(renderToStaticMarkup(node)).toMatchSnapshot("asymmetric-placements-and-missing-module");
  const selects = controls(node).filter((item) => item.type === "select");
  selects[1]?.props.onChange?.({ currentTarget: { checked: false, value: "wide" } });
  expect(change).not.toHaveBeenCalled();
  selects[1]?.props.onChange?.({ currentTarget: { checked: false, value: "compact" } });
  expect(change.mock.lastCall?.[0][0]?.placement).toEqual({ slot: "aside", size: "compact" });
  reviewElements(node)
    .filter((item) => item.type === "button")
    .at(-1)
    ?.props.onClick?.();
  expect(change.mock.lastCall?.[0].map((item) => item.moduleId)).toEqual([
    selection.moduleId,
    second.moduleId,
  ]);
});
it("keeps personal fields editable when a retained draft needs validation repair", async () => {
  const c = new ProfileController(clientFixture(), release, vi.fn());
  await c.select({ kind: "teacher" });
  c.edit({});
  await c.write();
  expect(c.problem).toBe("invalid");
  expect(
    renderToStaticMarkup(<ProfileEditor controller={c} locale="en" canChange={() => true} />),
  ).toMatchSnapshot("repairable-personal-draft");
});
it.each(["es", "en", "eu"] as const)("names bundled modules in %s and others by ID", (locale) => {
  const m = profileMessages(locale);
  expect(
    ["sessions", "usage", "health"].map((id) => moduleLabel(m, `org.marea.module.${id}`)),
  ).toEqual([m.sessions, m.usage, m.health]);
  expect(new Set([m.sessions, m.usage, m.health]).size).toBe(3);
  expect(moduleLabel(m, "org.example.module")).toBe("org.example.module");
});
