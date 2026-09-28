import type { MouseEvent } from "@opentui/core";
import { expect, it, vi } from "vitest";
import { ReferenceButton } from "./reference-controls.js";
import { nodesOfType } from "../../../test-support/element-tree.boundary.js";
import { PALETTE } from "../../parity/tokens.js";

it.each([false, true])(
  "presses the native bevel only while an enabled button is held (disabled=%s)",
  (disabled) => {
    const onPress = vi.fn();
    const node = nodesOfType(
      ReferenceButton({
        label: "Retry",
        background: PALETTE.buttonPrimary,
        focused: false,
        disabled,
        onPress,
      }),
      "referenceBox",
    )[0];
    const target = { referencePressed: false, referencePointerOrigin: null };
    const mouse = { button: 0, x: 2, y: 3 } as MouseEvent;
    const down = node?.props.onMouseDown as (event: MouseEvent) => void;
    const up = node?.props.onMouseUp as (event: MouseEvent) => void;
    const ref = node?.props.ref as (
      value: { referencePressed: boolean; referencePointerOrigin: null } | null,
    ) => void;
    down(mouse);
    ref(target);
    down(mouse);
    expect(target.referencePressed).toBe(!disabled);
    expect(onPress).not.toHaveBeenCalled();
    up(mouse);
    expect(target.referencePressed).toBe(false);
    expect(onPress).toHaveBeenCalledTimes(disabled ? 0 : 1);
    ref(null);
    down(mouse);
    up(mouse);
  },
);

it("keeps a held press through a fresh React render of the same native button", () => {
  const onPress = vi.fn();
  const target = { referencePressed: false, referencePointerOrigin: null };
  const properties = { label: "Retry", background: PALETTE.buttonPrimary, focused: false, onPress };
  const first = nodesOfType(ReferenceButton(properties), "referenceBox")[0];
  const bind = (node: typeof first) => {
    (node?.props.ref as (value: typeof target) => void)(target);
  };
  bind(first);
  const mouse = { button: 0, x: 2, y: 3 } as MouseEvent;
  (first?.props.onMouseDown as (event: MouseEvent) => void)(mouse);
  const second = nodesOfType(ReferenceButton({ ...properties, focused: true }), "referenceBox")[0];
  expect(second?.props.referencePressed).toBe(false);
  bind(second);
  (second?.props.onMouseUp as (event: MouseEvent) => void)(mouse);
  expect(onPress).toHaveBeenCalledOnce();
  expect(target.referencePressed).toBe(false);
});
