import { ActiveRunDashboardResponseSchema } from "@marea/protocol";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DashboardAppProperties } from "./dashboard-app.js";
import { createDocument, createRootRecorder, emptyResponse } from "./dashboard-root.fixture.js";
import { getDashboardMessages } from "./messages.js";
import { ActiveRunsModule } from "./modules/active-runs/active-runs-module.js";
import { createRunClosureClient } from "./modules/run-closure/run-closure-client.boundary.js";
import { startDashboard } from "./start-dashboard.js";

const run = {
  runId: "run:one",
  studentDisplayName: "Lin",
  classId: "class:computing",
  classDisplayName: "Computing",
  projectDisplayName: "Sea Garden",
  state: "active",
  startedAt: "2026-09-03T08:00:00.000Z",
  lastActivityAt: "2026-09-03T08:01:00.000Z",
  highestDurableSequence: 3,
  pendingApproval: true,
} as const;
const activeResponse = ActiveRunDashboardResponseSchema.parse({
  ...emptyResponse,
  runs: [run, { ...run, runId: "run:two", studentDisplayName: "Sam", pendingApproval: false }],
});

describe("ending sessions from the active runs view", () => {
  it("offers to end sessions per run and per class only when a closing client is composed", () => {
    const closure = {
      client: createRunClosureClient(vi.fn()),
      refresh: vi.fn(),
    };
    const html = (properties: object) =>
      renderToStaticMarkup(
        <ActiveRunsModule
          messages={getDashboardMessages("en")}
          locale="en"
          state={{ status: "ready", response: activeResponse }}
          {...properties}
        />,
      );
    const withClosing = html({ closure });
    expect(withClosing.match(/>End session</gu)).toHaveLength(2);
    expect(withClosing.match(/>End all sessions</gu)).toHaveLength(1);
    expect(withClosing).toContain("<strong>Computing</strong>");
    const without = html({});
    expect(without).not.toContain("End session");
    expect(without).not.toContain("End all sessions");
    const [first, second] = activeResponse.runs;
    if (first === undefined || second === undefined) throw new Error("Expected two runs");
    const twoClasses = ActiveRunDashboardResponseSchema.parse({
      ...activeResponse,
      runs: [first, { ...second, classId: "class:art", classDisplayName: "Art" }],
    });
    const grouped = renderToStaticMarkup(
      <ActiveRunsModule
        messages={getDashboardMessages("en")}
        locale="en"
        state={{ status: "ready", response: twoClasses }}
        closure={closure}
      />,
    );
    expect(grouped.match(/>End all sessions</gu)).toHaveLength(2);
    expect(grouped).toContain("<strong>Art</strong>");
  });
  it("reloads the active runs after sessions were ended, only when a closing client exists", async () => {
    const recorder = createRootRecorder();
    const closures = createRunClosureClient(vi.fn());
    const load = vi.fn().mockResolvedValue(emptyResponse);
    const handle = startDashboard(
      { document: createDocument({} as HTMLElement), language: "en" },
      { load, closures },
      () => recorder.root,
    );
    await handle.ready;
    const rendered = recorder.rendered.at(-1);
    if (!isValidElement<DashboardAppProperties>(rendered)) throw new Error("Missing dashboard app");
    expect(rendered.props.activeRunsClosure?.client).toBe(closures);
    expect(load).toHaveBeenCalledTimes(1);
    rendered.props.activeRunsClosure?.refresh();
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2);
    });
    handle.dispose();

    const plain = createRootRecorder();
    const unclosable = startDashboard(
      { document: createDocument({} as HTMLElement), language: "en" },
      { load: vi.fn().mockResolvedValue(emptyResponse) },
      () => plain.root,
    );
    await unclosable.ready;
    const app = plain.rendered.at(-1);
    if (!isValidElement<DashboardAppProperties>(app)) throw new Error("Missing dashboard app");
    expect(app.props.activeRunsClosure).toBeUndefined();
    unclosable.dispose();
  });
});
