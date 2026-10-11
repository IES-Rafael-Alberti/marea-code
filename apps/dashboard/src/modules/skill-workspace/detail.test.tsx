import { expect, it, vi } from "vitest";
import { SkillDetail } from "./detail.js";
import { workspaceFixture } from "./workspace.fixture.js";
import { skillWorkspaceMessages } from "./messages.js";
import { tree, text } from "../server-settings/forms.fixture.js";
const m = skillWorkspaceMessages("en");
it("shows complete source, allows copying or authorized editing and confirms withdrawal before deletion", async () => {
  const f = workspaceFixture(),
    c = f.controller,
    assign = vi.fn();
  const render = () => tree(<SkillDetail controller={c} messages={m} assign={assign} />);
  const click = (caption: string) => {
    const button = render().find((node) => node.type === "button" && text(node) === caption);
    if (!button) throw new Error(caption);
    (button.props.onClick as () => void)();
  };
  expect(render()).toEqual([]);
  await c.load();
  await c.open(f.bundle.id);
  expect(render().find((node) => node.type === "aside")?.props["aria-label"]).toBe("Unit testing");
  expect(render().find((node) => node.type === "pre")?.props.children).toBe(
    f.bundle.files[0]?.content,
  );
  expect(render().some((node) => node.type === "li" && text(node).includes("Physics"))).toBe(true);
  click(m.add);
  expect(assign).toHaveBeenCalledWith(f.bundle);
  click(m.edit);
  expect(c.editor?.skillId).toBe(f.bundle.id);
  c.closeEditor();
  click(m.deleteTitle);
  await vi.waitFor(() => {
    expect(c.deleting).toBe(true);
  });
  expect(render().some((node) => node.props.role === "alertdialog")).toBe(true);
  expect(render().some((node) => text(node) === m.deleteHelp)).toBe(true);
  click(m.cancel);
  expect(c.deleting).toBe(false);
  click(m.deleteTitle);
  await vi.waitFor(() => {
    expect(c.deleting).toBe(true);
  });
  click(m.confirmDelete);
  await vi.waitFor(() => {
    expect(c.notice).toBe("deleted");
  });
  expect(c.detail).toBeNull();
  expect(c.drafts.has(f.bundle.id)).toBe(false);
  await c.open(f.bundle.id);
  if (!c.detail || !c.usage) throw new Error("detail");
  c.detail = { ...c.detail, editable: false };
  expect(render().some((node) => text(node) === m.deleteTitle)).toBe(false);
  click(m.copy);
  expect(c.editor?.skillId).toBeNull();
  c.usage = {
    ...c.usage,
    uses: [{ classId: "c", displayName: "Only students", classroom: false, students: 0 }],
  };
  render();
  c.usage = { ...c.usage, uses: [] };
  expect(render().some((node) => text(node) === m.unused)).toBe(true);
  c.detail = { ...c.detail, skill: { ...f.bundle, files: [] } };
  expect(render().find((node) => node.type === "h3")?.props.children).toBe("testing");
  c.usage = null;
  render();
  click(m.close);
  expect(c.detail).toBeNull();
});
it("shows the main file after companion resources and clears deletion confirmation on closing", async () => {
  const f = workspaceFixture(),
    c = f.controller;
  await c.open(f.bundle.id);
  if (!c.detail) throw new Error("detail");
  c.detail = {
    ...c.detail,
    skill: {
      ...f.bundle,
      files: [{ path: "resources/a.txt", content: "resource", sizeBytes: 8 }, ...f.bundle.files],
    },
  };
  const nodes = tree(<SkillDetail controller={c} messages={m} assign={vi.fn()} />);
  expect(nodes.find((node) => node.type === "pre")?.props.children).toBe(
    f.bundle.files[0]?.content,
  );
  await c.reviewDeletion();
  expect(c.deleting).toBe(true);
  c.closeDetail();
  expect(c.deleting).toBe(false);
});
