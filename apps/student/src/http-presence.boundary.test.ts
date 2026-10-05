import { RunTokenSchema } from "@marea/protocol";
import { expect, it } from "vitest";
import { createHttpStudentServer } from "./http-client.boundary.js";

it("sends authenticated presence with a fresh correlated request identifier", async () => {
  const ids: string[] = [];
  const token = RunTokenSchema.parse("r".repeat(32));
  const server = createHttpStudentServer({
    baseUrl: "https://teacher.example",
    fetch: async (request) => {
      expect(request.url).toBe("https://teacher.example/v1/runs/presence");
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      const body = (await request.json()) as { requestId: string };
      expect(Object.keys(body)).toEqual(["requestId"]);
      expect(body.requestId).toMatch(/^presence:[0-9a-f-]{36}$/);
      ids.push(body.requestId);
      return Response.json(body);
    },
  });
  await server.heartbeat?.(token);
  await server.heartbeat?.(token);
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

it.each(["missing", "different", "extra"])("rejects a %s presence response", async (kind) => {
  const server = createHttpStudentServer({
    baseUrl: "https://teacher.example",
    fetch: async (request) => {
      const body = (await request.json()) as { requestId: string };
      if (kind === "missing") return Response.json({});
      if (kind === "different") return Response.json({ requestId: "presence:different" });
      return Response.json({ ...body, unexpected: true });
    },
  });
  await expect(server.heartbeat?.(RunTokenSchema.parse("r".repeat(32)))).rejects.toThrow();
});
