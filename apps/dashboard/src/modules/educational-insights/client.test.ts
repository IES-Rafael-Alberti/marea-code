import { beforeEach, expect, it, vi } from "vitest";
import * as z from "zod";
import { EDUCATIONAL_INSIGHTS_PATH } from "@marea/protocol";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
let insightsClient: typeof import("./client.js").insightsClient;
beforeEach(async () => {
  vi.resetModules();
  ({ insightsClient } = await import("./client.js"));
});

it.each(["settings", "history"])(
  "checks the response kind before returning %s data",
  async (kind) => {
    const fetchRequest = vi.fn<DashboardFetch>().mockImplementation((_path, options) => {
      if (typeof options.body !== "string") throw new Error("Expected JSON request");
      const request = JSON.parse(options.body) as { requestId: string; classId: string };
      return Promise.resolve(Response.json({ ...request, kind, data: { revision: "v1" } }));
    });
    const result = insightsClient(fetchRequest)(
      "class:a",
      { kind: "settings" },
      z.object({ revision: z.string() }),
      new AbortController().signal,
    );
    if (kind === "settings") await expect(result).resolves.toEqual({ revision: "v1" });
    else await expect(result).rejects.toThrow("invalid-response");
    expect(fetchRequest.mock.lastCall?.[0]).toBe(EDUCATIONAL_INSIGHTS_PATH);
  },
);
