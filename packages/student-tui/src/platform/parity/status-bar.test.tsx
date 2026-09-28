import { describe, expect, it } from "vitest";

import { nodesOfType, renderedText } from "../../../test-support/element-tree.boundary.js";
import { PARITY_TEST_COPY } from "../../../test-support/parity-copy.js";
import { INITIAL_STATUS, type StatusState } from "../../parity/status.js";
import { PALETTE } from "../../parity/tokens.js";
import { StatusBar } from "./status-bar.js";

function bar(overrides: Partial<StatusState> = {}) {
  return StatusBar({ copy: PARITY_TEST_COPY, status: { ...INITIAL_STATUS, ...overrides } });
}

describe("status bar", () => {
  it("shows the activity in the accent colour while it is working", () => {
    const first = nodesOfType(bar({ elapsedMs: 4000 }), "span")[0];
    expect(first?.props).toMatchObject({ attributes: 1, fg: PALETTE.accent });
    expect(renderedText(bar({ elapsedMs: 4000 }))).toContain("preparando 4s");
  });

  it("dims a state that is not timed, and shows no counter", () => {
    const line = bar({ activity: "ready", elapsedMs: null, hint: "ready" });
    const first = nodesOfType(line, "span")[0];
    expect(first?.props).toMatchObject({ attributes: 0, fg: PALETTE.dimOnSurface });
    expect(renderedText(line)).not.toContain("s ");
  });

  it("hides the counter during the first second", () => {
    expect(renderedText(bar({ elapsedMs: 200 }))).toBe("preparando    Esc interrumpir");
  });

  it("appends the hint and the context, each after a gap", () => {
    const line = bar({
      activity: "ready",
      branch: "main",
      elapsedMs: null,
      hint: "ready",
      model: "m",
    });
    expect(renderedText(line)).toBe(`listo    ${PARITY_TEST_COPY.hints.ready}    m · main`);
  });

  it("shows nothing but the activity when there is no hint and no context", () => {
    expect(renderedText(bar({ activity: "ready", elapsedMs: null, hint: "none" }))).toBe("listo");
  });

  it("sits on the panel colour and keeps its single row", () => {
    const [box] = nodesOfType(bar(), "box");
    expect(box?.props).toMatchObject({ backgroundColor: PALETTE.surface, height: 1 });
  });
});
