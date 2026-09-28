import { createTranslator } from "@marea/i18n";
import type { ConversationTuiOptions, ConversationTuiSession } from "@marea/student-tui";
import { vi } from "vitest";
import type { MareaCommandOptions, MareaCommandRuntime } from "./marea-command.boundary.js";

export function commandOptions(
  overrides: Partial<MareaCommandOptions> = {},
): MareaCommandOptions & { readonly errors: string[]; readonly writes: string[] } {
  const errors: string[] = [];
  const writes: string[] = [];
  return {
    arguments: [],
    currentDirectory: "/courses/physics/project-one",
    errors,
    homeDirectory: "/home/student",
    output: {
      error: (text) => errors.push(text),
      write: (text) => writes.push(text),
    },
    serverUrl: "https://teacher.example",
    stateRoot: undefined,
    translator: createTranslator("en"),
    writes,
    ...overrides,
  };
}

export function conversationSession(
  outcome = Promise.resolve({ exitCode: 0, reason: "closed" as const }),
) {
  return {
    appendAssistantText: vi.fn(() => true),
    cancel: vi.fn(() => true),
    close: vi.fn(() => true),
    complete: vi.fn(() => true),
    fail: vi.fn(() => true),
    outcome,
    requestApproval: vi.fn(() => Promise.resolve("approved" as const)),
    resumeTurn: vi.fn(() => true),
    snapshot: vi.fn(() => ({ approval: null, messages: [], status: "ready" as const })),
    thinking: vi.fn(() => true),
    toolFinished: vi.fn(() => true),
    toolStarted: vi.fn(() => true),
  } satisfies ConversationTuiSession;
}

type TestConversationRuntime = Pick<
  MareaCommandRuntime,
  "nextAttemptId" | "nextMessageId" | "readGitContext" | "startConversation"
>;

/** The shared conversation runtime tail for command orchestration tests. */
export function testConversationRuntime(
  startConversation: (options: ConversationTuiOptions) => Promise<ConversationTuiSession>,
): TestConversationRuntime {
  return {
    nextAttemptId: () => "attempt:new",
    nextMessageId: () => "attempt:new",
    readGitContext: () => ({ branch: "", repositoryUrl: "" }),
    startConversation,
  };
}
