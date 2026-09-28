/** @jsxImportSource @opentui/react */
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { expect, it, vi } from "vitest";
import { registerReferenceBoxes } from "../src/platform/reference-box.boundary.js";
import { ReferenceButton } from "../src/platform/parity/reference-controls.js";
import { PALETTE } from "../src/parity/tokens.js";
registerReferenceBoxes();
it("paints a depressed button on mouse down, restores it on release and preserves its position", async () => {
  const onPress = vi.fn();
  let refresh!: () => void;
  function Screen() {
    const [version, update] = useState(0);
    refresh = () => {
      update((value) => value + 1);
    };
    return (
      <ReferenceButton
        label="Retry"
        background={PALETTE.buttonPrimary}
        focused={version === 1}
        onPress={onPress}
      />
    );
  }
  const setup = await testRender(<Screen />, { width: 40, height: 8 });
  try {
    await act(async () => {
      await setup.flush();
    });
    const before = setup.captureCharFrame();
    expect(before.split("\n")[0]).toContain("▔".repeat(16));
    await act(async () => {
      await setup.mockMouse.pressDown(4, 1);
      await setup.flush();
    });
    const held = setup.captureCharFrame();
    expect(held.split("\n")[0]).toContain("▁".repeat(16));
    expect(held.split("\n")[1]).toEqual(before.split("\n")[1]);
    expect(onPress).not.toHaveBeenCalled();
    await act(async () => {
      refresh();
      await setup.flush();
    });
    expect(setup.captureCharFrame()).toBe(held);
    await act(async () => {
      await setup.mockMouse.release(4, 1);
      await setup.flush();
    });
    expect(setup.captureCharFrame()).toBe(before);
    expect(onPress).toHaveBeenCalledOnce();
    await act(async () => {
      await setup.mockMouse.drag(4, 1, 30, 5);
      await setup.flush();
    });
    expect(setup.captureCharFrame()).toBe(before);
    expect(onPress).toHaveBeenCalledOnce();
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
