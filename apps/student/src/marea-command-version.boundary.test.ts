import { describe, expect, it, vi } from "vitest";

import type { ProductionStudentCompositionOptions } from "./composition.js";
import { executeMareaCommand, MAREA_CLIENT_VERSION } from "./marea-command.boundary.js";
import { commandOptions } from "./command-options.fixture.js";

describe("marea command version confirmation", () => {
  async function capturedGate(overrides: Parameters<typeof commandOptions>[0]) {
    const compositions: ProductionStudentCompositionOptions[] = [];
    const options = commandOptions(overrides);
    await executeMareaCommand(options, {
      createApplication(composition) {
        compositions.push(composition);
        return Promise.reject(new Error("Stop after composing."));
      },
      nextAttemptId: vi.fn(),
      nextMessageId: vi.fn(),
      readGitContext: () => ({ branch: "", repositoryUrl: "" }),
      startConversation: vi.fn(),
    });
    const gate = compositions[0]?.versionGate;
    if (gate === undefined) throw new Error("The version gate was not composed.");
    return gate;
  }

  it("asks the remembered acceptances about this server and both versions", async () => {
    const versionAcceptanceStore = {
      has: vi.fn(() => Promise.resolve(true)),
      remember: vi.fn(() => Promise.resolve()),
    };
    const gate = await capturedGate({
      serverUrl: "  https://teacher.example  ",
      versionAcceptanceStore,
    });
    await expect(gate("9.9.9", MAREA_CLIENT_VERSION)).resolves.toBeUndefined();
    expect(versionAcceptanceStore.has).toHaveBeenCalledExactlyOnceWith({
      serverUrl: "https://teacher.example",
      serverVersion: "9.9.9",
      clientVersion: MAREA_CLIENT_VERSION,
    });
  });

  it("refuses an unaccepted pair without a terminal, in the interface language", async () => {
    const gate = await capturedGate({});
    await expect(gate("9.9.9", MAREA_CLIENT_VERSION)).rejects.toThrow("9.9.9");
  });
});
