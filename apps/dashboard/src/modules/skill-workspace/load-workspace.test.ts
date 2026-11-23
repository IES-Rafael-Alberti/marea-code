import { expect, it } from "vitest";
import { SkillWorkspaceRequestSchema } from "@marea/protocol";
import { loadSkillWorkspace } from "./load-workspace.js";
import { createSkillWorkspaceClient } from "./client.boundary.js";
it.each(["library", "students"])(
  "loads every page and rejects a repeated %s cursor",
  async (repeatingKind) => {
    const seen: string[] = [];
    let repeated = false;
    const client = createSkillWorkspaceClient((_path, init) => {
      const request = SkillWorkspaceRequestSchema.parse(
        JSON.parse(typeof init.body === "string" ? init.body : ""),
      );
      if (request.kind !== "library" && request.kind !== "students")
        throw new Error("unexpected request");
      seen.push(`${request.kind}:${request.after ?? "start"}`);
      if (seen.length > 15) throw new Error("runaway");
      const envelope = {
        protocolVersion: request.protocolVersion,
        requestId: request.requestId,
        classId: request.classId,
      };
      const next =
        request.after === null || (repeated && request.kind === repeatingKind)
          ? request.kind === "library"
            ? "marea/testing"
            : "student:ana"
          : null;
      return Promise.resolve(
        Response.json({
          ...envelope,
          kind: request.kind,
          next,
          ...(request.kind === "library" ? { skills: [] } : { students: [] }),
        }),
      );
    });
    await expect(
      loadSkillWorkspace(client, "class:one", new AbortController().signal),
    ).resolves.toEqual({ catalog: [], students: [] });
    expect(seen).toEqual([
      "library:start",
      "library:marea/testing",
      "students:start",
      "students:student:ana",
    ]);
    repeated = true;
    await expect(
      loadSkillWorkspace(client, "class:one", new AbortController().signal),
    ).rejects.toThrow("unavailable");
  },
);
