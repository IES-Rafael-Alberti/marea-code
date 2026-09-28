import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { StudentTuiSnapshot } from "../contracts.js";
import { createOpenTuiView } from "./opentui-view.js";

describe("createOpenTuiView", () => {
  it("keeps React and host details behind a Marea view", async () => {
    const nodes: ReactNode[] = [];
    const dispose = vi.fn();
    const host = {
      dispose,
      render(node: ReactNode): void {
        nodes.push(node);
      },
    };
    const createHost = vi.fn(() => Promise.resolve(host));
    const view = await createOpenTuiView(
      {
        controls: "keys",
        emptyResponse: "empty",
        errors: { nonInteractive: "n", rendererFailed: "r", unexpected: "u" },
        statuses: { cancelled: "x", complete: "d", ready: "r", streaming: "s" },
        title: "title",
      },
      vi.fn(),
      createHost,
    );
    const snapshot: StudentTuiSnapshot = { response: "stream", status: "streaming" };

    view.render(snapshot);
    view.dispose();

    expect(createHost).toHaveBeenCalledOnce();
    expect(nodes).toHaveLength(1);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
