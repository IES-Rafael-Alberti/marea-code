import { createConversationController, type ConversationTuiOptions } from "@marea/student-tui";
import { expect, it, vi } from "vitest";

import { commandOptions, testConversationRuntime } from "./command-options.fixture.js";
import type { StudentUsagePreferenceStore } from "./interface-locale.boundary.js";
import { executeMareaCommand } from "./marea-command.boundary.js";

async function usagePreference(store?: StudentUsagePreferenceStore) {
  const started: ConversationTuiOptions[] = [];
  const controller = createConversationController({
    onExit: vi.fn(),
    onMessage: () => Promise.resolve(),
    view: { dispose: vi.fn(), render: vi.fn() },
  });
  const runtime = {
    ...testConversationRuntime((options) => {
      started.push(options);
      return Promise.resolve({
        ...controller,
        withTerminalSuspended: <T>(operation: () => Promise<T>) => operation(),
        close: () => controller.dispose(),
        outcome: Promise.resolve({ exitCode: 0, reason: "closed" as const }),
      });
    }),
    createApplication: () =>
      Promise.resolve({
        controller: {
          pendingTurn: () => Promise.resolve(null),
          start: () => Promise.resolve({}),
          close: () => Promise.resolve(),
          sendMessage: () => Promise.resolve(),
        },
        dispose: vi.fn(),
      }),
  };
  await executeMareaCommand(
    commandOptions(store === undefined ? {} : { usagePreferenceStore: store }),
    runtime,
  );
  controller.dispose();
  return started[0]?.copy.parity.usage;
}

it("starts the usage line as the student left it and saves each change", async () => {
  const save = vi.fn(() => Promise.reject(new Error("read-only disk")));
  const usage = await usagePreference({ load: () => Promise.resolve(true), save });
  expect(usage?.visible).toBe(true);
  usage?.onVisibilityChange?.(false);
  expect(save).toHaveBeenCalledExactlyOnceWith(false);
});

it("keeps the usage line hidden without a saved preference", async () => {
  const usage = await usagePreference();
  expect(usage?.visible).toBe(false);
  expect(() => usage?.onVisibilityChange?.(true)).not.toThrow();
});
