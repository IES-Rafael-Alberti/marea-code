import { describe, expect, it } from "vitest";

import { newerEntry, olderEntry, openHistory, rememberEntry } from "./history.js";

describe("input history", () => {
  it("starts on an empty draft with nothing recorded", () => {
    expect(openHistory()).toEqual({ draft: "", entries: [], index: -1 });
  });

  it("does nothing when there is nothing to recall", () => {
    const state = openHistory();
    const step = olderEntry(state, "borrador");
    expect(step).toEqual({ state, text: null });
    expect(step.state.draft).toBe("");
  });

  it("walks back through the entries, newest first", () => {
    let step = olderEntry(openHistory(["dos", "uno"]), "");
    expect(step.text).toBe("dos");
    step = olderEntry(step.state, "dos");
    expect(step.text).toBe("uno");
  });

  it("stops at the oldest entry", () => {
    const first = olderEntry(openHistory(["uno"]), "");
    const again = olderEntry(first.state, "uno");
    expect(again).toEqual({ state: first.state, text: null });
  });

  it("saves the draft on the first step and restores it on the way back", () => {
    const back = olderEntry(openHistory(["uno"]), "a medio escribir");
    expect(back.state.draft).toBe("a medio escribir");
    const forward = newerEntry(back.state);
    expect(forward.text).toBe("a medio escribir");
    expect(forward.state.index).toBe(-1);
  });

  it("keeps the first draft while walking deeper", () => {
    const first = olderEntry(openHistory(["dos", "uno"]), "borrador");
    const second = olderEntry(first.state, "dos");
    expect(second.state.draft).toBe("borrador");
    expect(newerEntry(second.state).text).toBe("dos");
  });

  it("does nothing going forward from the draft", () => {
    const state = openHistory(["uno"]);
    expect(newerEntry(state)).toEqual({ state, text: null });
  });

  it("stays on the draft when asked to go forward again", () => {
    const back = olderEntry(openHistory(["uno"]), "borrador");
    const front = newerEntry(back.state);
    expect(newerEntry(front.state)).toEqual({ state: front.state, text: null });
  });

  it("records a sent message as the newest entry and clears the draft", () => {
    const state = rememberEntry({ draft: "algo", entries: ["uno"], index: 0 }, "dos");
    expect(state).toEqual({ draft: "", entries: ["dos", "uno"], index: -1 });
  });
});
