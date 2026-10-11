import type { ReactNode } from "react";
import { tree, text } from "../server-settings/forms.fixture.js";
import type { StateHooks } from "../server-settings/state-hooks.fixture.js";

export function editorControls(hooks: StateHooks, element: () => ReactNode) {
  const render = () => {
    hooks.index = 0;
    return tree(element());
  };
  const button = (caption: string) => {
    const found = render().find((node) => node.type === "button" && text(node) === caption);
    if (!found) throw new Error(caption);
    return found;
  };
  const click = (caption: string) => {
    (button(caption).props.onClick as () => void)();
  };
  return { render, button, click };
}
