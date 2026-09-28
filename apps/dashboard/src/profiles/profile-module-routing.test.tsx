import { Children, isValidElement, type ReactNode, type DependencyList } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProfileController } from "./profile-controller.js";
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
  session: null as SessionsController | null,
  memo: null as { dependencies: DependencyList; value: object } | null,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (create: () => object, dependencies: DependencyList) => {
    const previous = hooks.memo;
    if (
      previous !== null &&
      dependencies.length === previous.dependencies.length &&
      dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))
    )
      return previous.value;
    hooks.memo = { dependencies, value: create() };
    return hooks.memo.value;
  },
  useState: () => [[hooks.controller, 0, false, 0, "class:a"][hooks.index++], vi.fn()],
  useRef: (current: object | null) => ({ current: current ?? hooks.session }),
  useEffect: vi.fn(),
}));
beforeEach(() => {
  hooks.memo = null;
  hooks.session = null;
});
function nodes(node: ReactNode): ReactNode[] {
  return Children.toArray(node).flatMap((item) =>
    isValidElement<{ children?: ReactNode }>(item) ? [item, ...nodes(item.props.children)] : [],
  );
}
it("routes authorized non-session IDs to their own registered adapters", async () => {
  const controller = new Controller(clientFixture(), release, vi.fn());
  await controller.read();
  const descriptor = catalog().modules[0];
  if (!descriptor) throw new Error("missing descriptor");
  const library = { ...selection, moduleId: "synthetic.library" };
  controller.catalog = {
    ...catalog(),
    modules: [...catalog().modules, { ...descriptor, id: library.moduleId }],
  };
  controller.edit({ ...value, modules: [library] });
  hooks.controller = controller;
  hooks.index = 0;
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
  expect(isValidElement(child) && child.props).toMatchObject({ module: library, adapter });
  expect(adapter).not.toHaveBeenCalled();
});

it("binds evidence navigation to the mounted session and the localized dirty-draft decision", async () => {
  const runtime = { ...sessionPorts, fetch: vi.fn() };
  const session = new SessionsController(runtime.sessions, runtime.notices, vi.fn());
  session.state = { ...session.state, classId: "class:a", connection: "current" };
  vi.spyOn(session, "hasUnsavedDrafts", "get").mockReturnValue(true);
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal("window", { confirm });
  const adapters = vi.spyOn(evidenceAdapterModule, "createReviewedEvidenceAdapters");
  hooks.controller = null;
  hooks.index = 0;
  hooks.session = session;
  ProfileShell({ locale: "en", classes: [], runtime });
  const navigate = adapters.mock.lastCall?.[1];
  if (navigate === undefined) throw new Error("missing navigator");
  expect(await navigate("class:a", "run:1", new AbortController().signal)).toBe(false);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(profileMessages("en").confirm);
  hooks.index = 0;
  ProfileShell({ locale: "es", classes: [], runtime });
  const translatedNavigate = adapters.mock.lastCall?.[1];
  if (translatedNavigate === undefined) throw new Error("missing translated navigator");
  confirm.mockClear();
  expect(await translatedNavigate("class:a", "run:1", new AbortController().signal)).toBe(false);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(profileMessages("es").confirm);
  session.dispose();
});
