import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { tree, text } from "../modules/server-settings/forms.fixture.js";
import { ClassSettings } from "./class-settings.js";
import { ServerSections, serverSections } from "../modules/server-settings/sections.js";
const { hooks, mockReact } = await vi.hoisted(async () =>
  (await import("../modules/server-settings/state-hooks.fixture.js")).stateHarness(),
);
vi.mock("react", async (original) => mockReact(original));
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
});
it("keeps all class drafts mounted and switches only the visible panel", () => {
  const content = {
    tutor: <p>Tutor</p>,
    access: <p>Access</p>,
    features: <p>Features</p>,
    library: <p>Library</p>,
  };
  const render = () => {
    hooks.index = 0;
    return tree(<ClassSettings locale="en" content={content} />);
  };
  render();
  expect(hooks.values[0]).toBe("tutor");
  for (const [index, key] of ["tutor", "access", "features", "library"].entries()) {
    const button = render().filter((node) => node.type === "button")[index];
    (button?.props.onClick as () => void)();
    expect(hooks.values[0]).toBe(key);
    hooks.index = 0;
    expect(renderToStaticMarkup(<ClassSettings locale="en" content={content} />)).toMatchSnapshot(
      key,
    );
    expect(render().filter((node) => node.type === "p")).toHaveLength(4);
    expect(
      render().filter((node) => node.type === "div" && node.props.hidden === false),
    ).toHaveLength(1);
  }
});
it("shows localized section names and one selected server section", () => {
  const change = vi.fn();
  for (const locale of ["es", "en", "eu"] as const) {
    for (const value of serverSections) {
      expect(
        renderToStaticMarkup(<ServerSections locale={locale} value={value} change={change} />),
      ).toMatchSnapshot(`${locale} ${value}`);
      const nodes = tree(<ServerSections locale={locale} value={value} change={change} />);
      const buttons = nodes.filter((node) => node.type === "button");
      expect(buttons).toHaveLength(6);
      expect(buttons.filter((node) => node.props["aria-current"] === "page")).toHaveLength(1);
      for (const [index, button] of buttons.entries()) {
        expect(text(button)).not.toBe("");
        (button.props.onClick as () => void)();
        expect(change).toHaveBeenLastCalledWith(serverSections[index]);
      }
    }
  }
});
