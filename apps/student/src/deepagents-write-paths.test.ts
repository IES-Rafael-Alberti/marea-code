import { expect, it } from "vitest";
import {
  approval,
  approvalRequired,
  collect,
  effect,
  harness,
  message,
} from "./deepagents-runtime.fixture.js";

it.each([
  ["notes.txt", "notes.txt"],
  ["/notes.txt", "notes.txt"],
  ["./notes.txt", "notes.txt"],
  ["a/notes.txt", "a/notes.txt"],
  ["/a/notes.txt", "a/notes.txt"],
  ["./a/notes.txt", "a/notes.txt"],
  ["/.gitignore", ".gitignore"],
  ["/lección-1/main.py", "lección-1/main.py"],
])("normalizes %s before review, recovery and authorized execution", async (path, expected) => {
  const { deep, runtime } = harness();
  deep.messages = [approvalRequired({ arguments: { path, content: "content" } })];
  deep.toolArguments = { path, content: "content" };
  const events = await collect(runtime.streamMessage(message(), new AbortController().signal));
  expect(events).toEqual([
    expect.objectContaining({ type: "write-approval-required", path: expected }),
  ]);
  const result = { ...effect, path: expected };
  await expect(
    collect(
      runtime.resumeApproval(
        { ...approval("approved", result), path: expected },
        new AbortController().signal,
      ),
    ),
  ).resolves.toEqual([{ type: "turn-completed" }]);
  expect(JSON.parse(deep.toolResult ?? "null")).toEqual(result);
});

it.each([
  "/",
  "./",
  "//notes.txt",
  "../notes.txt",
  "/../notes.txt",
  "./../notes.txt",
  "a/../notes.txt",
  "a/./notes.txt",
  "a//notes.txt",
  "a\\notes.txt",
  "C:/notes.txt",
  "notes.txt\n",
  "a".repeat(513),
])("rejects an invalid write path before it reaches the local event journal: %s", async (path) => {
  const { deep, runtime } = harness();
  deep.messages = [approvalRequired({ arguments: { path, content: "content" } })];
  await expect(
    collect(runtime.streamMessage(message(), new AbortController().signal)),
  ).rejects.toThrow("DeepAgents returned invalid write_file arguments.");
  expect(deep.resumes).toHaveLength(0);
});
