import { expect, it, vi } from "vitest";
import { SkillDetail } from "./detail.js";
import { workspaceFixture } from "./workspace.fixture.js";
import { skillWorkspaceMessages } from "./messages.js";
import { tree, text } from "../server-settings/forms.fixture.js";
import { createBrowserSkillAuthoringFileExchange } from "../skill-authoring/skill-authoring-files.js";
const m = skillWorkspaceMessages("en");
const exported = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../skill-authoring/skill-authoring-files.js", () => ({
  createBrowserSkillAuthoringFileExchange: () => ({ exportFile: exported }),
}));
function click(nodes: ReturnType<typeof tree>, caption: string) {
  const button = nodes.find((node) => node.type === "button" && text(node) === caption);
  if (!button) throw new Error(caption);
  (button.props.onClick as () => void)();
}
it("offers safe preview, copying bundled skills, downloading files and authorized editing", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  const assign = vi.fn();
  const render = () => tree(<SkillDetail controller={c} messages={m} assign={assign} />);
  expect(render()).toEqual([]);
  await c.open(f.bundle.id);
  expect(render().find((node) => node.type === "aside")?.props["aria-label"]).toBe("Unit testing");
  expect(render().some((node) => node.type === "li" && text(node).includes("Physics"))).toBe(true);
  click(render(), m.add);
  expect(assign).toHaveBeenCalledWith(f.bundle);
  click(render(), m.edit);
  expect(c.editor?.skillId).toBe(f.bundle.id);
  click(render(), `${m.exportFile}: SKILL.md`);
  await vi.waitFor(() => {
    expect(c.busy).toBe(false);
  });
  expect(exported).toHaveBeenCalledWith("SKILL.md", f.bundle.files[0]?.content, true);
  expect(createBrowserSkillAuthoringFileExchange()).toBeDefined();
  if (!c.detail) throw new Error("detail");
  c.detail = {
    ...c.detail,
    editable: false,
    skill: { ...f.bundle, criteria: [{ code: "RA1", statement: "Tests", levels: null }] },
  };
  click(render(), m.copy);
  expect(c.editor?.skillId).toBeNull();
  expect(render().some((node) => node.type === "li" && text(node) === "RA1: Tests")).toBe(true);
  if (!c.usage) throw new Error("usage");
  c.usage = { ...c.usage, uses: [] };
  expect(render().some((node) => text(node) === m.unused)).toBe(true);
  c.detail = { ...c.detail, skill: { ...f.bundle, files: [] } };
  expect(render().find((node) => node.type === "h3")?.props.children).toBe("testing");
  c.usage = null;
  render();
  click(render(), m.close);
  expect(c.detail).toBeNull();
});
