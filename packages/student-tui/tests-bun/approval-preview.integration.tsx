import { getTreeSitterClient } from "@opentui/core";
import { registerReferenceMarkdown } from "../src/platform/reference-markdown.boundary.js";
/** @jsxImportSource @opentui/react */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { registerReferenceBoxes } from "../src/platform/reference-box.boundary.js";
import { LiveParityScreen } from "../src/platform/parity/live-screen.js";
import { createPresentation } from "../src/parity/presentation.js";
import { PARITY_TEST_COPY as copy } from "../test-support/parity-copy.js";
registerReferenceBoxes();
registerReferenceMarkdown(getTreeSitterClient());

it("reviews the exact proposed contents before authorizing the real interrupt at 80 by 24", async () => {
  const { testRender } = await import("@opentui/react/test-utils");
  const onAction = vi.fn();
  const presentation = createPresentation(
    { cwd: "/project", branch: "", model: "", repositoryUrl: "" },
    copy,
    onAction,
  );
  presentation.sync({
    approval: {
      approvalId: "approval:preview",
      content: "Exact proposed contents\nSecond line",
      path: "notes.txt",
      summary: "Create notes",
    },
    messages: [],
    status: "approval",
  });
  const setup = await testRender(
    <LiveParityScreen copy={copy} presentation={presentation} onAction={onAction} />,
    { exitOnCtrlC: false, height: 24, kittyKeyboard: true, width: 80 },
  );
  try {
    await setup.flush();
    await act(async () => {
      setup.mockInput.pressTab({ shift: true });
      await setup.flush();
    });
    await act(async () => {
      setup.mockInput.pressKey("\r");
      await setup.flush();
    });
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Exact proposed contents");
    expect(frame).toContain("Second line");
    expect(frame).toContain(copy.approval.approve);
    expect(frame).toContain(copy.approval.reject);
    expect(onAction).not.toHaveBeenCalled();
    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    expect(onAction.mock.calls).toEqual([[{ type: "approve", interruptId: "approval:preview" }]]);
  } finally {
    setup.renderer.destroy();
  }
});
