import { expect, it, vi } from "vitest";
import { executeMareaCommand } from "./marea-command.boundary.js";
import {
  commandOptions,
  conversationSession,
  testConversationRuntime,
} from "./command-options.fixture.js";
it("uses --server over the environment URL for the connection and per-server state", async () => {
  const createApplication = vi.fn(() => Promise.reject(new Error("connection fixture")));
  const options = commandOptions({
    arguments: ["--server", "http://192.168.1.20:18787"],
    serverUrl: "https://old.test",
  });
  expect(
    await executeMareaCommand(options, {
      createApplication,
      ...testConversationRuntime(() => Promise.resolve(conversationSession())),
    }),
  ).toBe(1);
  expect(createApplication).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: "http://192.168.1.20:18787" }),
  );
  expect(options.serverUrl).toBe("https://old.test");
});
