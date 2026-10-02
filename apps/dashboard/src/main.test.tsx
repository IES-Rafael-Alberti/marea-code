import * as bootstrap from "./start-dashboard.js";
import { subscribeSessionChanges } from "./modules/sessions/session-live.boundary.js";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, it, vi } from "vitest";
import { dashboardModuleLoaders } from "@marea/plugin-runtime/browser";

// Keep transitive module initialization outside the entry-point assertion test.
import "./modules/teaching/teaching-client.boundary.js";
import "./modules/teaching/teaching-controller.js";
import "./modules/governance/governance-client.boundary.js";
import "./modules/governance/governance-controller.js";
import "./modules/governance/governance-module.js";
import "./modules/usage-health-adapters.js";

const render = vi.fn<Root["render"]>();

vi.mock("react-dom/client", () => ({
  createRoot: vi.fn((): Root => ({
    render,
    unmount: vi.fn(),
  })),
}));

beforeAll(() => {
  vi.stubGlobal("document", {
    documentElement: { lang: "" },
    getElementById: vi.fn(() => ({})),
  });
  vi.stubGlobal("navigator", { language: "es-ES" });
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000000" });
  vi.stubGlobal("fetch", (input: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          input.endsWith("/session")
            ? {
                kind: "dashboard-session",
                protocolVersion: "0.1",
                requestId: "request:00000000-0000-4000-8000-000000000000",
                principal: { role: "teacher", displayName: "Ada" },
              }
            : input.endsWith("/teaching/classes")
              ? {
                  kind: "teaching-classes-response",
                  protocolVersion: "0.1",
                  requestId: "request:00000000-0000-4000-8000-000000000000",
                  classes: [{ classId: "class:physics", displayName: "Physics" }],
                  nextAfterClassId: null,
                }
              : {
                  kind: "active-runs-response",
                  protocolVersion: "0.1",
                  requestId: "request:00000000-0000-4000-8000-000000000000",
                  generatedAt: "2026-09-03T08:00:00.000Z",
                  viewer: { role: "teacher", displayName: "Ada" },
                  runs: [],
                  nextCursor: null,
                },
        ),
      ),
    ),
  );
});

it("starts from the browser entry point", async () => {
  const start = vi.spyOn(bootstrap, "startDashboard");
  await import("./main.js");
  expect(start.mock.calls[0]?.[9]).toMatchObject({ subscribe: subscribeSessionChanges });
  expect(typeof start.mock.calls[0]?.[9]?.history).toBe("function");
  expect(start.mock.calls[0]?.[10]).toEqual({
    fetch,
    sessions: start.mock.calls[0]?.[9],
    notices: start.mock.calls[0]?.[8],
    moduleAdapters: expect.any(Map) as ReadonlyMap<string, object>,
  });
  // Optional plugins are registered only while the generated catalog contains them.
  expect([...(start.mock.calls[0]?.[10]?.moduleAdapters?.keys() ?? [])]).toEqual(
    ["org.marea.module.usage", "org.marea.module.health"].filter((id) =>
      Object.hasOwn(dashboardModuleLoaders, id),
    ),
  );

  await vi.waitFor(() => {
    const html = renderToStaticMarkup(render.mock.lastCall?.[0]);
    expect(html).toContain("Edición de skills");
    expect(html.match(/Physics/gu)).toHaveLength(1);
  });
  expect(document.documentElement.lang).toBe("es");
  expect(renderToStaticMarkup(render.mock.lastCall?.[0])).toContain("Physics");
});
