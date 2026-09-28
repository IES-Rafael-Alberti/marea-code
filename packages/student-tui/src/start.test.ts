import { describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  createEnvironment: vi.fn(),
  createView: vi.fn(),
}));

vi.mock("./platform/node-environment.boundary.js", () => ({
  createNodeEnvironment: doubles.createEnvironment,
}));
vi.mock("./platform/opentui-view.js", () => ({ createOpenTuiView: doubles.createView }));

import type { SignalSource, StudentTuiCopy, StudentTuiView } from "./contracts.js";
import { startStudentTui } from "./start.js";

const signals: SignalSource = {
  subscribe(): () => void {
    return () => undefined;
  },
};
const copy: StudentTuiCopy = {
  controls: "keys",
  emptyResponse: "empty",
  errors: { nonInteractive: "n", rendererFailed: "r", unexpected: "u" },
  statuses: { cancelled: "x", complete: "d", ready: "r", streaming: "s" },
  title: "title",
};

describe("startStudentTui", () => {
  it("does not load the renderer for a noninteractive terminal", async () => {
    doubles.createEnvironment.mockReturnValue({
      interactive: false,
      setExitCode: vi.fn(),
      signals,
    });

    await expect(startStudentTui(copy)).rejects.toMatchObject({ code: "NON_INTERACTIVE" });
    expect(doubles.createView).not.toHaveBeenCalled();
  });

  it("loads the OpenTUI adapter for an interactive terminal", async () => {
    const view: StudentTuiView = { dispose: vi.fn(), render: vi.fn() };
    doubles.createEnvironment.mockReturnValue({ interactive: true, setExitCode: vi.fn(), signals });
    doubles.createView.mockResolvedValue(view);

    const session = await startStudentTui(copy);
    session.close();

    await expect(session.outcome).resolves.toEqual({ exitCode: 0, reason: "closed" });
    expect(doubles.createView).toHaveBeenCalledOnce();
  });
});
