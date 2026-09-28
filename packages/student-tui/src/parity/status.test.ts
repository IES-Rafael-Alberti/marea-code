import { describe, expect, it } from "vitest";

import { INITIAL_STATUS, statusLine, type StatusState } from "./status.js";
import { PARITY_TEST_COPY } from "../../test-support/parity-copy.js";

function state(overrides: Partial<StatusState> = {}): StatusState {
  return { ...INITIAL_STATUS, ...overrides };
}

describe("status line", () => {
  it("starts with no tool named", () => {
    expect(INITIAL_STATUS).toEqual({
      activity: "starting",
      branch: "",
      elapsedMs: 0,
      hint: "turn",
      model: "",
      toolName: "",
    });
  });

  it("starts preparing the session, timing itself", () => {
    expect(statusLine(INITIAL_STATUS, PARITY_TEST_COPY)).toEqual({
      context: "",
      elapsed: "",
      hint: PARITY_TEST_COPY.hints.turn,
      label: PARITY_TEST_COPY.status.starting,
      running: true,
    });
  });

  it("counts whole seconds once the first has passed", () => {
    expect(statusLine(state({ elapsedMs: 999 }), PARITY_TEST_COPY).elapsed).toBe("");
    expect(statusLine(state({ elapsedMs: 1000 }), PARITY_TEST_COPY).elapsed).toBe("1s");
    expect(statusLine(state({ elapsedMs: 12_400 }), PARITY_TEST_COPY).elapsed).toBe("12s");
  });

  it("is still and untimed when the session is simply ready", () => {
    const line = statusLine(
      state({ activity: "ready", elapsedMs: null, hint: "ready" }),
      PARITY_TEST_COPY,
    );
    expect(line).toMatchObject({
      elapsed: "",
      hint: PARITY_TEST_COPY.hints.ready,
      label: PARITY_TEST_COPY.status.ready,
      running: false,
    });
  });

  it("shows a running tool under its own name", () => {
    expect(
      statusLine(state({ activity: "tool", toolName: "read_file" }), PARITY_TEST_COPY).label,
    ).toBe("read_file");
  });

  it("shows no hint after an unrecoverable error", () => {
    expect(
      statusLine(
        state({ activity: "unrecoverable", elapsedMs: null, hint: "none" }),
        PARITY_TEST_COPY,
      ),
    ).toMatchObject({ hint: "", label: PARITY_TEST_COPY.status.unrecoverable });
  });

  it("joins the context it has, and shows none when it has neither", () => {
    expect(statusLine(state({ branch: "main", model: "m" }), PARITY_TEST_COPY).context).toBe(
      "m · main",
    );
    expect(statusLine(state({ model: "m" }), PARITY_TEST_COPY).context).toBe("m");
    expect(statusLine(state({ branch: "main" }), PARITY_TEST_COPY).context).toBe("main");
    expect(statusLine(state(), PARITY_TEST_COPY).context).toBe("");
  });
});
