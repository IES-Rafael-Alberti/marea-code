import type { ConversationTuiOptions } from "@marea/student-tui";
import { describe, expect, it, vi } from "vitest";

import type { MareaCommandRuntime } from "./marea-command.boundary.js";
import { executeMareaCommand } from "./marea-command.boundary.js";
import {
  commandOptions,
  conversationSession,
  testConversationRuntime,
} from "./command-options.fixture.js";

describe("student TUI language command", () => {
  it("changes copy in place, cycles every locale, and reports persistence failure", async () => {
    const exit = Promise.withResolvers<{ readonly exitCode: 0; readonly reason: "closed" }>();
    const session = conversationSession(exit.promise);
    let startedOptions: ConversationTuiOptions | undefined;
    const save = vi.fn().mockRejectedValueOnce(new Error("settings unavailable"));
    const runtime: MareaCommandRuntime = {
      createApplication: () =>
        Promise.resolve({
          controller: {
            close: vi.fn(() => Promise.resolve()),
            pendingTurn: vi.fn(() => Promise.resolve(null)),
            sendMessage: vi.fn(() => Promise.resolve()),
            start: vi.fn(() => Promise.resolve({})),
          },
          dispose: vi.fn(),
        }),
      ...testConversationRuntime((options) => {
        startedOptions = options;
        return Promise.resolve(session);
      }),
    };
    const execution = executeMareaCommand(
      commandOptions({
        languagePreference: "automatic",
        automaticLocale: "es",
        languagePreferenceStore: { load: vi.fn(), save },
      }),
      runtime,
    );
    await vi.waitFor(() => {
      expect(startedOptions).toBeDefined();
    });
    if (startedOptions?.onLanguageCommand === undefined)
      throw new Error("Missing language command");

    const first = await startedOptions.onLanguageCommand(startedOptions.copy);
    expect(first?.copy.parity.copy.commands.language).toBe("cambiar el idioma de la interfaz");
    expect(first?.notice).toContain("no se ha podido guardar");
    const second = await startedOptions.onLanguageCommand(first?.copy ?? startedOptions.copy);
    expect(second?.copy.parity.copy.commands.language).toBe("change the interface language");
    expect(second?.notice).toBe("Interface language: English");
    const third = await startedOptions.onLanguageCommand(second?.copy ?? startedOptions.copy);
    expect(third?.copy.parity.copy.commands.language).toBe("aldatu interfazearen hizkuntza");
    const fourth = await startedOptions.onLanguageCommand(third?.copy ?? startedOptions.copy);
    expect(fourth?.copy.parity.copy.commands.language).toBe("cambiar el idioma de la interfaz");
    expect(save).toHaveBeenNthCalledWith(1, "es");
    expect(save).toHaveBeenNthCalledWith(2, "en");
    expect(save).toHaveBeenNthCalledWith(3, "eu");
    expect(save).toHaveBeenNthCalledWith(4, "automatic");
    exit.resolve({ exitCode: 0, reason: "closed" });
    await expect(execution).resolves.toBe(0);
  });
});
