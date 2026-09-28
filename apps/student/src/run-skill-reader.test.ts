import { createHash } from "node:crypto";

import {
  RequestIdSchema,
  RunSkillResponseSchema,
  RunTokenSchema,
  Sha256DigestSchema,
  SkillIdSchema,
  type RunSkillRequest,
} from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { runId, snapshot } from "./deepagents-runtime.fixture.js";
import { RunSkillReader, RunSkillReadError } from "./run-skill-reader.js";

const skillId = SkillIdSchema.parse("teacher/one/testing");
const token = RunTokenSchema.parse("r".repeat(32));
const content = "Teach café testing.\n";
const resource = "Small example.\n";
const digest = Sha256DigestSchema.parse(
  `sha256:${createHash("sha256")
    .update(`SKILL.md\0${content}\0resources/guide.txt\0${resource}\0`)
    .digest("hex")}`,
);

function fixture() {
  const captured = { ...snapshot(), didacticSkills: [{ id: skillId, digest }] };
  const readSkill = vi.fn((_token: typeof token, request: RunSkillRequest) =>
    Promise.resolve(
      RunSkillResponseSchema.parse({
        protocolVersion: request.protocolVersion,
        requestId: request.requestId,
        runId,
        snapshotId: captured.id,
        skill: {
          id: skillId,
          name: "testing",
          description: "A synthetic skill",
          kind: "didactic",
          source: "teacher",
          digest,
          license: null,
          compatibility: null,
          criteria: [],
          files: [
            { path: "SKILL.md", content, sizeBytes: new TextEncoder().encode(content).byteLength },
            { path: "resources/guide.txt", content: resource, sizeBytes: resource.length },
          ],
        },
      }),
    ),
  );
  const runToken = vi.fn(() => Promise.resolve(token));
  const options = {
    runId,
    snapshot: captured,
    server: { readSkill },
    runToken,
    nextRequestId: () => RequestIdSchema.parse("request:read-skill"),
  };
  return { captured, readSkill, runToken, options };
}

describe("immutable run skill reader", () => {
  it("verifies canonical bytes and delivers only the exact requested file", async () => {
    const test = fixture();
    const reader = new RunSkillReader(test.options);
    expect(await reader.read(skillId, "SKILL.md")).toBe(content);
    expect(await reader.read(skillId, "resources/guide.txt")).toBe(resource);
    expect(test.runToken).toHaveBeenCalledTimes(2);
    expect(test.readSkill).toHaveBeenCalledWith(token, {
      protocolVersion: "0.1",
      requestId: "request:read-skill",
      runId,
      snapshotId: test.captured.id,
      skillId,
    });
    await expect(reader.read(skillId, "resources/missing.txt")).rejects.toBeInstanceOf(
      RunSkillReadError,
    );
    expect(new RunSkillReadError().name).toBe("RunSkillReadError");
    expect(new RunSkillReadError().message).toBe(
      "The requested teaching resource is not available in this run snapshot.",
    );
  });

  it.each(["../SKILL.md", "/SKILL.md", "resources/../secret.txt", "resources/run.js"])(
    "rejects unsafe path %s before obtaining authority",
    async (path) => {
      const test = fixture();
      await expect(new RunSkillReader(test.options).read(skillId, path)).rejects.toBeInstanceOf(
        RunSkillReadError,
      );
      expect(test.runToken).not.toHaveBeenCalled();
      expect(test.readSkill).not.toHaveBeenCalled();
    },
  );

  it("rejects unselected skills and all didactic delivery in free mode", async () => {
    const test = fixture();
    await expect(
      new RunSkillReader(test.options).read("marea/other", "SKILL.md"),
    ).rejects.toBeInstanceOf(RunSkillReadError);
    const free = new RunSkillReader({
      ...test.options,
      snapshot: { ...test.captured, agentMode: "free" },
    });
    await expect(free.read(skillId, "SKILL.md")).rejects.toBeInstanceOf(RunSkillReadError);
    expect(test.readSkill).not.toHaveBeenCalled();
  });

  it("captures authority instead of following caller edits", async () => {
    const test = fixture();
    const reader = new RunSkillReader(test.options);
    test.captured.didacticSkills[0] = {
      id: skillId,
      digest: Sha256DigestSchema.parse(`sha256:${"b".repeat(64)}`),
    };
    test.captured.didacticSkills.push({ id: SkillIdSchema.parse("marea/new"), digest });
    expect(await reader.read(skillId, "SKILL.md")).toBe(content);
    await expect(reader.read("marea/new", "SKILL.md")).rejects.toBeInstanceOf(RunSkillReadError);
  });

  it.each(["requestId", "runId", "snapshotId", "skillId", "digest", "bytes", "order"])(
    "rejects substituted response %s even with a custom transport",
    async (field) => {
      const test = fixture();
      const original = test.readSkill.getMockImplementation();
      if (original === undefined) throw new Error("Missing fixture implementation");
      test.readSkill.mockImplementation(async (lease, request) => {
        const response = await original(lease, request);
        if (field === "skillId")
          return RunSkillResponseSchema.parse({
            ...response,
            skill: { ...response.skill, id: "teacher/two/testing" },
          });
        if (field === "digest")
          return RunSkillResponseSchema.parse({
            ...response,
            skill: { ...response.skill, digest: `sha256:${"b".repeat(64)}` },
          });
        if (field === "bytes")
          return RunSkillResponseSchema.parse({
            ...response,
            skill: {
              ...response.skill,
              files: [{ path: "SKILL.md", content: "Tampered", sizeBytes: 8 }],
            },
          });
        if (field === "order")
          return RunSkillResponseSchema.parse({
            ...response,
            skill: { ...response.skill, files: [...response.skill.files].reverse() },
          });
        return RunSkillResponseSchema.parse({ ...response, [field]: "other:value" });
      });
      await expect(
        new RunSkillReader(test.options).read(skillId, "SKILL.md"),
      ).rejects.toBeInstanceOf(RunSkillReadError);
    },
  );
});
