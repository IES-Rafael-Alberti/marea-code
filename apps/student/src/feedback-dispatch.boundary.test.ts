import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createStudentStateDirectory,
  executeMareaCommand,
  type MareaCommandRuntime,
} from "./marea-command.boundary.js";

import { commandOptions } from "./command-options.fixture.js";
describe("feedback command dispatch", () => {
  it.each([null, "notice:one"])(
    "dispatches feedback %s with the same stored login and no conversation",
    async (noticeId) => {
      const options = commandOptions({
        arguments: noticeId === null ? ["feedback"] : ["feedback", "--ack", noticeId],
        serverUrl: "  https://teacher.example  ",
      });
      const feedback = vi.fn().mockResolvedValue(0);
      const runtime: MareaCommandRuntime = {
        createApplication: vi.fn(),
        nextAttemptId: vi.fn(),
        nextMessageId: vi.fn(),
        readGitContext: () => ({ branch: "", repositoryUrl: "" }),
        startConversation: vi.fn(),
      };
      expect(await executeMareaCommand(options, runtime, feedback)).toBe(0);
      expect(feedback).toHaveBeenCalledWith({
        projectRoot: resolve(options.currentDirectory),
        stateDirectory: createStudentStateDirectory(
          join(options.homeDirectory, ".marea"),
          "https://teacher.example",
          options.currentDirectory,
        ),
        serverUrl: "https://teacher.example",
        noticeId,
        translator: options.translator,
        output: options.output,
      });
      expect(runtime.createApplication).not.toHaveBeenCalled();
      expect(runtime.startConversation).not.toHaveBeenCalled();
      feedback.mockResolvedValueOnce(1);
      expect(await executeMareaCommand(options, runtime, feedback)).toBe(1);
    },
  );
});
