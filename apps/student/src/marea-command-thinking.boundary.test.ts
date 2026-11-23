import { expect, it, vi } from "vitest";
import { createTranslator } from "@marea/i18n";
import { createBindableConversationPort, executeMareaCommand } from "./marea-command.boundary.js";
import { conversationSession, commandOptions } from "./command-options.fixture.js";

it("forwards generic thinking through the bound conversation port", () => {
  const port = createBindableConversationPort();
  expect(() => port.thinking()).toThrow("The conversation interface is not ready.");
  const session = conversationSession();
  port.bind(session);
  expect(port.thinking("message", "attempt")).toBe(true);
  expect(session.thinking).toHaveBeenCalledExactlyOnceWith("message", "attempt");
});

it("returns a localized safe error without leaking an internal failure", async () => {
  const options = commandOptions({ translator: createTranslator("es") });

  await expect(
    executeMareaCommand(options, {
      createApplication: () => Promise.reject(new Error("secret provider key")),
      nextAttemptId: vi.fn(),
      nextMessageId: vi.fn(),
      readGitContext: () => ({ branch: "", repositoryUrl: "" }),
      startConversation: vi.fn(),
    }),
  ).resolves.toBe(1);
  expect(options.errors).toEqual([
    "Marea no ha podido iniciarse. Inténtalo de nuevo.\nCódigo de diagnóstico: local-state/unexpected. Inclúyelo al comunicar el problema.\n",
  ]);
  expect(options.errors.join("")).not.toContain("secret provider key");
});
