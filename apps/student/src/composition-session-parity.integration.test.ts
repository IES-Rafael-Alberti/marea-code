import { snapshot } from "./student-snapshot.fixture.js";
import { StartupFixtureAgent } from "./startup.fixture.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ApprovalIdSchema } from "@marea/protocol";
import * as http from "./http-client.boundary.js";
import * as runtime from "./deepagents-runtime.boundary.js";
import { FixtureServer, FixtureInterface } from "./student.fixture.js";
import { createProductionStudentApplication } from "./composition.js";
import { projectGit } from "./git-workspace.boundary.js";
import type { AgentEvent } from "./contracts.js";
import type { OperationTurn } from "./operation-contracts.js";
class Agent extends StartupFixtureAgent {
  override async *streamMessage(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield { type: "assistant-text-delta", text: "Reviewing" };
    yield {
      type: "operation-approval-required",
      approvalId: ApprovalIdSchema.parse("approval:composed"),
      tool: "edit_file",
      arguments: { path: "main.ts", old_string: "before", new_string: "after" },
      summary: "Edit exact text",
    };
  }
  async *resumeOperation(turn: OperationTurn): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    expect(turn.result).toContain("updated");
    yield { type: "assistant-text-delta", text: " done" };
    yield { type: "turn-completed" };
  }
  async *resumeQuestions(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield { type: "turn-completed" };
  }
}
it("composes real Git evidence, reviewed filesystem effects and live delivery in the installed client", async () => {
  const root = await mkdtemp(join(tmpdir(), "marea-composed-project-"));
  const state = await mkdtemp(join(tmpdir(), "marea-composed-state-"));
  const server = new FixtureServer();
  const connection = vi.spyOn(http, "createHttpStudentServer").mockReturnValue(server);
  const factory = vi
    .spyOn(runtime, "createDeepAgentsStudentRuntime")
    .mockImplementation((options) => {
      expect(options.operations).toBe(true);
      expect(
        options.projectContext?.({
          ...snapshot,
          teacherToolPolicy: { version: "tools:open", restrictions: [] },
        }),
      ).toContain("Initial project context");
      expect(
        options.projectContext?.({
          ...snapshot,
          teacherToolPolicy: {
            version: "tools:mixed",
            restrictions: [
              { tool: "list_directory", effect: "deny" },
              { tool: "write_file", effect: "require-approval" },
            ],
          },
        }),
      ).toBe("");
      return new Agent();
    });
  try {
    await projectGit(root, ["init"]);
    await writeFile(join(root, "main.ts"), "before\n");
    const app = await createProductionStudentApplication({
      clientVersion: "1.0.0",
      projectRoot: root,
      stateDirectory: state,
      serverUrl: "https://synthetic.invalid",
      studentInterface: new FixtureInterface(),
    });
    try {
      await app.controller.start("Composed parity");
      await app.controller.sendMessage("message:composed", "Edit", new AbortController().signal);
      expect(await readFile(join(root, "main.ts"), "utf8")).toBe("after\n");
      const events = [...server.events.values()];
      expect(events).toContainEqual(
        expect.objectContaining({ eventType: "project-context", cwd: root }),
      );
      const change = events.find((event) => event.eventType === "project-change");
      expect(change).toMatchObject({ actor: "agent" });
      expect(change?.patch).toContain("+after");
      expect(events).toContainEqual(
        expect.objectContaining({ eventType: "assistant-progress", content: "Reviewing" }),
      );
      expect(events.at(-1)).toMatchObject({ eventType: "turn-ended", state: "completed" });
    } finally {
      app.dispose();
    }
  } finally {
    factory.mockRestore();
    connection.mockRestore();
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
