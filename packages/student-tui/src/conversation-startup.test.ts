import { describe, expect, it, vi } from "vitest";

import { createConversationController } from "./conversation-controller.js";

describe("internal startup terminal presentation", () => {
  it.each(["", "Saved introduction."])(
    "recovers startup with prefix %j without a student bubble",
    async (assistantText) => {
      const completed = Promise.withResolvers<undefined>();
      const onMessage = vi.fn(() => completed.promise);
      const controller = createConversationController({
        initialTurn: { kind: "startup", text: "", assistantText, messageId: "marea:tutor-startup" },
        nextAttemptId: () => "attempt:startup",
        onMessage,
        onExit: vi.fn(),
        view: { dispose: vi.fn(), render: vi.fn() },
      });
      expect(controller.snapshot().messages).toEqual(
        assistantText === "" ? [] : [{ author: "marea", text: assistantText }],
      );
      expect(controller.snapshot().status).toBe("streaming");
      expect(controller.resumeTurn()).toBe(true);
      expect(onMessage).toHaveBeenCalledWith(
        "",
        expect.any(AbortSignal),
        "marea:tutor-startup",
        "attempt:startup",
      );
      expect(
        controller.appendAssistantText(" Next.", "marea:tutor-startup", "attempt:startup"),
      ).toBe(true);
      expect(controller.complete("marea:tutor-startup", "attempt:startup")).toBe(true);
      completed.resolve(undefined);
      await completed.promise;
      expect(controller.snapshot().messages.every((message) => message.author === "marea")).toBe(
        true,
      );
      expect(controller.snapshot().messages.at(-1)?.text).toBe(`${assistantText} Next.`);
      controller.dispose();
    },
  );
});
