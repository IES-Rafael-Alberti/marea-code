import { expect, it, vi } from "vitest";
import { SkillWorkspaceRequestSchema, SKILL_WORKSPACE_PATH } from "@marea/protocol";
import { createSkillWorkspaceClient } from "./client.boundary.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
const signal = new AbortController().signal;
it("uses same-origin authenticated POST with a correlated, strictly validated reply", async () => {
  const fetch = vi.fn<DashboardFetch>((_path, init) => {
    const request = SkillWorkspaceRequestSchema.parse(
      JSON.parse(typeof init.body === "string" ? init.body : ""),
    );
    return Promise.resolve(
      Response.json({
        protocolVersion: request.protocolVersion,
        requestId: request.requestId,
        classId: request.classId,
        kind: "students",
        students: [],
        next: null,
      }),
    );
  });
  await expect(
    createSkillWorkspaceClient(fetch)("class:one", { kind: "students", after: null }, signal),
  ).resolves.toMatchObject({ kind: "students", students: [], next: null });
  expect(fetch).toHaveBeenCalledWith(
    SKILL_WORKSPACE_PATH,
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "content-type": "application/json" },
    }),
  );
});
it.each([
  [409, "conflict"],
  [403, "forbidden"],
  [401, "unavailable"],
  [500, "unavailable"],
] as const)("maps HTTP %s to a safe UI error", async (status, message) => {
  for (const body of ["private details", null])
    await expect(
      createSkillWorkspaceClient(() => Promise.resolve(new Response(body, { status })))(
        "class:one",
        { kind: "students", after: null },
        signal,
      ),
    ).rejects.toThrow(message);
});
it.each(["requestId", "classId", "kind", "schema"])("rejects a mismatched %s", async (field) => {
  const fetch: DashboardFetch = (_path, init) => {
    const request = SkillWorkspaceRequestSchema.parse(
      JSON.parse(typeof init.body === "string" ? init.body : ""),
    );
    const response = {
      protocolVersion: "0.1",
      requestId: request.requestId,
      classId: request.classId,
      kind: "students",
      students: [],
      next: null,
    };
    return Promise.resolve(
      Response.json(
        field === "schema"
          ? { ...response, extra: true }
          : field === "kind"
            ? {
                protocolVersion: "0.1",
                requestId: request.requestId,
                classId: request.classId,
                kind: "assigned",
              }
            : { ...response, [field]: "different" },
      ),
    );
  };
  await expect(
    createSkillWorkspaceClient(fetch)("class:one", { kind: "students", after: null }, signal),
  ).rejects.toThrow(field === "schema" ? undefined : "unavailable");
});
