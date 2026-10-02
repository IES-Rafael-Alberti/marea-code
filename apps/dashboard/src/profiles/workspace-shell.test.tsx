import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import * as educational from "../modules/educational-insights/adapter.js";
import * as evidence from "../modules/reviewed-evidence/adapter.js";
import { openEvidenceSession } from "../modules/reviewed-evidence/navigation.js";
import { sessionPorts } from "../../browser/typed-host-data.fixture.js";
import { ProfileController } from "./profile-controller.js";
import { profileMessages } from "./profile-messages.js";
import { catalog, clientFixture, release, selection, value } from "./profile.fixture.js";
import { ProfileShell, type WorkspaceSettings } from "./profile-shell.js";
import { workspaceMessages } from "./workspace-navigation.js";

type Value = object | string | number | boolean | null | undefined;
type Effect = () => undefined | (() => void);
const hooks = vi.hoisted(() => ({
  state: [] as Value[],
  initials: [] as Value[],
  setters: [] as Mock[],
  refs: [] as { current: Value }[],
  effects: [] as Effect[],
  effectDependencies: [] as (readonly Value[])[],
  memoDependencies: [] as (readonly Value[])[],
  index: 0,
  refIndex: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (create: () => object, dependencies: readonly Value[]) => {
    hooks.memoDependencies.push(dependencies);
    return create();
  },
  useRef: (current: Value) => (hooks.refs[hooks.refIndex++] ??= { current }),
  useEffect: (effect: Effect, dependencies: readonly Value[]) => {
    hooks.effects.push(effect);
    hooks.effectDependencies.push(dependencies);
  },
  useState: (initial: Value | (() => Value)) => {
    const index = hooks.index++;
    const value = typeof initial === "function" ? (initial as () => Value)() : initial;
    hooks.initials[index] = value;
    hooks.setters[index] ??= vi.fn();
    return [index in hooks.state ? hooks.state[index] : value, hooks.setters[index]];
  },
}));
vi.mock("../modules/reviewed-evidence/navigation.js", () => ({
  openEvidenceSession: vi.fn().mockResolvedValue(true),
}));
interface Props {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onChange?: (event: { currentTarget: { value: string } }) => void;
  readonly className?: string;
  readonly hidden?: boolean;
  readonly role?: string;
  readonly "aria-current"?: string;
}
const all = (node: ReactNode): ReactElement<Props>[] =>
  Children.toArray(node).flatMap((item) =>
    isValidElement<Props>(item) ? [item, ...all(item.props.children)] : [],
  );
const label = (node: ReactElement<Props>) =>
  Children.toArray(node.props.children)
    .filter((child) => typeof child === "string")
    .join("");
const w = workspaceMessages("en");
const SECTION = 5;
const SUBSECTION = 6;
const CLASS = 4;
const window = {
  location: { href: "http://localhost/dashboard/?class=class:b" },
  history: { state: null, replaceState: vi.fn() },
  confirm: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};
const classes = [
  { classId: "class:a", displayName: "Class A" },
  { classId: "class:b", displayName: "Class B" },
];
const runtime = { ...sessionPorts, fetch: vi.fn() };
async function ready() {
  const controller = new ProfileController(clientFixture(), release, vi.fn());
  await controller.read();
  vi.spyOn(controller, "select").mockResolvedValue();
  return controller;
}
function shell(
  state: Value[],
  options: {
    settings?: WorkspaceSettings;
    classes?: typeof classes;
    hasClassDrafts?: boolean;
    onClassChange?: (classId: string) => Promise<void>;
  } = {},
) {
  hooks.state = state;
  hooks.index = 0;
  hooks.refIndex = 0;
  hooks.effects = [];
  hooks.effectDependencies = [];
  hooks.memoDependencies = [];
  return all(
    ProfileShell({
      locale: "en",
      classes: options.classes ?? classes,
      runtime,
      settings: options.settings ?? {},
      ...(options.hasClassDrafts === undefined ? {} : { hasClassDrafts: options.hasClassDrafts }),
      ...(options.onClassChange === undefined ? {} : { onClassChange: options.onClassChange }),
    }),
  );
}
const button = (nodes: ReactElement<Props>[], text: string) => {
  const found = nodes.find((node) => node.type === "button" && label(node) === text);
  if (found === undefined) throw new Error(`Missing button ${text}`);
  return found.props;
};
const byClass = (nodes: ReactElement<Props>[], className: string) =>
  nodes.filter((node) => node.props.className === className);
const pages = (nodes: ReactElement<Props>[]) =>
  byClass(nodes, "settings-page").map((node) => node.props.hidden);
