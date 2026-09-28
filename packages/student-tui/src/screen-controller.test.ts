import { describe, expect, it, vi } from "vitest";

import type { StudentTuiSnapshot, StudentTuiView } from "./contracts.js";
import { createScreenController } from "./screen-controller.js";

function createView() {
  const snapshots: StudentTuiSnapshot[] = [];
  const dispose = vi.fn();
  const view: StudentTuiView = {
    dispose,
    render(snapshot): void {
      snapshots.push(snapshot);
    },
  };
  return { dispose, snapshots, view };
}

describe("createScreenController", () => {
  it("streams immutable snapshots and completes once", () => {
    const target = createView();
    const controller = createScreenController(target.view);

    expect(target.snapshots).toEqual([{ response: "", status: "ready" }]);
    expect(Object.isFrozen(target.snapshots[0])).toBe(true);
    expect(controller.appendText("")).toBe(false);
    expect(controller.appendText("Hel")).toBe(true);
    expect(controller.appendText("lo")).toBe(true);
    expect(controller.complete()).toBe(true);
    expect(controller.complete()).toBe(false);
    expect(controller.appendText("!")).toBe(false);
    expect(controller.cancel()).toBe(false);
    expect(controller.snapshot()).toEqual({ response: "Hello", status: "complete" });
    expect(controller.dispose()).toBe(true);
    expect(controller.dispose()).toBe(false);
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(target.snapshots).toEqual([
      { response: "", status: "ready" },
      { response: "Hel", status: "streaming" },
      { response: "Hello", status: "streaming" },
      { response: "Hello", status: "complete" },
    ]);
  });

  it("renders cancellation before disposal and never renders afterwards", () => {
    const target = createView();
    const controller = createScreenController(target.view);

    expect(controller.appendText("partial")).toBe(true);
    expect(controller.cancel()).toBe(true);
    expect(controller.cancel()).toBe(false);
    expect(controller.complete()).toBe(false);
    expect(controller.appendText("late")).toBe(false);
    expect(controller.snapshot()).toEqual({ response: "partial", status: "cancelled" });
    expect(target.snapshots).toHaveLength(3);
    expect(target.dispose).not.toHaveBeenCalled();
    expect(controller.dispose()).toBe(true);
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("rejects updates after direct disposal", () => {
    const target = createView();
    const controller = createScreenController(target.view);

    expect(controller.cancel()).toBe(false);
    expect(controller.dispose()).toBe(true);
    expect(controller.appendText("late")).toBe(false);
    expect(controller.complete()).toBe(false);
    expect(controller.snapshot()).toEqual({ response: "", status: "ready" });
    expect(target.snapshots).toHaveLength(1);
  });

  it("caps streamed response state at 64 KiB", () => {
    const target = createView();
    const controller = createScreenController(target.view);

    expect(controller.appendText("x".repeat(65_535))).toBe(true);
    expect(controller.appendText("yz")).toBe(true);
    expect(controller.appendText("late")).toBe(false);
    expect(controller.snapshot().response).toHaveLength(65_536);
    expect(controller.snapshot().response.endsWith("y")).toBe(true);
  });
});
