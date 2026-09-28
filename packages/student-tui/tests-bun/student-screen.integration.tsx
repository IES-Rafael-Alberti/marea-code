import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudentTuiSnapshot } from "../src/contracts.js";
import { StudentScreen } from "../src/platform/student-screen.js";
import { TEST_COPY } from "../test-support/copy.js";

const renderers: { destroy(): void }[] = [];

afterEach(() => {
  for (const renderer of renderers) renderer.destroy();
  renderers.length = 0;
});

describe("OpenTUI React integration", () => {
  it("renders streamed state with the official test renderer", async () => {
    const { testRender } = await import("@opentui/react/test-utils");
    let update: (snapshot: StudentTuiSnapshot) => void = () => undefined;
    function Harness() {
      const [snapshot, setSnapshot] = useState<StudentTuiSnapshot>({
        response: "",
        status: "ready",
      });
      update = setSnapshot;
      return <StudentScreen copy={TEST_COPY} onIntent={vi.fn()} snapshot={snapshot} />;
    }
    const setup = await testRender(<Harness />, {
      exitOnCtrlC: false,
      height: 8,
      kittyKeyboard: true,
      width: 50,
    });
    renderers.push(setup.renderer);
    await setup.flush();

    expect(setup.captureCharFrame()).toContain("No streamed text");
    act(() => {
      update({ response: "Streamed answer", status: "streaming" });
    });
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Live");
    expect(frame).toContain("Streamed answer");
  });

  it("delivers quit, cancel, and raw Ctrl+C keyboard intents", async () => {
    const { testRender } = await import("@opentui/react/test-utils");
    const onIntent = vi.fn();
    const setup = await testRender(
      <StudentScreen
        copy={TEST_COPY}
        onIntent={onIntent}
        snapshot={{ response: "done", status: "complete" }}
      />,
      { exitOnCtrlC: false, height: 8, kittyKeyboard: true, width: 50 },
    );
    renderers.push(setup.renderer);

    act(() => {
      setup.mockInput.pressKey("x");
    });
    await setup.flush();
    act(() => {
      setup.mockInput.pressKey("q");
    });
    await setup.flush();
    act(() => {
      setup.mockInput.pressEscape();
    });
    await setup.flush();
    act(() => {
      setup.mockInput.pressCtrlC();
    });
    await setup.flush();

    expect(setup.captureCharFrame()).toContain("Finished");
    expect(onIntent.mock.calls).toEqual([["quit"], ["cancel"], ["interrupt"]]);
  });
});
