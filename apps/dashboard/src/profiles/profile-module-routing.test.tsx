import { confirmDiscardWindow } from "./profile.fixture.js";
import { PreviewPanel } from "../telemetry/preview-panel.js";
import { moduleSection } from "./workspace-navigation.js";
import { Children, isValidElement, type ReactNode, type DependencyList } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProfileController } from "./profile-controller.js";
import * as educationalAdapterModule from "../modules/educational-insights/adapter.js";
import * as evidenceAdapterModule from "../modules/reviewed-evidence/adapter.js";
import { profileMessages } from "./profile-messages.js";
import { SessionsController } from "../modules/sessions/sessions-controller.js";
import { ProfileShell } from "./profile-shell.js";
import { ModulePlugin, type ModuleAdapter } from "./module-plugin.js";
import { SessionPlugin } from "./session-plugin.js";
import { ProfileController as Controller } from "./profile-controller.js";
import { catalog, clientFixture, release, selection, value } from "./profile.fixture.js";
import { sessionPorts } from "../../browser/typed-host-data.fixture.js";
const hooks = vi.hoisted(() => ({
  controller: null as ProfileController | null,
  index: 0,
  section: "sessions",
  subsection: "panel",
  classId: null as string | null,
  session: null as SessionsController | null,
  memos: [] as { dependencies: DependencyList; value: object }[],
  memoIndex: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (create: () => object, dependencies: DependencyList) => {
    const index = hooks.memoIndex++;
    const previous = hooks.memos[index];
    if (
      dependencies.length === previous?.dependencies.length &&
      dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))
    )
      return previous.value;
    const value = create();
    hooks.memos[index] = { dependencies, value };
    return value;
  },
  useState: () => [
    [hooks.controller, 0, false, 0, hooks.classId, hooks.section, hooks.subsection][hooks.index++],
    vi.fn(),
  ],
  useRef: (current: object | null) => ({ current: current ?? hooks.session }),
  useEffect: vi.fn(),
}));
beforeEach(() => {
  hooks.memos = [];
  hooks.memoIndex = 0;
  hooks.session = null;
  hooks.classId = "class:a";
});
function nodes(node: ReactNode): ReactNode[] {
  return Children.toArray(node).flatMap((item) =>
    isValidElement<{ children?: ReactNode }>(item) ? [item, ...nodes(item.props.children)] : [],
  );
}
it.each([
  "synthetic.library",
  "org.marea.module.map",
  "org.marea.module.progress",
  "org.marea.module.reports",
])("routes authorized module %s to its registered adapter", async (moduleId) => {
  const controller = new Controller(clientFixture(), release, vi.fn());
  await controller.read();
  const descriptor = catalog().modules[0];
  if (!descriptor) throw new Error("missing descriptor");
  const library = { ...selection, moduleId };
  hooks.classId = moduleId === "org.marea.module.map" ? null : "class:a";
  controller.catalog = {
    ...catalog(),
    modules: [...catalog().modules, { ...descriptor, id: library.moduleId }],
  };
  controller.edit({ ...value, modules: [library] });
  hooks.controller = controller;
  hooks.section = moduleSection(moduleId);
  hooks.index = 0;
  hooks.memoIndex = 0;
  const adapter = vi.fn<ModuleAdapter>();
  const tree = ProfileShell({
    locale: "en",
    classes: [],
    runtime: {
      ...sessionPorts,
      fetch: vi.fn(),
      moduleAdapters: new Map([[library.moduleId, adapter]]),
    },
  });
  const modules = nodes(tree).filter(
    (node) => isValidElement(node) && (node.type === ModulePlugin || node.type === SessionPlugin),
  );
  expect(modules).toHaveLength(1);
  const child = modules[0];
  expect(isValidElement(child) && child.type).toBe(ModulePlugin);
  if (!isValidElement<{ module: object; adapter: ModuleAdapter }>(child))
    throw new Error("Missing module");
  expect(child.props.module).toEqual(library);
  if (moduleId === "synthetic.library") expect(child.props.adapter).toBe(adapter);
  // First-party insight and evidence adapters take precedence over a same-named runtime adapter.
  else {
    expect(child.props.adapter).toBeTypeOf("function");
    expect(child.props.adapter).not.toBe(adapter);
  }
  expect(adapter).not.toHaveBeenCalled();
});

