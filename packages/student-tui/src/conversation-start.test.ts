import { PARITY_TEST_COPY } from "../test-support/parity-copy.js";
import { describe, expect, it, vi } from "vitest";

const createConversationEnvironment = vi.hoisted(() => vi.fn());
const createNativeConversationView = vi.hoisted(() => vi.fn());

vi.mock("./platform/node-environment.boundary.js", () => ({
  createNodeEnvironment: createConversationEnvironment,
}));
vi.mock("./platform/conversation-view.js", () => ({
  createConversationView: createNativeConversationView,
}));

import type { SignalSource } from "./contracts.js";
import type { ConversationCopy, ConversationView } from "./conversation-contracts.js";
import { startConversationTui } from "./conversation-start.js";

const copy: ConversationCopy = {
  parity: {
    copy: PARITY_TEST_COPY,
    context: { cwd: "", branch: "", model: "", repositoryUrl: "" },
  },
};
const signals: SignalSource = { subscribe: () => () => undefined };

describe("startConversationTui", () => {
  it("keeps OpenTUI unloaded for a noninteractive terminal", async () => {
    createConversationEnvironment.mockReturnValue({
      interactive: false,
      setExitCode: vi.fn(),
      signals,
    });

    await expect(
      startConversationTui({ copy, onMessage: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: "NON_INTERACTIVE" });
    expect(createNativeConversationView).not.toHaveBeenCalled();
  });

  it("loads and closes the native conversation view lazily", async () => {
    const target: ConversationView = { dispose: vi.fn(), render: vi.fn() };
    createConversationEnvironment.mockReturnValue({
      interactive: true,
      setExitCode: vi.fn(),
      signals,
    });
    createNativeConversationView.mockResolvedValue(target);

    const onLanguageCommand = vi.fn(() => null);

    const session = await startConversationTui({
      copy,
      onMessage: () => Promise.resolve(),
      onLanguageCommand,
    });
    session.close();

    await expect(session.outcome).resolves.toEqual({ exitCode: 0, reason: "closed" });
    expect(createNativeConversationView).toHaveBeenCalledExactlyOnceWith(
      copy,
      expect.any(Function),
      undefined,
      onLanguageCommand,
    );
  });
});
