import { expect, it, vi } from "vitest";
import { createTranslator } from "@marea/i18n";

import { commandOptions, testConversationRuntime } from "./command-options.fixture.js";
import { executeMareaCommand } from "./marea-command.boundary.js";
import { StudentHttpError } from "./http-error.js";

it.each(["workspace", "local-state", "session", "interface"] as const)(
  "identifies the failing %s startup stage without exposing credentials",
  async (stage) => {
    const options = commandOptions({ translator: createTranslator("es") });
    const fail = () => Promise.reject(new Error("synthetic-secret"));
    const controller = {
      start: stage === "session" ? fail : () => Promise.resolve({}),
      pendingTurn: () => Promise.resolve(null),
      close: vi.fn(() => Promise.resolve()),
      sendMessage: vi.fn(),
    };
    const dispose = vi.fn();
    const code = await executeMareaCommand(options, {
      ensureWorkspace: stage === "workspace" ? fail : () => Promise.resolve(),
      createApplication:
        stage === "local-state" ? fail : () => Promise.resolve({ controller, dispose }),
      ...testConversationRuntime(fail),
    });
    expect(code).toBe(1);
    expect(options.errors.join("")).toContain(`${stage}/unexpected`);
    expect(options.errors.join("")).not.toContain("synthetic-secret");
  },
);

it("explains a rejected session before opening a terminal interface", async () => {
  const options = commandOptions({ translator: createTranslator("es") });
  const startConversation = vi.fn();
  const result = await executeMareaCommand(options, {
    createApplication: () =>
      Promise.resolve({
        controller: {
          start: () => Promise.reject(new StudentHttpError(409, "run.unavailable", false, true)),
          close: vi.fn(),
          sendMessage: vi.fn(),
          pendingTurn: vi.fn(),
        },
        dispose: vi.fn(),
      }),
    ...testConversationRuntime(startConversation),
  });
  expect(result).toBe(1);
  expect(startConversation).not.toHaveBeenCalled();
  expect(options.errors.join("")).toContain("Ajustes → Esta clase");
  expect(options.errors.join("")).toContain("session/class-configuration-required/HTTP-409");
});
