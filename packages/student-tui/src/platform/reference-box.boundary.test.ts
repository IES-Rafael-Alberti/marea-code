import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => {
  const paint = vi.fn();
  class Box {
    x = 3;
    y = 5;
    width: number;
    height: number;
    borderColor = "border";
    backgroundColor = "background";
    requestRender = vi.fn();
    constructor(_context: unknown, options: { width?: number; height?: number }) {
      this.width = options.width ?? 6;
      this.height = options.height ?? 3;
    }
    renderSelf(buffer: unknown) {
      paint(buffer);
    }
  }
  return { Box, extend: vi.fn(), paint };
});
vi.mock("@opentui/core", () => ({ RGBA: { fromHex: (color: string) => color } }));
vi.mock("@opentui/react", () => ({
  baseComponents: { box: native.Box, scrollbox: native.Box },
  extend: native.extend,
}));
import { registerReferenceBoxes } from "./reference-box.boundary.js";

function box(options: Record<string, unknown> = {}) {
  registerReferenceBoxes();
  const registered = native.extend.mock.lastCall?.[0] as {
    referenceBox: new (
      context: unknown,
      options: Record<string, unknown>,
    ) => {
      renderSelf: (buffer: unknown) => void;
      referenceBottomColor: string | undefined;
      referencePressed: boolean;
      referenceBorder: "tall" | "button" | null;
      requestRender: () => void;
    };
  };
  return new registered.referenceBox({}, options);
}
it("paints Textual tall edges at the native coordinates without changing the inner cells", () => {
  const drawText = vi.fn((_text: string, _x: number, y: number) => {
    expect(y).toBeGreaterThanOrEqual(5);
  });
  const view = box({ referenceBorder: "tall" });
  view.renderSelf({ drawText });
  expect(drawText.mock.calls).toEqual([
    ["▔▔▔▔", 4, 5, "border", "background"],
    ["▁▁▁▁", 4, 7, "border", "background"],
    ["▊", 3, 5, "background", "border"],
    ["▎", 8, 5, "border", "background"],
    ["▊", 3, 6, "background", "border"],
    ["▎", 8, 6, "border", "background"],
    ["▊", 3, 7, "background", "border"],
    ["▎", 8, 7, "border", "background"],
  ]);
});
it("paints button top/bottom edges and redraws after changing the variant", () => {
  const drawText = vi.fn();
  const view = box();
  view.renderSelf({ drawText });
  expect(drawText).not.toHaveBeenCalled();
  native.paint.mockClear();
  view.referenceBorder = "button";
  expect(view.requestRender).toHaveBeenCalledOnce();
  view.renderSelf({ drawText });
  expect(native.paint).toHaveBeenCalledOnce();
  expect(drawText.mock.calls).toEqual([
    ["▔▔▔▔▔▔", 3, 5, "border", "background"],
    ["▁▁▁▁▁▁", 3, 7, "border", "background"],
  ]);
});
it.each([
  { width: 1, height: 3 },
  { width: 6, height: 1 },
])("does not draw outside a collapsed frame %o", (options) => {
  const drawText = vi.fn();
  box({ ...options, referenceBorder: "tall" }).renderSelf({ drawText });
  expect(drawText).not.toHaveBeenCalled();
});
it("supports the smallest complete frame without painting an inner edge", () => {
  const drawText = vi.fn();
  box({ width: 2, height: 2, referenceBorder: "tall" }).renderSelf({ drawText });
  expect(drawText.mock.calls).toEqual([
    ["▊", 3, 5, "background", "border"],
    ["▎", 4, 5, "border", "background"],
    ["▊", 3, 6, "background", "border"],
    ["▎", 4, 6, "border", "background"],
  ]);
});

it("uses the button's darker lower edge and redraws when it changes", () => {
  const drawText = vi.fn();
  const view = box({ referenceBorder: "button", referenceBottomColor: "#008139" });
  view.renderSelf({ drawText });
  expect(drawText).toHaveBeenLastCalledWith("▁▁▁▁▁▁", 3, 7, "#008139", "background");
  view.referenceBottomColor = "#004295";
  expect(view.requestRender).toHaveBeenCalledOnce();
  view.renderSelf({ drawText });
  expect(drawText).toHaveBeenLastCalledWith("▁▁▁▁▁▁", 3, 7, "#004295", "background");
});

it("reverses the bevel while pressed without shifting the button or its text", () => {
  const view = box({
    referenceBorder: "button",
    referenceBottomColor: "shadow",
    referencePressed: true,
  });
  const drawText = vi.fn();
  view.renderSelf({ drawText });
  expect(drawText.mock.calls).toEqual([
    ["▁▁▁▁▁▁", 3, 5, "shadow", "background"],
    ["▔▔▔▔▔▔", 3, 7, "border", "background"],
  ]);
  view.referencePressed = false;
  expect(view.requestRender).toHaveBeenCalledOnce();
  drawText.mockClear();
  view.renderSelf({ drawText });
  expect(drawText.mock.calls).toEqual([
    ["▔▔▔▔▔▔", 3, 5, "border", "background"],
    ["▁▁▁▁▁▁", 3, 7, "shadow", "background"],
  ]);
});
