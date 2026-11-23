import { vi } from "vitest";
import * as z from "zod";
import {
  SkillAuthoringSaveRequestSchema,
  SkillBundleSchema,
  SkillWorkspaceRequestSchema,
  SaveTeachingConfigurationRequestSchema,
  type SkillWorkspaceStudent,
} from "@marea/protocol";
import { teachingReadFixture } from "../teaching/teaching.fixture.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { SkillWorkspaceController } from "./controller.js";

export function workspaceFixture() {
  const main =
    "---\nname: testing\ndescription: Practice unit testing\nmetadata:\n  title: Unit testing\n---\nAsk the learner to write one test.\n";
  let bundle = SkillBundleSchema.parse({
    id: "teacher/t1/testing",
    name: "testing",
    description: "Practice unit testing",
    kind: "didactic",
    source: "teacher",
    digest: `sha256:${"a".repeat(64)}`,
    license: null,
    compatibility: null,
    criteria: [],
    files: [{ path: "SKILL.md", content: main, sizeBytes: new TextEncoder().encode(main).length }],
  });
  let configuration = teachingReadFixture.configuration;
  let students: SkillWorkspaceStudent[] = [
    { studentId: "s1", displayName: "Ana", version: null, selection: null },
    { studentId: "s2", displayName: "Pablo", version: null, selection: null },
  ];
  const uses = [{ classId: "class:one", displayName: "Physics", classroom: true, students: 1 }];
  const failures = new Map<string, number>();
  const respond: DashboardFetch = (_path, init) => Promise.resolve(response(init.body));
  const request = vi.fn<DashboardFetch>(respond);
  function response(raw: RequestInit["body"]): Response {
    const body = z
      .looseObject({ kind: z.string(), requestId: z.string(), classId: z.string() })
      .parse(JSON.parse(typeof raw === "string" ? raw : ""));
    const status = failures.get(body.kind);
    if (status !== undefined) return new Response("failed", { status });
    const envelope = { protocolVersion: "0.1", requestId: body.requestId, classId: body.classId };
    switch (body.kind) {
      case "teaching-configuration-query":
        return Response.json({ ...teachingReadFixture, ...envelope, configuration });
      case "teaching-configuration-save": {
        const input = SaveTeachingConfigurationRequestSchema.parse(body);
        configuration = { version: "revision:saved", settings: input.settings };
        return Response.json({ ...envelope, kind: "teaching-configuration-saved", configuration });
      }
      case "skill-authoring-read":
        return Response.json({
          ...envelope,
          kind: "skill-authoring-read-result",
          editable: true,
          skill: bundle,
        });
      case "skill-authoring-save": {
        const input = SkillAuthoringSaveRequestSchema.parse(body);
        bundle = SkillBundleSchema.parse({
          ...bundle,
          id: `teacher/t1/${input.draft.slug}`,
          name: input.draft.slug,
          digest: `sha256:${"b".repeat(64)}`,
          files: input.draft.files.map((file) => ({
            ...file,
            sizeBytes: new TextEncoder().encode(file.content).length,
          })),
        });
        return Response.json({ ...envelope, kind: "skill-authoring-saved", skill: bundle });
      }
      default: {
        const input = SkillWorkspaceRequestSchema.parse(body);
        switch (input.kind) {
          case "library":
            return Response.json({
              ...envelope,
              kind: "library",
              skills: [
                {
                  id: bundle.id,
                  name: bundle.name,
                  description: bundle.description,
                  digest: bundle.digest,
                  kind: bundle.kind,
                  source: bundle.source,
                  compatibility: null,
                  title: "Unit testing",
                },
              ],
              next: null,
            });
          case "students":
            return Response.json({ ...envelope, kind: "students", students, next: null });
          case "usage":
            return Response.json({
              ...envelope,
              kind: "usage",
              uses,
              version: `sha256:${"c".repeat(64)}`,
            });
          case "generate":
            return Response.json({
              ...envelope,
              kind: "generate",
              content: `---\nname: ${input.slug}\ndescription: Generated practice\n---\n# Practice\nAsk for evidence.`,
            });
          case "delete":
            return Response.json({ ...envelope, kind: "delete" });
          case "apply":
            return Response.json({ ...envelope, kind: "applied" });
          case "assign": {
            students = students.map((student) =>
              input.students.some((item) => item.studentId === student.studentId)
                ? {
                    ...student,
                    version: input.selection === null ? null : "revision:assigned",
                    selection: input.selection,
                  }
                : student,
            );
            return Response.json({ ...envelope, kind: "assigned" });
          }
        }
      }
    }
  }
  const changed = vi.fn();
  const teachingChanged = vi.fn(() => Promise.resolve());
  const controller = new SkillWorkspaceController("class:one", request, changed, teachingChanged);
  return {
    controller,
    request,
    changed,
    teachingChanged,
    failures,
    get bundle() {
      return bundle;
    },
  };
}
