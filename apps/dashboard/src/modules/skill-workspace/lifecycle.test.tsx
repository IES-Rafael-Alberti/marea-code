import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillsWorkspace } from "./view.js";
import { workspaceFixture } from "./workspace.fixture.js";
import { tree, text, change } from "../server-settings/forms.fixture.js";
const { hooks, refs, resetRender, mockReact, m } = await vi.hoisted(async () =>
  (await import("./view-hooks.fixture.js")).viewHooks(),
);
vi.mock("react", async (original) => mockReact(original));
beforeEach(() => {
  hooks.values = [];
  hooks.effects = [];
  refs.values = [];
  resetRender();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
function click(nodes: ReturnType<typeof tree>, caption: string) {
  const found = nodes.find((node) => node.type === "button" && text(node) === caption);
  if (!found) throw new Error(caption);
  (found.props.onClick as () => void)();
}
it("retains controllers and drafts per class, guards unsaved work and disposes on logout", async () => {
  const f = workspaceFixture();
  const add = vi.fn(),
    remove = vi.fn();
  vi.stubGlobal("window", { addEventListener: add, removeEventListener: remove });
  const render = (classId: string | null) => {
    resetRender();
    hooks.dependencies = [];
    return tree(
      <SkillsWorkspace
        classId={classId}
        fetchRequest={f.request}
        locale="en"
        teachingChanged={f.teachingChanged}
      />,
    );
  };
  expect(render(null).some((node) => text(node) === m.noClass)).toBe(true);
  hooks.effects[0]?.();
  render("class:one");
  const dependency = hooks.dependencies[0]?.[0];
  expect(dependency).toBeDefined();
  hooks.effects[0]?.();
  expect(hooks.values[0]).toBe(true);
  const cleanup = hooks.effects[1]?.();
  await vi.waitFor(() => {
    expect(f.request.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  await Promise.resolve();
  expect(hooks.values[0]).toBe(false);
  render("class:one");
  hooks.effects[0]?.();
  click(render("class:one"), m.add);
  click(render("class:one"), m.select);
  await vi.waitFor(() => {
    expect(f.teachingChanged).toHaveBeenCalledOnce();
  });
  click(render("class:one"), m.newSkill);
  const markdown = () =>
    render("class:one").find((node) => node.props.id === "skill-markdown")?.props as {
      onChange: (event: object) => void;
      value: string;
    };
  const name = markdown();
  change(name, { value: "My draft" });
  expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  const unload = add.mock.calls[0]?.[1] as (event: object) => void;
  const preventDefault = vi.fn();
  unload({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  render("class:two");
  expect(hooks.dependencies[0]?.[0]).not.toBe(dependency);
  preventDefault.mockClear();
  unload({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  render("class:one");
  expect(markdown().value).toBe("My draft");
  click(render("class:one"), m.discard);
  preventDefault.mockClear();
  unload({ preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  cleanup?.();
  expect(remove).toHaveBeenCalledWith("beforeunload", unload);
  expect(f.request.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
});
