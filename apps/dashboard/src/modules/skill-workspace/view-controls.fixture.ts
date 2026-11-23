import { SkillsClass } from "./view.js";
import { workspaceFixture } from "./workspace.fixture.js";
import { tree, text } from "../server-settings/forms.fixture.js";
import type { SkillWorkspaceMessages } from "./messages.js";
export const buttons = (nodes: ReturnType<typeof tree>, caption: string) =>
  nodes.filter((node) => node.type === "button" && text(node) === caption);
export function click(nodes: ReturnType<typeof tree>, caption: string, index = 0) {
  const button = buttons(nodes, caption)[index];
  if (!button) throw new Error(caption);
  (button.props.onClick as () => void)();
}
export function skillViewFixture(resetRender: () => void, m: SkillWorkspaceMessages) {
  const f = workspaceFixture();
  const c = f.controller;
  const render = () => {
    resetRender();
    return tree(SkillsClass({ controller: c, messages: m }));
  };
  return {
    ...f,
    c,
    render,
    checkStudent: (name: string) => {
      const checkbox = render().find((node) => node.props["aria-label"] === name);
      (checkbox?.props.onChange as (event: object) => void)({ currentTarget: { checked: true } });
    },
    click: (caption: string, index = 0) => {
      click(render(), caption, index);
    },
  };
}
