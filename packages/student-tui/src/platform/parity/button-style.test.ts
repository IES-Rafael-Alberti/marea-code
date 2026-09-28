import { expect, it } from "vitest";
import { PALETTE } from "../../parity/tokens.js";
import { buttonStyle } from "./button-style.js";
it.each([
  [PALETTE.buttonApprove, "#7ae998", "#008139", "#0a180e"],
  [PALETTE.buttonApproveFocused, "#7ae998", "#008139", "#0b180f"],
  [PALETTE.buttonReject, "#e76580", "#780028", "#f5e5e9"],
  [PALETTE.buttonPrimary, "#6db2ff", "#004295", "#ddedf9"],
  [PALETTE.surface, "#2d2d2d", "#0d0d0d", "#e0e0e0"],
])("uses the captured palette on %s", (background, edge, bottom, text) => {
  expect(buttonStyle(background, false)).toEqual({ edge, bottom, text });
});
it("dims disabled navigation and withdrawn retry differently", () => {
  expect(buttonStyle(PALETTE.surface, true)).toEqual({
    edge: "#252525",
    bottom: "#151515",
    text: "#6f6f6f",
  });
  expect(buttonStyle(PALETTE.buttonRetryDisabled, true)).toEqual({
    edge: "#1e1e1e",
    bottom: "#0f0f0f",
    text: "#6f6f6f",
  });
});
