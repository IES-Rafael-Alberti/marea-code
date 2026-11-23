import { expect, it } from "vitest";
import { createBindableConversationPort } from "./marea-command.boundary.js";
import { conversationSession } from "./command-options.fixture.js";

it("forwards generic thinking through the bound conversation port", () => {
  const port = createBindableConversationPort();
  expect(() => port.thinking()).toThrow("The conversation interface is not ready.");
  const session = conversationSession();
  port.bind(session);
  expect(port.thinking("message", "attempt")).toBe(true);
  expect(session.thinking).toHaveBeenCalledExactlyOnceWith("message", "attempt");
});