/** A mounted session with an unsent draft whose discard decision the teacher declines. */
function draftSession() {
  const runtime = { ...sessionPorts, fetch: vi.fn() };
  const session = new SessionsController(runtime.sessions, runtime.notices, vi.fn());
  session.state = { ...session.state, classId: "class:a", connection: "current" };
  vi.spyOn(session, "hasUnsavedDrafts", "get").mockReturnValue(true);
  const confirm = confirmDiscardWindow();
  hooks.controller = null;
  hooks.index = 0;
  hooks.memoIndex = 0;
  hooks.session = session;
  return { runtime, session, confirm };
}

it("binds evidence navigation to the mounted session and the localized dirty-draft decision", async () => {
  const { runtime, session, confirm } = draftSession();
  const adapters = vi.spyOn(evidenceAdapterModule, "createReviewedEvidenceAdapters");
  ProfileShell({ locale: "en", classes: [], runtime });
  const navigate = adapters.mock.lastCall?.[1];
  if (navigate === undefined) throw new Error("missing navigator");
  expect(await navigate("class:a", "run:1", new AbortController().signal)).toBe(false);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(profileMessages("en").confirm);
  hooks.index = 0;
  hooks.memoIndex = 0;
  ProfileShell({ locale: "es", classes: [], runtime });
  const translatedNavigate = adapters.mock.lastCall?.[1];
  if (translatedNavigate === undefined) throw new Error("missing translated navigator");
  confirm.mockClear();
  expect(await translatedNavigate("class:a", "run:1", new AbortController().signal)).toBe(false);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(profileMessages("es").confirm);
  session.dispose();
});

it("binds educational navigation to the session and localized discard confirmation", async () => {
  const { runtime, session, confirm } = draftSession();
  const adapters = vi.spyOn(educationalAdapterModule, "createEducationalAdapters");
  ProfileShell({ locale: "es", classes: [], runtime });
  const navigate = adapters.mock.lastCall?.[1];
  if (!navigate) throw new Error("missing navigator");
  expect(await navigate("class:a", "run:1", new AbortController().signal)).toBe(false);
  expect(confirm).toHaveBeenCalledWith(profileMessages("es").confirm);
  session.dispose();
  vi.unstubAllGlobals();
});

it("disables class selection until the profile has initialized and while it is loading", () => {
  for (const ready of [false, true]) {
    const controller = new Controller(clientFixture(), release, vi.fn());
    controller.busy = !ready;
    hooks.controller = controller;
    hooks.index = 0;
    hooks.memoIndex = 0;
    const tree = ProfileShell({
      locale: "en",
      classes: [],
      runtime: { ...sessionPorts, fetch: vi.fn() },
    });
    const select = nodes(tree).find((node) => isValidElement(node) && node.type === "select");
    expect(isValidElement<{ disabled: boolean }>(select) && select.props.disabled).toBe(!ready);
  }
});

it("retains the telemetry preview in advanced settings with the selected class", () => {
  hooks.controller = new Controller(clientFixture(), release, vi.fn());
  hooks.section = "settings";
  hooks.classId = "class:a";
  hooks.index = 0;
  hooks.memoIndex = 0;
  const fetch = vi.fn();
  const tree = ProfileShell({ locale: "en", classes: [], runtime: { ...sessionPorts, fetch } });
  const preview = nodes(tree).find((node) => isValidElement(node) && node.type === PreviewPanel);
  expect(isValidElement(preview) && preview.props).toEqual({
    classId: "class:a",
    locale: "en",
    fetchRequest: fetch,
  });
});
