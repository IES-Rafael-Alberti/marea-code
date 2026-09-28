import { MAX_SKILL_RESPONSE_BYTES, RunSkillRequestSchema, RunTokenSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { createHttpStudentServer, STUDENT_HTTP_PATHS } from "./http-client.boundary.js";

const token = RunTokenSchema.parse("r".repeat(32));
const request = RunSkillRequestSchema.parse({
  protocolVersion: "0.1",
  requestId: "request:skill",
  runId: "run:one",
  snapshotId: "snapshot:one",
  skillId: "marea/testing",
});

function payload() {
  return {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    runId: request.runId,
    snapshotId: request.snapshotId,
    skill: {
      id: request.skillId,
      name: "testing",
      description: "Synthetic teaching content",
      kind: "didactic",
      source: "marea",
      digest: `sha256:${"a".repeat(64)}`,
      license: null,
      compatibility: null,
      criteria: [],
      files: [{ path: "SKILL.md", content: "Learn.", sizeBytes: 6 }],
    },
  };
}

function json(value: object, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("run-scoped skill HTTP delivery", () => {
  it.each([undefined, "/custom/skill"])("sends a lease-scoped request at %s", async (path) => {
    const fetch = vi.fn((input: Request) => {
      expect(input.url).toBe(`https://school.example${path ?? STUDENT_HTTP_PATHS.readSkill}`);
      expect(input.method).toBe("POST");
      expect(input.redirect).toBe("error");
      expect(input.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(input.headers.get("content-type")).toBe("application/json");
      expect(input.headers.get("accept")).toBe("application/json");
      return Promise.resolve(json(payload()));
    });
    const { readSkill: omitted, ...legacyPaths } = STUDENT_HTTP_PATHS;
    expect(omitted).toBe("/v1/runs/skills/read");
    const server = createHttpStudentServer({
      baseUrl: "https://school.example",
      fetch,
      paths: path === undefined ? legacyPaths : { ...legacyPaths, readSkill: path },
    });
    expect(await server.readSkill(token, request)).toEqual(payload());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await fetch.mock.calls[0]?.[0].json()).toEqual(request);
  });

  it.each(["requestId", "runId", "snapshotId", "skillId", "evaluation", "size"])(
    "rejects a mismatched or private response: %s",
    async (field) => {
      const value = payload();
      if (field === "requestId")
        value.requestId = RunSkillRequestSchema.parse({
          ...request,
          requestId: "request:other",
        }).requestId;
      if (field === "runId")
        value.runId = RunSkillRequestSchema.parse({ ...request, runId: "run:other" }).runId;
      if (field === "snapshotId")
        value.snapshotId = RunSkillRequestSchema.parse({
          ...request,
          snapshotId: "snapshot:other",
        }).snapshotId;
      if (field === "skillId") {
        value.skill.id = RunSkillRequestSchema.parse({
          ...request,
          skillId: "marea/other",
        }).skillId;
        value.skill.name = "other";
      }
      if (field === "evaluation") value.skill.kind = "evaluation";
      if (field === "size") value.skill.files[0] = { path: "SKILL.md", content: "é", sizeBytes: 1 };
      const server = createHttpStudentServer({
        baseUrl: "https://school.example",
        fetch: () => Promise.resolve(json(value)),
      });
      await expect(server.readSkill(token, request)).rejects.toMatchObject({
        code: "response.invalid",
      });
    },
  );

  it("validates request scope before network I/O", () => {
    const fetch = vi.fn(() => Promise.resolve(json(payload())));
    const server = createHttpStudentServer({ baseUrl: "https://school.example", fetch });
    expect(() =>
      // @ts-expect-error Deliberately cross the transport boundary with an invalid version.
      server.readSkill(token, { ...request, protocolVersion: "invalid" }),
    ).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts valid UTF-8 bundles larger than the ordinary JSON limit", async () => {
    const value = payload();
    const content = "é".repeat(262_144);
    value.skill.files.push(
      ...[1, 2, 3].map((index) => ({
        path: `resources/part-${String(index)}.txt`,
        content,
        sizeBytes: 524_288,
      })),
    );
    const server = createHttpStudentServer({
      baseUrl: "https://school.example",
      fetch: () => Promise.resolve(json(value)),
    });
    expect(await server.readSkill(token, request)).toEqual(value);
  });

  it("rejects an oversized declared response", async () => {
    const server = createHttpStudentServer({
      baseUrl: "https://school.example",
      fetch: () =>
        Promise.resolve(
          json(payload(), { "content-length": String(MAX_SKILL_RESPONSE_BYTES + 1) }),
        ),
    });
    await expect(server.readSkill(token, request)).rejects.toMatchObject({
      code: "response.too-large",
    });
  });

  it("enforces the streamed byte limit even without a content length", async () => {
    const chunk = new Uint8Array(1_048_576).fill(32);
    let chunks = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 64) controller.enqueue(chunk);
        else {
          controller.enqueue(new Uint8Array([32]));
          controller.close();
        }
      },
      cancel,
    });
    const server = createHttpStudentServer({
      baseUrl: "https://school.example",
      fetch: () =>
        Promise.resolve(new Response(body, { headers: { "content-type": "application/json" } })),
    });
    await expect(server.readSkill(token, request)).rejects.toMatchObject({
      code: "response.too-large",
    });
    expect(chunks).toBe(65);
  });
});
