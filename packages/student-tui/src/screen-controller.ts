import type { StudentTuiSnapshot, StudentTuiView } from "./contracts.js";

export interface ScreenController {
  appendText(chunk: string): boolean;
  cancel(): boolean;
  complete(): boolean;
  dispose(): boolean;
  snapshot(): StudentTuiSnapshot;
}

const INITIAL_SNAPSHOT: StudentTuiSnapshot = Object.freeze({
  response: "",
  status: "ready",
});
const MAX_RESPONSE_LENGTH = 64 * 1024;

export function createScreenController(view: StudentTuiView): ScreenController {
  let active = true;
  let current = INITIAL_SNAPSHOT;

  const update = (snapshot: StudentTuiSnapshot): boolean => {
    if (!active) return false;
    current = Object.freeze(snapshot);
    view.render(current);
    return true;
  };

  const dispose = (): boolean => {
    if (!active) return false;
    active = false;
    view.dispose();
    return true;
  };

  view.render(current);

  return Object.freeze({
    appendText(chunk: string): boolean {
      if (chunk.length === 0 || current.status === "complete" || current.status === "cancelled")
        return false;
      const remaining = MAX_RESPONSE_LENGTH - current.response.length;
      if (remaining === 0) return false;
      return update({
        response: current.response + chunk.slice(0, remaining),
        status: "streaming",
      });
    },
    cancel(): boolean {
      if (current.status !== "streaming") return false;
      return update({ response: current.response, status: "cancelled" });
    },
    complete(): boolean {
      if (current.status === "complete" || current.status === "cancelled") return false;
      return update({ response: current.response, status: "complete" });
    },
    dispose,
    snapshot(): StudentTuiSnapshot {
      return current;
    },
  });
}