const lastUrl = () => String(window.history.replaceState.mock.lastCall?.[2]);
beforeEach(() => {
  vi.stubGlobal("window", window);
  vi.clearAllMocks();
  hooks.setters = [];
  hooks.refs = [];
  window.location.href = "http://localhost/dashboard/?class=class:b";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("starts from the remembered view and settings page, keyed by its dependencies", () => {
  window.location.href = "http://localhost/dashboard/?view=map&settings=server";
  shell([]);
  expect(hooks.initials).toEqual([null, 0, false, 0, null, "map", "server"]);
  expect(hooks.memoDependencies).toEqual([
    [runtime, profileMessages("en").confirm],
    [runtime, profileMessages("en").confirm],
  ]);
  expect(hooks.effectDependencies).toEqual([
    [runtime, 0],
    [undefined],
    [null, undefined, classes, null],
    [null, false],
  ]);
});

it("remembers the main view and settings page in the address without history entries", async () => {
  const controller = await ready();
  const nodes = shell([controller, 0, false, 0, "class:a", "sessions", "server"]);
  expect(byClass(nodes, "workspace-settings")[0]?.props.hidden).toBe(true);
  button(nodes, w.map).onClick?.();
  expect(hooks.setters[SECTION]).toHaveBeenLastCalledWith("map");
  expect(hooks.setters[SUBSECTION]).not.toHaveBeenCalled();
  expect(lastUrl()).toContain("view=map");
  expect(lastUrl()).not.toContain("settings=");
  button(nodes, w.panel).onClick?.();
  expect(hooks.setters[SECTION]).toHaveBeenLastCalledWith("settings");
  expect(hooks.setters[SUBSECTION]).toHaveBeenLastCalledWith("panel");
  expect(lastUrl()).toContain("view=settings");
  expect(lastUrl()).toContain("settings=panel");
});

it("shows one settings page at a time and center administration only when provided", async () => {
  const controller = await ready();
  const state = (part: string) => [controller, 0, false, 0, "class:a", "settings", part];
  const administration = { administration: <p>Center</p> };
  expect(byClass(shell(state("server")), "workspace-settings")[0]?.props.hidden).toBe(false);
  expect(pages(shell(state("classroom")))).toEqual([false, true, true]);
  expect(pages(shell(state("server")))).toEqual([true, false, true]);
  expect(pages(shell(state("panel")))).toEqual([true, true, false]);
  expect(pages(shell(state("administration"), { settings: administration }))).toEqual([
    true,
    true,
    true,
    false,
  ]);
  expect(pages(shell(state("server"), { settings: administration }))).toEqual([
    true,
    false,
    true,
    true,
  ]);
  // Without center administration its page falls back to the class page.
  const fallback = shell(state("administration"));
  expect(pages(fallback)).toEqual([false, true, true]);
  expect(button(fallback, w.classroom)).toMatchObject({ "aria-current": "page" });
  expect(fallback.some((node) => label(node) === w.administration)).toBe(false);
  const nav = shell(state("classroom"), { settings: administration });
  expect(nav.some((node) => node.type === "button" && label(node) === w.administration)).toBe(true);
  // Keys reset the class settings per class; React escapes ":" as "=2".
  expect(shell(state("panel")).some((node) => node.key === ".$education=2class=2a")).toBe(true);
  expect(
    shell([controller, 0, false, 0, null, "settings", "panel"]).some(
      (node) => node.key === ".$education=2none",
    ),
  ).toBe(true);
});

it("mounts panel diagnostics only while that page is open", async () => {
  const controller = await ready();
  const usage = { ...selection, moduleId: "org.marea.module.usage" };
  const descriptor = catalog().modules[0];
  if (!descriptor) throw new Error("missing descriptor");
  controller.catalog = {
    ...catalog(),
    modules: [...catalog().modules, { ...descriptor, id: usage.moduleId }],
  };
  controller.edit({ ...value, modules: [usage] });
  const modules = (section: string, part: string) =>
    Children.toArray(
      byClass(shell([controller, 0, false, 0, "class:a", section, part]), "settings-modules")[0]
        ?.props.children,
    ).length;
  expect([
    modules("settings", "panel"),
    modules("sessions", "panel"),
    modules("settings", "server"),
  ]).toEqual([1, 0, 0]);
});

it("shows loading or an empty view only where they apply", async () => {
  const loading = (section: string) =>
    shell([null, 0, false, 0, "class:a", section, "panel"]).filter(
      (node) => node.props.role === "status" && label(node) === profileMessages("en").loading,
    ).length;
  // The hidden panel page always carries its own notice; other views add the shell's.
  expect([loading("sessions"), loading("settings")]).toEqual([2, 1]);
  expect(
    byClass(shell([null, 0, false, 0, "class:a", "map", "panel"]), "workspace-empty"),
  ).toHaveLength(0);
  const controller = await ready();
  expect(
    byClass(shell([controller, 0, false, 0, "class:a", "settings", "panel"]), "workspace-empty"),
  ).toHaveLength(0);
  const nodes = shell([controller, 0, false, 0, "class:a", "map", "classroom"]);
  expect(byClass(nodes, "workspace-empty")).toHaveLength(1);
  button(nodes, w.configure).onClick?.();
  expect(hooks.setters[SECTION]).toHaveBeenLastCalledWith("settings");
  expect(hooks.setters[SUBSECTION]).toHaveBeenLastCalledWith("panel");
});

it("restores the remembered class, or the only class, once the profile is ready", async () => {
  const controller = await ready();
  const restore = (state: Value[], options: { classes?: typeof classes } = {}) => {
    hooks.setters[CLASS]?.mockClear();
    shell(state, options);
    hooks.effects[2]?.();
    return hooks.setters[CLASS]?.mock.calls.map(([value]) => value as string) ?? [];
  };
  const idle = [controller, 0, false, 0, null, "sessions", "classroom"];
  expect(restore(idle)).toEqual(["class:b"]);
  expect(lastUrl()).toContain("class=class%3Ab");
  window.location.href = "http://localhost/dashboard/";
  expect(restore(idle)).toEqual([]);
  expect(restore(idle, { classes: classes.slice(0, 1) })).toEqual(["class:a"]);
  expect(restore(idle, { classes: [] })).toEqual([]);
  expect(restore([null, 0, false, 0, null, "sessions", "classroom"])).toEqual([]);
  window.location.href = "http://localhost/dashboard/?class=class:b";
  expect(restore([controller, 0, false, 0, "class:a", "sessions", "classroom"])).toEqual([]);
  controller.busy = true;
  expect(restore(idle, { classes: classes.slice(0, 1) })).toEqual([]);
});

it("asks before discarding class drafts and ignores classes outside the list", async () => {
  const controller = await ready();
  const onClassChange = vi.fn().mockResolvedValue(undefined);
  const nodes = shell([controller, 0, false, 0, "class:a", "sessions", "classroom"], {
    hasClassDrafts: true,
    onClassChange,
  });
  const selector = nodes.find((node) => node.type === "select")?.props;
  selector?.onChange?.({ currentTarget: { value: "class:unknown" } });
  expect(window.confirm).not.toHaveBeenCalled();
  window.confirm.mockReturnValueOnce(false);
  selector?.onChange?.({ currentTarget: { value: "class:b" } });
  expect(onClassChange).not.toHaveBeenCalled();
  expect(window.confirm).toHaveBeenCalledWith(w.discard);
  window.confirm.mockReturnValueOnce(true);
  selector?.onChange?.({ currentTarget: { value: "class:b" } });
  expect(hooks.setters[CLASS]).toHaveBeenCalledWith("class:b");
  expect(onClassChange).toHaveBeenCalledWith("class:b");
});

it("guards leaving with unsent notices, unsaved panels or class drafts", async () => {
  const controller = await ready();
  const guarded = (setup: () => void, hasClassDrafts?: boolean, profile: Value = controller) => {
    hooks.refs = [];
    shell(
      [profile, 0, false, 0, "class:a", "sessions", "classroom"],
      hasClassDrafts === undefined ? {} : { hasClassDrafts },
    );
    setup();
    window.addEventListener.mockClear();
    const remove = hooks.effects[3]?.();
    expect(window.addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    const guard = window.addEventListener.mock.lastCall?.[1] as (event: object) => void;
    const preventDefault = vi.fn();
    guard({ preventDefault });
    remove?.();
    expect(window.removeEventListener).toHaveBeenCalledWith("beforeunload", guard);
    return preventDefault.mock.calls.length;
  };
  const session = () => {
    const ref = hooks.refs[0];
    if (ref) ref.current = { hasUnsavedDrafts: true };
  };
  expect(guarded(() => undefined)).toBe(0);
  expect(guarded(() => undefined, undefined, null)).toBe(0);
  expect(guarded(() => undefined, true)).toBe(1);
  expect(guarded(session)).toBe(1);
  vi.spyOn(controller, "dirty", "get").mockReturnValue(true);
  expect(guarded(() => undefined)).toBe(1);
});

it("returns to sessions after opening evidence and to server settings to configure a task", async () => {
  const opened = vi.spyOn(evidence, "createReviewedEvidenceAdapters");
  const configured = vi.spyOn(educational, "createEducationalAdapters");
  shell([await ready(), 0, false, 0, "class:a", "progress", "classroom"]);
  vi.mocked(openEvidenceSession).mockResolvedValueOnce(false);
  await opened.mock.lastCall?.[1]("class:a", "run:1", new AbortController().signal);
  expect(hooks.setters[SECTION]).not.toHaveBeenCalled();
  await opened.mock.lastCall?.[1]("class:a", "run:1", new AbortController().signal);
  expect(hooks.setters[SECTION]).toHaveBeenLastCalledWith("sessions");
  configured.mock.lastCall?.[2]?.();
  expect(hooks.setters[SECTION]).toHaveBeenLastCalledWith("settings");
  expect(hooks.setters[SUBSECTION]).toHaveBeenLastCalledWith("server");
});
