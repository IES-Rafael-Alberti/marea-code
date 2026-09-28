import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenRunRequestSchema, RequestIdSchema } from "../../packages/protocol/src/index.js";
import { openGuardedWorkspace } from "../../packages/workspace-backend/src/index.js";
import { describe, expect, it } from "vitest";

import { createDeepAgentsStudentRuntime } from "../../apps/student/src/deepagents-runtime.boundary.js";
import { createHttpStudentServer } from "../../apps/student/src/http-client.boundary.js";
import { RunSkillReader } from "../../apps/student/src/run-skill-reader.js";
import { createRuntimeReadTools } from "../../apps/student/src/runtime-read-tools.js";
import {
  createApplication,
  createServices,
  RecordingProvider,
} from "../../apps/teacher-server/src/product-http/product-http.fixture.js";
import {
  BundledSkillSource,
  CompositeSkillSource,
  DirectorySkillSource,
} from "../../apps/teacher-server/src/teaching/skills/index.js";
import { NodeSqliteTestDatabase } from "../../apps/teacher-server/test-support/node-sqlite-database.boundary.js";
import {
  teachingInput,
  teachingSkill,
} from "../../apps/teacher-server/test-support/teaching-fixture.js";
import {
  newRun,
  seedTeachingDatabase,
  servicesFor,
  student,
  teacher,
  writeCatalog,
} from "../../apps/teacher-server/test-support/teaching-integration.fixture.js";
import {
  AIMessage,
  MareaFakeModel,
  ToolMessage,
} from "../../packages/deepagents-adapter/src/adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "../../packages/deepagents-adapter/src/checkpoint.boundary.js";
import { bindTestModel } from "../../packages/deepagents-adapter/src/upstream.boundary.js";

describe("teaching content through the actual runtime", () => {
  it.each(["tutoring", "free"] as const)(
    "uses frozen %s configuration with controlled project access",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "marea-startup-runtime-"));
      let database = new NodeSqliteTestDatabase(join(root, "teacher.sqlite"));
      try {
        seedTeachingDatabase(database);
        const teacherRoot = join(root, "teacher-skills");
        const coreRoot = join(root, "core-skills");
        await writeCatalog(teacherRoot, teachingSkill("didactic"));
        await writeCatalog(coreRoot, teachingSkill("evaluation"));
        const source = new CompositeSkillSource([
          new DirectorySkillSource(teacherRoot, { source: "teacher", id: "t1" }),
          new BundledSkillSource(coreRoot),
        ]);
        let services = servicesFor(database, source);
        await services.teaching.save(teacher, teachingInput(mode));
        const opened = services.runs.open(student, newRun("runtime"));
        expect(opened.snapshot.agentMode).toBe(mode);
        // Both catalogs disappear before the student reads anything.
        await rm(teacherRoot, { recursive: true });
        await rm(coreRoot, { recursive: true });
        database.close();
        database = new NodeSqliteTestDatabase(join(root, "teacher.sqlite"));
        services = servicesFor(database, source);
        const resumed = services.runs.open(
          student,
          OpenRunRequestSchema.parse({
            ...newRun("resume-runtime"),
            runId: opened.lease.runId,
            intent: { kind: "resume" },
          }),
        );
        expect(resumed.snapshot).toEqual(opened.snapshot);
        const application = createApplication({
          ...createServices(new RecordingProvider()),
          runs: services.runs,
          skills: services.skills,
        });
        const traffic: string[] = [];
        const server = createHttpStudentServer({
          baseUrl: "https://teacher.test",
          fetch: async (request) => {
            traffic.push(await request.clone().text());
            const headers = new Headers(request.headers);
            headers.set("host", "teacher.test");
            const response = await application.fetch(new Request(request, { headers }));
            traffic.push(await response.clone().text());
            return response;
          },
        });
        const project = join(root, "project");
        await mkdir(project);
        await writeFile(join(project, "exercise.txt"), "Project exercise input.\n");
        const workspace = await openGuardedWorkspace({ rootPath: project });
        const calls = [
          { name: "marea_list_project", id: "tool:list", args: { path: "/" } },
          { name: "marea_read_project", id: "tool:read", args: { path: "/exercise.txt" } },
        ];
        const model = new MareaFakeModel()
          .respondWithTools(
            mode === "free"
              ? calls
              : [
                  ...calls,
                  {
                    name: "marea_read_skill",
                    id: "tool:skill",
                    args: { skillId: "teacher/t1/testing", path: "resources/guide.txt" },
                  },
                ],
          )
          .respond(new AIMessage("Proposed exercise."));
        const runtime = createDeepAgentsStudentRuntime({
          checkpoint: createInMemoryCheckpointForTest(),
          model: bindTestModel(model),
          readOnlyTools: (runId, snapshot) =>
            createRuntimeReadTools({
              snapshot,
              workspace,
              skills: new RunSkillReader({
                runId,
                snapshot,
                server,
                nextRequestId: () => RequestIdSchema.parse("request:runtime-skill"),
                runToken: () => Promise.resolve(resumed.lease.token),
              }),
            }),
        });
        const events = [];
        for await (const event of runtime.streamMessage(
          {
            runId: resumed.lease.runId,
            snapshot: resumed.snapshot,
            messageId: "message:runtime",
            text: "Inspect the project.",
          },
          new AbortController().signal,
        ))
          events.push(event);
        expect(events.at(-1)).toEqual({ type: "turn-completed" });
        expect(events.some((event) => event.type === "write-approval-required")).toBe(false);
        const outputs = model.calls[1]?.messages
          .filter((message) => ToolMessage.isInstance(message))
          .map((message) => message.content);
        expect(outputs).toContain(
          JSON.stringify({
            content: "Project exercise input.\n",
            offset: 0,
            nextOffset: null,
            totalLength: "Project exercise input.\n".length,
          }),
        );
        expect(JSON.stringify(outputs)).toContain("/exercise.txt");
        if (mode === "tutoring") {
          expect(outputs).toContain(
            JSON.stringify({
              content: "Frozen didactic resource.\n",
              offset: 0,
              nextOffset: null,
              totalLength: "Frozen didactic resource.\n".length,
            }),
          );
          expect(traffic).toHaveLength(2);
        } else {
          expect(model.boundToolNames.flat()).not.toContain("marea_read_skill");
          expect(traffic).toEqual([]);
          expect(resumed.snapshot.didacticSkills).toEqual([]);
        }
        const allStudentData = JSON.stringify({ traffic, outputs, snapshot: resumed.snapshot });
        expect(allStudentData).not.toContain("Frozen evaluation resource.");
        expect(allStudentData).not.toContain("synthetic-provider");
        expect(allStudentData).not.toContain("synthetic-model");
        expect(await readFile(join(project, "exercise.txt"), "utf8")).toBe(
          "Project exercise input.\n",
        );
      } finally {
        database.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
