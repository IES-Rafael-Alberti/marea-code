import { createHash } from "node:crypto";
import {
  RunSkillResponseSchema,
  RunTokenSchema,
  SkillIdSchema,
  Sha256DigestSchema,
} from "@marea/protocol";
import type { StudentServer } from "./contracts.js";
import * as http from "./http-client.boundary.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createProductionStudentApplication } from "./composition.js";
import * as bridge from "./deepagents-runtime.boundary.js";
import { runId, snapshot } from "./deepagents-runtime.fixture.js";
import { StartupFixtureAgent } from "./startup.fixture.js";
import { FixtureInterface, FixtureServer } from "./student.fixture.js";
import { readToolPage } from "./read-tool-page.js";

describe("production runtime read-tool wiring", () => {
  it("binds read tools to the guarded project and selected immutable snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-read-composition-"));
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "exercise.txt"), "Synthetic exercise");
    const server: StudentServer = new FixtureServer();
    const httpFactory = vi.spyOn(http, "createHttpStudentServer").mockReturnValue(server);
    let configured: bridge.DeepAgentsStudentRuntimeOptions | undefined;
    const factory = vi
      .spyOn(bridge, "createDeepAgentsStudentRuntime")
      .mockImplementation((options) => {
        configured = options;
        const agent = new StartupFixtureAgent();
        return Object.assign(agent, { resumeQuestions: agent.streamStartup.bind(agent) });
      });
    try {
      const application = await createProductionStudentApplication({
        clientVersion: "1.0.0",
        projectRoot,
        serverUrl: "https://teacher.example",
        stateDirectory: join(root, "state"),
        studentInterface: new FixtureInterface(),
      });
      try {
        expect(configured?.projectContext?.(snapshot())).toContain("/exercise.txt");
        expect(
          configured?.projectContext?.({
            ...snapshot(),
            teacherToolPolicy: {
              ...snapshot().teacherToolPolicy,
              restrictions: [{ tool: "list_directory", effect: "deny" }],
            },
          }),
        ).toBe("");
        const content = "Mandatory complete instructions.";
        const id = SkillIdSchema.parse("teacher/ana/example");
        const digest = Sha256DigestSchema.parse(
          `sha256:${createHash("sha256").update(`SKILL.md\0${content}\0`).digest("hex")}`,
        );
        const selected = { ...snapshot(), didacticSkills: [{ id, digest }] };
        let delivered = content;
        vi.spyOn(application.controller, "modelRunToken").mockResolvedValue(
          RunTokenSchema.parse("r".repeat(32)),
        );
        const read = vi.spyOn(server, "readSkill").mockImplementation((_token, request) =>
          Promise.resolve(
            RunSkillResponseSchema.parse({
              protocolVersion: request.protocolVersion,
              requestId: request.requestId,
              runId: request.runId,
              snapshotId: request.snapshotId,
              skill: {
                id,
                digest,
                name: "example",
                description: "Didactic example",
                kind: "didactic",
                source: "teacher",
                license: null,
                compatibility: null,
                criteria: [],
                files: [
                  {
                    path: "SKILL.md",
                    content: delivered,
                    sizeBytes: new TextEncoder().encode(delivered).byteLength,
                  },
                ],
              },
            }),
          ),
        );
        const load = configured?.loadSkills;
        if (load === undefined) throw new Error("Missing mandatory skill loader");
        expect(await load(runId, selected, new AbortController().signal)).toContain(content);
        expect(read).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ skillId: id, snapshotId: selected.id }),
        );
        delivered = "Substituted instructions";
        await expect(load(runId, selected, new AbortController().signal)).rejects.toThrow();
        const readers = configured?.readOnlyTools;
        if (readers === undefined) throw new Error("The production runtime omitted read tools.");
        const tools = readers(runId, snapshot());
        expect(tools.map((tool) => tool.name)).toEqual([
          "marea_read_project",
          "marea_list_project",
          "marea_read_skill",
          "marea_search_project",
          "marea_glob_project",
        ]);
        await expect(tools[0]?.execute({ path: "/exercise.txt" })).resolves.toBe(
          readToolPage("Synthetic exercise", 0),
        );
        await expect(tools[0]?.execute({ path: "/../private.txt" })).rejects.toThrow();
        expect(
          readers(runId, { ...snapshot(), agentMode: "free" }).map((tool) => tool.name),
        ).toEqual([
          "marea_read_project",
          "marea_list_project",
          "marea_search_project",
          "marea_glob_project",
        ]);
      } finally {
        application.dispose();
      }
    } finally {
      factory.mockRestore();
      httpFactory.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
