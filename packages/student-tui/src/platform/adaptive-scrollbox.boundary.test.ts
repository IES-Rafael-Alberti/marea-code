import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => {
  const update = vi.fn();
  const resize = vi.fn();
  class Scrollbox {
    content = { y: -5 };
    verticalScrollBar = { slider: { viewPortSize: 0.01 }, viewportSize: 19 };
    private rows: number;
    get height() {
      return this.rows;
    }
    set height(value: number) {
      resize(value);
      this.rows = value;
    }
    children: { y: number; height: number }[] = [];
    requestRender = vi.fn();
    getChildren() {
      return this.children;
    }
    constructor(
      readonly context: object,
      readonly options: { height: number },
    ) {
      this.rows = options.height;
    }
    onUpdate(delta: number) {
      update(delta);
    }
  }
  return { Scrollbox, update, resize };
});
vi.mock("@opentui/react", () => ({ baseComponents: { scrollbox: native.Scrollbox } }));
import { ReferenceScrollbox } from "./adaptive-scrollbox.boundary.js";
function box(options: { contentBottomInset?: number } = {}) {
  return new ReferenceScrollbox({} as never, options) as unknown as InstanceType<
    typeof native.Scrollbox
  > & { contentBottomInset: number };
}
it("measures wrapped children relative to scrolled content and preserves bounded padding", () => {
  const view = box({ contentBottomInset: 3 });
  expect(view.options).toEqual({ contentBottomInset: 3, height: 18 });
  view.children = [{ y: -4, height: 1 }];
  view.onUpdate(16);
  expect(native.update).toHaveBeenLastCalledWith(16);
  expect(view.verticalScrollBar.slider.viewPortSize).toBe(19);
  expect(view.height).toBe(5);
  view.children = [
    { y: -4, height: 1 },
    { y: -2, height: 10 },
  ];
  view.onUpdate(17);
  expect(view.height).toBe(16);
  view.children = [{ y: -4, height: 30 }];
  view.onUpdate(18);
  expect(view.height).toBe(18);
  native.resize.mockClear();
  view.onUpdate(19);
  expect(native.resize).not.toHaveBeenCalled();
  expect(view.height).toBe(18);
});
it("remeasures after inset changes and handles an empty preview", () => {
  const view = box();
  view.onUpdate(1);
  expect(view.height).toBe(0);
  view.contentBottomInset = 2;
  expect(view.requestRender).toHaveBeenCalledOnce();
  view.onUpdate(2);
  expect(view.height).toBe(2);
});
